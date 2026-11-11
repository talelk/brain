import { describe, expect, it } from "vitest";
import { ownBundleJob } from "../support/evidence";
import type { ActorContext, CommandReceipt, Mission, MissionBrief, PlanTask, PlanVersion, WorkItem } from "@brain/contracts";
import { goldenDocs, setupWorld, workView } from "../helpers";
import { achievedMission } from "../support/reuse";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const fails = async (fn: () => Promise<unknown>, pattern: RegExp) => await expect(Promise.resolve().then(fn)).rejects.toThrow(pattern);
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const brief = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.brief", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: MissionBrief }).snapshot;
const plan = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "plans.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: PlanVersion }).snapshot;
const task = (id: string, dependsOn: string[] = [], extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn, ...extra });
const coordinator = (w: World): ActorContext => ({ ...w.owner, kind: "agent" });

async function confirmedMission(w: World, key: string, tasks: PlanTask[], autonomy?: string): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], constraints: ["No production writes"], ...(autonomy ? { autonomy } : {}) })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  return id;
}

describe("missions (T51)", () => {
  it("starts active with brief v1, the standard autonomy preset and its constraints", async () => {
    const w = setupWorld();
    const id = (await run(w, w.owner, "mission.create", "m-create", { title: "Stabilize auth", intent: "Fix session expiry", successCriteria: ["sessions survive"], constraints: ["Keep the public API"] })).resourceId ?? "";
    const created = await mission(w, id);
    expect(created).toMatchObject({ state: "active", briefVersion: 1, autonomyPolicy: { preset: "standard", version: 1 } });
    expect(await brief(w, id)).toMatchObject({ version: 1, intent: "Fix session expiry", constraints: ["Keep the public API"], decisions: [], progress: { total: 0 } });
    w.brain.close();
  });

  it("stale expected versions conflict without overwriting (E009)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-stale", [task("a")]);
    const current = await mission(w, id);
    await run(w, w.owner, "mission.pause", "m-stale-pause", { missionId: id }, current.version);
    await fails(async () => await run(w, w.owner, "mission.resume", "m-stale-resume", { missionId: id }, current.version), /version|stale|conflict/i);
    expect((await mission(w, id)).state).toBe("paused");
    w.brain.close();
  });

  it("follows the lifecycle: paused and verifying missions start no work; closed is terminal", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-life", [task("a"), task("b")]);
    const [first] = (await workView(w)).items;
    await run(w, w.owner, "mission.pause", "m-life-pause", { missionId: id }, (await mission(w, id)).version);
    expect(await mission(w, id)).toMatchObject({ state: "paused", pauseReason: "human" });
    expect(() => w.brain.missions.linkExecution(w.owner, w.workspaceId, first!.workItemId, "run-paused")).toThrow(/paused mission starts no new work/);
    await run(w, w.owner, "mission.resume", "m-life-resume", { missionId: id }, (await mission(w, id)).version);
    w.brain.missions.linkExecution(w.owner, w.workspaceId, first!.workItemId, "run-active");
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE mission_id=?").run(`sha256:${"7".repeat(64)}`, id);
    await run(w, coordinator(w), "mission.proposeCompletion", "m-life-verify", { missionId: id }, (await mission(w, id)).version);
    expect((await mission(w, id)).state).toBe("verifying");
    await fails(async () => await run(w, w.owner, "mission.close", "m-life-achieved", { missionId: id, outcome: "achieved" }, (await mission(w, id)).version), /verified mission verdict/);
    w.brain.missions.returnToActive(w.owner, w.workspaceId, id);
    expect((await mission(w, id)).state).toBe("active");
    await run(w, w.owner, "mission.close", "m-life-cancel", { missionId: id, outcome: "cancelled" }, (await mission(w, id)).version);
    expect(await mission(w, id)).toMatchObject({ state: "closed", outcome: "cancelled" });
    expect((await workView(w)).items.every((item) => item.state === "done")).toBe(true);
    await fails(async () => await run(w, w.owner, "mission.brief.edit", "m-life-edit", { missionId: id, baseVersion: 1, intent: "Again" }), /terminal/);
    w.brain.close();
  });

  it("humans own intent and constraints; a stale human edit is rebased, never lost (E117)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-brief", [task("a")]);
    await fails(async () => await run(w, coordinator(w), "mission.brief.edit", "m-brief-agent", { missionId: id, baseVersion: 1, intent: "Agent intent" }), /only humans|cannot run/);
    await run(w, coordinator(w), "decision.accept", "m-brief-dec", { missionId: id, baseVersion: 1, statement: "Use Postgres for sessions", source: { kind: "handoff", ref: "handoff-1" } });
    await run(w, w.owner, "mission.brief.edit", "m-brief-human", { missionId: id, baseVersion: 1, constraints: ["No production writes", "Stay within EU regions"] });
    const after = await brief(w, id);
    expect(after.version).toBe(3);
    expect(after.constraints).toEqual(["No production writes", "Stay within EU regions"]);
    expect(after.decisions.map((entry) => entry.statement)).toEqual(["Use Postgres for sessions"]);
    // Version history, newest first, keeps every version's intent and constraints.
    expect((after as unknown as { history: Array<{ version: number; change: string; constraints: string[] }> }).history.map((entry) => [entry.version, entry.change])).toEqual([[3, "edited"], [2, "decision"], [1, "created"]]);
    await fails(async () => await run(w, coordinator(w), "decision.accept", "m-brief-stale", { missionId: id, baseVersion: 2, statement: "Use Redis", source: { kind: "handoff" } }), /brief changed since version 2/);
    await fails(async () => await run(w, w.owner, "mission.brief.edit", "m-brief-cap", { missionId: id, baseVersion: 3, intent: "x".repeat(8000) }), /condense/);
    w.brain.close();
  });

  it("accepted decisions are immutable and superseded by later entries", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-dec", [task("a")]);
    const first = (await run(w, w.owner, "decision.accept", "m-dec-1", { missionId: id, baseVersion: 1, statement: "Ship behind a flag", source: { kind: "human" } })).resourceId ?? "";
    await run(w, w.owner, "decision.accept", "m-dec-2", { missionId: id, baseVersion: 2, statement: "Ship to 10% first", source: { kind: "human" }, supersedes: first });
    const decisions = (await brief(w, id)).decisions;
    expect(decisions).toEqual([expect.objectContaining({ decisionId: first, statement: "Ship behind a flag", supersededBy: expect.any(String) }), expect.objectContaining({ statement: "Ship to 10% first" })]);
    await fails(async () => await run(w, w.owner, "decision.accept", "m-dec-3", { missionId: id, baseVersion: 3, statement: "Again", source: { kind: "human" }, supersedes: first }), /active decision/);
    w.brain.close();
  });

  it("a coordinator plan version inside the autonomy policy confirms itself; beyond it stays a proposal (E113)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-gate", [task("a"), task("b", ["a"]), task("c")]);
    const added = (await run(w, coordinator(w), "plan.propose", "m-gate-add", { missionId: id, origin: "agent", tasks: [task("a"), task("b", ["a"]), task("c"), task("d", ["a"])] })).resourceId ?? "";
    expect((await plan(w, added)).state).toBe("confirmed");
    expect((await workView(w)).items.map((item) => item.planTaskId).sort()).toEqual(["a", "b", "c", "d"]);
    const dropped = (await run(w, coordinator(w), "plan.propose", "m-gate-drop", { missionId: id, origin: "agent", tasks: [task("a"), task("b", ["a"]), task("d", ["a"])] })).resourceId ?? "";
    expect((await plan(w, dropped)).state).toBe("proposed");
    await fails(async () => await run(w, coordinator(w), "plan.confirm", "m-gate-self", { planVersionId: dropped }, (await mission(w, id)).version), /human|actor/i);
    await fails(async () => await run(w, coordinator(w), "mission.policy.set", "m-gate-widen", { missionId: id, preset: "autonomous" }, (await mission(w, id)).version), /human|cannot run/i);
    await run(w, w.owner, "plan.confirm", "m-gate-human", { planVersionId: dropped }, (await mission(w, id)).version);
    expect((await plan(w, dropped)).state).toBe("confirmed");
    w.brain.close();
  });

  it("no plan version may change started work, and confirming keeps it running (E114)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-started", [task("a"), task("b")]);
    const a = (await workView(w)).items.find((item) => item.planTaskId === "a") as WorkItem;
    w.brain.missions.linkExecution(w.owner, w.workspaceId, a.workItemId, "run-a");
    await fails(async () => await run(w, w.owner, "plan.propose", "m-started-change", { missionId: id, origin: "manual", tasks: [task("a", [], { title: "Task a, revised" }), task("b")] }), /started work: a/);
    await fails(async () => await run(w, coordinator(w), "plan.propose", "m-started-drop", { missionId: id, origin: "agent", tasks: [task("b")] }), /started work: a/);
    const next = (await run(w, w.owner, "plan.propose", "m-started-ok", { missionId: id, origin: "manual", tasks: [task("a"), task("b", [], { title: "Task b, revised" })] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "m-started-reconfirm", { planVersionId: next }, (await mission(w, id)).version);
    const items = (await workView(w)).items;
    expect(items.find((item) => item.workItemId === a.workItemId)?.state).toBe("in-progress");
    expect(items.find((item) => item.planTaskId === "b")?.title).toBe("Task b, revised");
    w.brain.close();
  });

  it("parks work after three consecutive failed attempts across members; only a human unparks (E115)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-park", [task("a", [], { assignment: { kind: "agent", id: "pi", role: "specialist" } }), task("b")]);
    const item = () => workView(w).then((view) => view.items.find((entry) => entry.planTaskId === "a") as WorkItem);
    w.brain.missions.linkExecution(w.owner, w.workspaceId, (await item()).workItemId, "run-1");
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "run-1", "tests failed: auth.spec");
    expect(await item()).toMatchObject({ state: "ready", failedAttempts: 1, parked: false });
    const reassigned = (await run(w, w.owner, "plan.propose", "m-park-reassign", { missionId: id, origin: "manual", tasks: [task("a", [], { assignment: { kind: "agent", id: "claude", role: "specialist" } }), task("b")] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "m-park-reconfirm", { planVersionId: reassigned }, (await mission(w, id)).version);
    expect((await item()).failedAttempts).toBe(1);
    for (const runId of ["run-2", "run-3"]) {
      w.brain.missions.linkExecution(w.owner, w.workspaceId, (await item()).workItemId, runId);
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, `tests failed in ${runId}`);
    }
    const parked = await item();
    expect(parked).toMatchObject({ state: "blocked", parked: true, failedAttempts: 3 });
    expect((await workView(w)).items.find((entry) => entry.planTaskId === "b")?.state).toBe("ready");
    expect((await mission(w, id)).state).toBe("active");
    await fails(async () => await run(w, coordinator(w), "workItem.transition", "m-park-agent", { workItemId: parked.workItemId, state: "ready" }, parked.version), /only a human unparks/);
    await run(w, w.owner, "workItem.transition", "m-park-retry", { workItemId: parked.workItemId, state: "ready" }, parked.version);
    expect(await item()).toMatchObject({ state: "ready", parked: false, failedAttempts: 0 });
    w.brain.close();
  });

  it("plan versions carry the mission team; members must be eligible and new roles need a human (T51)", async () => {
    const w = setupWorld();
    const agent = (id: string) => ({ path: `config/${id}.yaml`, text: `apiVersion: brain.keyrus/v1\nkind: Agent\nmetadata:\n  id: ${id}\n  version: 1.0.0\nspec:\n  instructionsPath: agents/${id}.md\n  tools: []\n  engine:\n    anyOf: [pi]\n    features: [start, events, cancel]\n  maxTurns: 5\n  maxChildren: 0\n  maxDepth: 0\n  maxTokens: 1000\n  maxMicroUsd: 0\n` });
    const release = w.brain.stageRelease(w.owner, [...goldenDocs(), agent("builder"), agent("reviewer")], "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4", [], [{ agentId: "builder", path: "agents/builder.md", text: "# Builder\n" }, { agentId: "reviewer", path: "agents/reviewer.md", text: "# Reviewer\n" }]);
    w.brain.activateRelease(w.owner, release.digest);
    const team = [{ memberId: "backend", role: "Backend engineer", agentId: "builder", engine: "pi" }];
    const id = (await run(w, w.owner, "mission.create", "m-team-create", { title: "Team mission", intent: "Build with a team", successCriteria: ["built"] })).resourceId ?? "";
    await fails(async () => await run(w, w.owner, "plan.propose", "m-team-bad", { missionId: id, origin: "manual", team: [{ ...team[0], engine: "claude" }], tasks: [task("a")] }), /does not run on engine claude/);
    await fails(async () => await run(w, w.owner, "plan.propose", "m-team-tools", { missionId: id, origin: "manual", team, tasks: [task("a", [], { assignment: { kind: "agent", id: "backend", role: "specialist" }, requiredTools: ["repo.write"] })] }), /missing tools/);
    const first = (await run(w, w.owner, "plan.propose", "m-team-plan", { missionId: id, origin: "manual", team, tasks: [task("a", [], { assignment: { kind: "agent", id: "backend", role: "specialist" } })] })).resourceId ?? "";
    expect((await plan(w, first)).team).toEqual(team);
    await run(w, w.owner, "plan.confirm", "m-team-confirm", { planVersionId: first }, (await mission(w, id)).version);
    const more = [...team, { memberId: "backend-2", role: "Backend engineer", agentId: "builder", engine: "pi" }];
    const grown = (await run(w, coordinator(w), "plan.propose", "m-team-grow", { missionId: id, origin: "agent", team: more, tasks: [task("a", [], { assignment: { kind: "agent", id: "backend", role: "specialist" } })] })).resourceId ?? "";
    expect((await plan(w, grown)).state).toBe("confirmed");
    const newRole = (await run(w, coordinator(w), "plan.propose", "m-team-role", { missionId: id, origin: "agent", team: [...more, { memberId: "qa", role: "Reviewer", agentId: "reviewer", engine: "pi" }], tasks: [task("a", [], { assignment: { kind: "agent", id: "backend", role: "specialist" } })] })).resourceId ?? "";
    expect((await plan(w, newRole)).state).toBe("proposed");
    w.brain.close();
  });

  it("inputs pin verified final output versions at admission; drafts never spread (E121)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-out", [task("spec", [], { outputs: ["api-spec"] }), task("build", ["spec"], { inputs: [{ output: "api-spec" }] })]);
    const items = async () => (await workView(w)).items;
    const spec = (await items()).find((item) => item.planTaskId === "spec") as WorkItem;
    w.brain.missions.linkExecution(w.owner, w.workspaceId, spec.workItemId, "run-spec");
    const draft = w.brain.missions.recordOutput(w.org, w.workspaceId, { workItemId: spec.workItemId, name: "api-spec", artifactDigest: `sha256:${"1".repeat(64)}`, state: "draft" });
    expect(() => w.brain.missions.recordOutput(w.org, w.workspaceId, { workItemId: spec.workItemId, name: "undeclared", artifactDigest: `sha256:${"1".repeat(64)}`, state: "final" })).toThrow(/declares no output/);
    w.brain.missions.recordOutput(w.org, w.workspaceId, { workItemId: spec.workItemId, name: "api-spec", artifactDigest: `sha256:${"2".repeat(64)}`, state: "final" });
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const digest = `sha256:${"e".repeat(64)}`;
    ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?,'verified',?,?)")
      .run(digest, "bundle-out", "job-out", "att-out", JSON.stringify({ checks: [{ criterionId: "spec-done", checkId: "c1", status: "passed" }] }), w.brain.store.now());
    ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES ('verdict-out',?,'eval-out',?,'verified','{}',?)").run(digest, digest, w.brain.store.now());
    const inProgress = (await items()).find((item) => item.planTaskId === "spec") as WorkItem;
    await run(w, w.owner, "workItem.transition", "m-out-review", { workItemId: spec.workItemId, state: "review" }, inProgress.version);
    const reviewing = (await items()).find((item) => item.planTaskId === "spec") as WorkItem;
    ownBundleJob(w.brain.store.workspaceDb(w.workspaceId, w.org), spec.workItemId, "job-out", w.brain.store.now());
    await run(w, coordinator(w), "handoff.submit", "m-out-handoff", { workItemId: spec.workItemId, notes: { summary: "The API spec is final." } });
    await run(w, w.owner, "workItem.transition", "m-out-done", { workItemId: spec.workItemId, state: "done", evidenceDigest: digest }, reviewing.version);
    const outputs = ((await w.brain.executeQuery(w.owner, { queryType: "missionOutputs.list", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: { items: Array<{ name: string; versions: Array<{ versionId: string; state: string; verified: boolean }> }> } }).snapshot.items;
    expect(outputs).toEqual([expect.objectContaining({ name: "api-spec", versions: [expect.objectContaining({ versionId: draft, state: "draft", verified: false }), expect.objectContaining({ state: "final", verified: true })] })]);
    const build = (await items()).find((item) => item.planTaskId === "build") as WorkItem;
    expect(build.state).toBe("ready");
    w.brain.missions.linkExecution(w.owner, w.workspaceId, build.workItemId, "run-build");
    expect(ws.prepare("SELECT artifact_digest FROM work_item_inputs WHERE work_item_id=?").all(build.workItemId)).toEqual([{ artifact_digest: `sha256:${"2".repeat(64)}` }]);
    const pinned = (await run(w, w.owner, "mission.create", "m-out-follow", { title: "Follow-up", intent: "Reuse the spec", successCriteria: ["reused"] })).resourceId ?? "";
    const followPlan = (await run(w, w.owner, "plan.propose", "m-out-follow-plan", { missionId: pinned, origin: "manual", tasks: [task("use", [], { inputs: [{ output: "api-spec", missionId: id, versionId: draft }] })] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "m-out-follow-confirm", { planVersionId: followPlan }, (await mission(w, pinned)).version);
    const use = (await items()).find((item) => item.planTaskId === "use") as WorkItem;
    expect(() => w.brain.missions.linkExecution(w.owner, w.workspaceId, use.workItemId, "run-use")).toThrow(/pinned to a draft version/);
    w.brain.close();
  });

  it("a named output shows its versions' artifacts and its lineage across missions (T61)", async () => {
    const w = setupWorld();
    const first = await confirmedMission(w, "m-line-a", [task("draft", [], { outputs: ["report"] })]);
    const second = await confirmedMission(w, "m-line-b", [task("revise", [], { outputs: ["report"] })]);
    const items = (await workView(w)).items;
    const draft = items.find((item) => item.planTaskId === "draft") as WorkItem;
    const revise = items.find((item) => item.planTaskId === "revise") as WorkItem;
    const digest = `sha256:${"a".repeat(64)}`;
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES ('art-line',?,12,'text/markdown','internal','verified',?)").run(digest, w.brain.store.now());
    const version = w.brain.missions.recordOutput(w.org, w.workspaceId, { workItemId: draft.workItemId, name: "report", artifactDigest: digest, state: "draft" });
    w.brain.missions.recordOutput(w.org, w.workspaceId, { workItemId: revise.workItemId, name: "report", artifactDigest: `sha256:${"b".repeat(64)}`, state: "draft", continues: { missionId: first, name: "report" } });
    const list = async (missionId: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missionOutputs.list", workspaceId: w.workspaceId, resourceId: missionId })) as { snapshot: { items: Array<{ outputId: string }> } }).snapshot.items[0]!.outputId;
    const original = await list(first);
    const followUp = await list(second);
    const get = async (outputId: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missionOutputs.get", workspaceId: w.workspaceId, resourceId: outputId })) as { snapshot: Record<string, unknown> }).snapshot;
    expect(await get(original)).toEqual(expect.objectContaining({
      missionTitle: "m-line-a", continuedBy: [{ outputId: followUp, missionId: second, name: "report" }],
      artifacts: [{ versionId: version, artifact: { artifactId: "art-line", digest, bytes: 12, mediaType: "text/markdown", classification: "internal" } }],
    }));
    const next = await get(followUp);
    expect(next["continues"]).toEqual({ outputId: original, missionId: first, name: "report" });
    expect(next["artifacts"]).toEqual([]);
    await expect(get("output-missing")).rejects.toThrow(/output not found/);
    w.brain.close();
  });

  it("a person rejects a plan proposal with a reason; it leaves attention and cannot be confirmed (T64)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-reject", [task("a")]);
    const proposal = (await run(w, w.owner, "plan.propose", "m-rejected-prop", { missionId: id, origin: "manual", tasks: [task("a"), task("b", ["a"])] })).resourceId ?? "";
    expect((await plan(w, proposal)).state).toBe("proposed");
    await fails(async () => await run(w, coordinator(w), "plan.reject", "m-rejected-agent", { planVersionId: proposal, reason: "No" }), /only a person|cannot run/);
    await run(w, w.owner, "plan.reject", "m-rejected-human", { planVersionId: proposal, reason: "Task b duplicates existing work" });
    expect((await plan(w, proposal)).state).toBe("rejected");
    await fails(async () => await run(w, w.owner, "plan.confirm", "m-rejected-confirm", { planVersionId: proposal }, (await mission(w, id)).version), /only a proposed plan version/);
    await fails(async () => await run(w, w.owner, "plan.reject", "m-rejected-again", { planVersionId: proposal, reason: "Again" }), /only a proposed plan version/);
    const attention = ((await w.brain.executeQuery(w.owner, { queryType: "attention.list", workspaceId: w.workspaceId })) as { snapshot: { items: Array<{ kind: string; resourceId: string }> } }).snapshot.items;
    expect(attention.some((item) => item.kind === "plan-proposal" && item.resourceId === proposal)).toBe(false);
    w.brain.close();
  });

  it("mission messages are durable records for the mission or one team member, and carry no authority (T51)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-msg", [task("a")]);
    const first = (await run(w, w.owner, "mission.message.send", "m-msg-1", { missionId: id, recipient: { kind: "mission" }, body: "Prioritise the login flow" })).resourceId ?? "";
    await fails(async () => await run(w, w.owner, "mission.message.send", "m-msg-2", { missionId: id, recipient: { kind: "member", memberId: "nobody" }, body: "Hi" }), /not on the mission team/);
    await run(w, w.owner, "mission.message.send", "m-msg-3", { missionId: id, recipient: { kind: "mission" }, body: "Prioritise the signup flow", correctionOf: first });
    const messages = ((await w.brain.executeQuery(w.owner, { queryType: "missionMessages.list", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: { items: Array<{ body: string; delivery: string }> } }).snapshot.items;
    expect(messages.map((entry) => [entry.body, entry.delivery])).toEqual([["Prioritise the signup flow", "pending"], ["Prioritise the login flow", "superseded"]]);
    expect((await mission(w, id)).state).toBe("active");
    w.brain.close();
  });

  it("work others depend on needs a structurally valid handoff; dependents get direct-dependency handoffs only (E116)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-hand", [task("a", [], { outputs: ["notes"] }), task("b", ["a"]), task("c", ["b"])]);
    const items = async () => (await workView(w)).items;
    const a = (await items()).find((item) => item.planTaskId === "a") as WorkItem;
    w.brain.missions.linkExecution(w.owner, w.workspaceId, a.workItemId, "run-a");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const digest = `sha256:${"f".repeat(64)}`;
    ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?,'verified',?,?)")
      .run(digest, "bundle-hand", "job-hand", "att-hand", JSON.stringify({ sourceRevision: "rev-1", checks: [{ criterionId: "a-done", checkId: "c1", status: "passed" }] }), w.brain.store.now());
    ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES ('verdict-hand',?,'eval-hand',?,'verified','{}',?)").run(digest, digest, w.brain.store.now());
    ownBundleJob(w.brain.store.workspaceDb(w.workspaceId, w.org), a.workItemId, "job-hand", w.brain.store.now());
    const toReview = (await items()).find((item) => item.planTaskId === "a") as WorkItem;
    await run(w, w.owner, "workItem.transition", "m-hand-review", { workItemId: a.workItemId, state: "review" }, toReview.version);
    const reviewing = (await items()).find((item) => item.planTaskId === "a") as WorkItem;
    await fails(async () => await run(w, w.owner, "workItem.transition", "m-hand-done-1", { workItemId: a.workItemId, state: "done", evidenceDigest: digest }, reviewing.version), /needs a handoff/);
    await run(w, coordinator(w), "handoff.submit", "m-hand-bad", { workItemId: a.workItemId, notes: { summary: "Claims an output it never made", referencedOutputs: ["outver-missing"] } });
    await fails(async () => await run(w, w.owner, "workItem.transition", "m-hand-done-2", { workItemId: a.workItemId, state: "done", evidenceDigest: digest }, reviewing.version), /did not produce as final/);
    await run(w, coordinator(w), "handoff.submit", "m-hand-good", { workItemId: a.workItemId, notes: { summary: "Session store moved to Postgres", openQuestions: ["Keep the Redis fallback?"], nextAction: "Wire the login flow" } });
    await run(w, w.owner, "workItem.transition", "m-hand-done-3", { workItemId: a.workItemId, state: "done", evidenceDigest: digest }, reviewing.version);
    const b = (await items()).find((item) => item.planTaskId === "b") as WorkItem;
    const c = (await items()).find((item) => item.planTaskId === "c") as WorkItem;
    const received = ((await w.brain.executeQuery(w.owner, { queryType: "handoffs.forWorkItem", workspaceId: w.workspaceId, resourceId: b.workItemId })) as { snapshot: { items: Array<{ version: number; notes: { summary: string }; facts: { evidenceDigest: string; sourceRevision: string; criteria: unknown[] } }> } }).snapshot.items;
    expect(received).toEqual([expect.objectContaining({ version: 2, notes: expect.objectContaining({ summary: "Session store moved to Postgres" }), facts: expect.objectContaining({ evidenceDigest: digest, sourceRevision: "rev-1", criteria: [{ criterionId: "a-done", status: "passed" }] }) })]);
    expect(((await w.brain.executeQuery(w.owner, { queryType: "handoffs.forWorkItem", workspaceId: w.workspaceId, resourceId: c.workItemId })) as { snapshot: { items: unknown[] } }).snapshot.items).toEqual([]);
    void id;
    w.brain.close();
  });

  it("completion is judged on a mission evidence bundle; achieved needs its verified verdict (T62)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-verdict", [task("a")]);
    const a = (await workView(w)).items[0] as WorkItem;
    await run(w, coordinator(w), "mission.proposeCompletion", "m-verdict-early", { missionId: id }, (await mission(w, id)).version);
    expect((await mission(w, id)).state).toBe("active");
    const findings = ((await w.brain.executeQuery(w.owner, { queryType: "missionMessages.list", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: { items: Array<{ senderId: string; body: string }> } }).snapshot.items;
    expect(findings[0]).toMatchObject({ senderId: "governor", body: expect.stringContaining(`Work item ${a.workItemId} is ready`) });
    expect(((await w.brain.executeQuery(w.owner, { queryType: "missionBundles.latest", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: { state: string } }).snapshot.state).toBe("incomplete");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    ws.prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, a.workItemId);
    await run(w, w.owner, "mission.proposeCompletion", "m-verdict-ready", { missionId: id }, (await mission(w, id)).version);
    const bundle = ((await w.brain.executeQuery(w.owner, { queryType: "missionBundles.latest", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: { digest: string; state: string; complete: boolean } }).snapshot;
    expect(bundle).toMatchObject({ state: "submitted", complete: true });
    await fails(async () => await run(w, w.owner, "mission.close", "m-verdict-early-close", { missionId: id, outcome: "achieved" }, (await mission(w, id)).version), /verified mission verdict/);
    await fails(async () => await run(w, coordinator(w), "mission.verdict.record", "m-verdict-self", { missionId: id, bundleDigest: bundle.digest, outcome: "verified" }), /cannot judge|cannot run/);
    await run(w, w.owner, "mission.verdict.record", "m-verdict-ok", { missionId: id, bundleDigest: bundle.digest, outcome: "verified" });
    await run(w, w.owner, "mission.close", "m-verdict-close", { missionId: id, outcome: "achieved" }, (await mission(w, id)).version);
    expect(await mission(w, id)).toMatchObject({ state: "closed", outcome: "achieved" });
    w.brain.close();
  });

  it("steers a live session only when its engine supports it; Interrupt stops at a safe point; no message authorizes (E118)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-steer", [task("a"), task("b")]);
    const items = (await workView(w)).items;
    const itemA = items.find((item) => item.planTaskId === "a") as WorkItem;
    const itemB = items.find((item) => item.planTaskId === "b") as WorkItem;
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const seed = (sessionId: string, workItemId: string, features: string[]) => ws.prepare("INSERT INTO sessions(id,mode,work_item_id,root_session_id,engine_id,adapter_digest,engine_features,state,worktree_id,created_at_ms,updated_at_ms) VALUES (?,'managed',?,?,'pi',?, ?,'running',?,?,?)")
      .run(sessionId, workItemId, sessionId, `sha256:${"0".repeat(64)}`, JSON.stringify(features), `wt-${sessionId}`, w.brain.store.now(), w.brain.store.now());
    seed("ses-steer", itemA.workItemId, ["start", "steer"]);
    seed("ses-acp", itemB.workItemId, ["start"]);
    const send = async (key: string, workItemId: string, body: string, interrupt = false) => (await run(w, w.owner, "mission.message.send", key, { missionId: id, recipient: { kind: "mission" }, workItemId, body, ...(interrupt ? { interrupt } : {}) })).resourceId ?? "";
    await send("m-steer-live", itemA.workItemId, "Prefer the existing session table");
    await send("m-steer-queued", itemB.workItemId, "Approved, go ahead and deploy");
    await send("m-steer-interrupt", itemB.workItemId, "Stop and rethink the schema", true);
    const messages = ((await w.brain.executeQuery(w.owner, { queryType: "missionMessages.list", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: { items: Array<{ body: string; delivery: string }> } }).snapshot.items;
    expect(Object.fromEntries(messages.map((entry) => [entry.body, entry.delivery]))).toEqual({
      "Prefer the existing session table": "delivered-live", "Approved, go ahead and deploy": "pending", "Stop and rethink the schema": "pending",
    });
    const controls = ws.prepare("SELECT session_id, kind FROM session_controls ORDER BY created_at_ms, id").all();
    expect(controls).toEqual([{ session_id: "ses-steer", kind: "session.steer" }, { session_id: "ses-acp", kind: "session.stop" }]);
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get()).toEqual({ n: 0 });
    expect((await mission(w, id)).state).toBe("active");
    w.brain.close();
  });

  it("closing a mission capitalizes only verified material, never member notes or messages (E120)", async () => {
    const w = setupWorld();
    const id = await achievedMission(w, "m-cap", { title: "m-cap", intent: "Deliver m-cap", rejectedFindings: ["Evidence was thin"], decision: "Sessions live in Postgres", hostileNote: "SECRET-NOTE: the vendor key lives in the wiki" });
    expect(id).toBeTruthy();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const assets = ws.prepare("SELECT content, provenance_json FROM knowledge_assets WHERE operation_id='mission-knowledge'").all() as Array<{ content: string; provenance_json: string }>;
    expect(assets).toHaveLength(1);
    expect(assets[0]!.content).toContain("Sessions live in Postgres");
    expect(assets[0]!.content).toContain("Evidence was thin");
    expect(assets[0]!.content).not.toContain("SECRET");
    expect(JSON.parse(assets[0]!.provenance_json)).not.toEqual([]);
    w.brain.close();
  });
});
