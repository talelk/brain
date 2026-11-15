import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, JsonValue, Mission, OutputDetail, PlanTask, TeamMember, WorkItem } from "@brain/contracts";
import { DIGEST_A, setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { register, running, type Offer, type Runner } from "../support/machine-session";

// Spec #90, stories 71 and 72 (#127, ADR 0064): a plan task may declare candidates. Admission starts one attempt per candidate and counts
// the budget for all of them before any starts; each candidate produces its own output version and is judged by its own evaluator verdict;
// a person keeps one, the others stay as compared outputs; a failed candidate never fails the task while another can be kept; and Done
// needs the kept candidate's own verified evidence (ADR 0022). State is reached through commands, the runner protocol and the evaluator's
// verdict rows; no table is written to move the task.
type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

const team: TeamMember[] = [
  { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  { memberId: "reviewer", role: "Reviewer", agentId: "operations-assistant", engine: "fixture" },
];
const CANDIDATES = [{ id: "c1", memberId: "writer" }, { id: "c2", memberId: "reviewer" }, { id: "c3", workflowId: "general-single-b" }];

/** The starter release plus two single-step copies of the general task workflow, so a test can finish a run by itself. */
function world(): World {
  const w = setupWorld();
  const bundle = fixtureStarter();
  const source = bundle.documents.find((doc) => doc.path.endsWith("general-task.yaml"))!;
  for (const id of ["general-single", "general-single-b"]) {
    const workflow = JSON.parse(source.text);
    workflow.metadata.id = id;
    delete workflow.spec.jobs["validate"];
    workflow.spec.outputs["passed"] = { source: "literal", value: true };
    bundle.documents.push({ path: `config/${id}.yaml`, text: JSON.stringify(workflow, null, 2) + "\n" });
  }
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  worlds.push(w);
  return w;
}
const db = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number, actor = w.owner): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const item = async (w: World, missionId: string, taskId: string): Promise<WorkItem> => {
  const row = db(w).prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id=? AND state!='abandoned'").get(missionId, taskId) as { id: string };
  return ((await w.brain.executeQuery(w.owner, { queryType: "workItems.get", workspaceId: w.workspaceId, resourceId: row.id })) as { snapshot: WorkItem }).snapshot;
};
const output = async (w: World, outputId: string): Promise<OutputDetail> => ((await w.brain.executeQuery(w.owner, { queryType: "missionOutputs.get", workspaceId: w.workspaceId, resourceId: outputId })) as { snapshot: OutputDetail }).snapshot;

const candidateTask = (extra: Partial<PlanTask> = {}): PlanTask => ({
  id: "t", title: "Write the brief", criteria: ["t is written up"], dependsOn: [], workflowId: "general-single",
  assignment: { kind: "agent", id: "writer", role: "specialist" }, candidates: CANDIDATES, ...extra,
});

async function newMission(w: World, key: string, tasks: PlanTask[], extra: Record<string, unknown> = {}): Promise<string> {
  const id = (await run(w, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], ...extra })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks, team })).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  return id;
}

const linksOf = (w: World, workItemId: string) => db(w).prepare("SELECT run_id AS runId, candidate_id AS candidateId, candidate_round AS round FROM execution_links WHERE work_item_id=? ORDER BY created_at_ms, rowid").all(workItemId) as Array<{ runId: string; candidateId: string | null; round: number | null }>;
const runOf = (w: World, workItemId: string, candidateId: string): string => linksOf(w, workItemId).filter((link) => link.candidateId === candidateId).at(-1)!.runId;

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!done()) { if (Date.now() > deadline) throw new Error(`not reached in time: ${what}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
const deliverable = (title: string) => ({
  summary: `${title} is ready.`,
  deliverable: `# ${title}\n\n## Findings\n\n${`The analysis weighs the options and ${title} recommends one for stated reasons. `.repeat(3)}\n\n## Assumptions\n\nNone beyond the brief.`,
  criteria: [{ criterion: "t is written up", met: true, evidence: "The Findings section covers it." }], assumptions: [],
});
/** A candidate's run reaches its end: its one step reports a written result, or fails. */
async function finishRun(w: World, runId: string, ok: boolean, title = "Draft"): Promise<void> {
  await until(() => Boolean(w.brain.store.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(runId)), "the respond job exists");
  w.brain.workflows.completeStep(w.org, w.workspaceId, runId, "respond", (ok ? deliverable(title) : { error: "the model used its whole output limit" }) as unknown as JsonValue, ok);
  await until(() => ["succeeded", "failed"].includes((db(w).prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state), "the run ends");
}
/** What the candidate's own evaluator step produced: a bundle of its run and the verdict on it. */
function verdict(w: World, runId: string, outcome: "verified" | "rejected", tag: string): string {
  const digest = `sha256:${tag.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/gu, "a")}`;
  const job = w.brain.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=?").get(runId) as { id: string };
  const manifest = {
    contractVersion: "brain.evidence/v1", bundleId: `bundle-${tag}`, organizationId: w.org, workspaceId: w.workspaceId, workflowRunId: runId, jobId: job.id, attemptId: `att-${tag}`, jobFence: 1,
    sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [], artifacts: [],
    checks: ["structure", "safety", "deliverable", "criteria-met"].map((id) => ({ criterionId: id, checkId: id, status: outcome === "verified" ? "passed" : "failed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" })),
    approvalIds: [], effects: [], createdAt: new Date().toISOString(),
  };
  db(w).prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(digest, manifest.bundleId, job.id, manifest.attemptId, outcome === "verified" ? "verified" : "rejected", JSON.stringify(manifest), w.brain.store.now());
  db(w).prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(`verdict-${tag}`, digest, `eval-${tag}`, DIGEST_A, outcome, JSON.stringify({ checks: [], acceptedBy: "owner-1" }), w.brain.store.now());
  return digest;
}

describe("best-of-N candidates (#127)", () => {
  it("starts one attempt per candidate, counting the budget for all of them first and holding the member cap at the claim", async () => {
    const w = world();
    // Three candidates reserve 3 x 400 = 1200 of a 1000 budget: none of them starts, and the task says why.
    const id = await newMission(w, "budget", [candidateTask()], { budget: { maxMicroUsd: 1000, memberCap: 2, attemptReserveMicroUsd: 400 } });
    let t = await item(w, id, "t");
    expect(t.state).toBe("ready");
    expect(t.nextAction).toMatch(/The 3 candidates cannot start together: the budget does not cover 3 candidates/u);
    expect(linksOf(w, t.workItemId)).toEqual([]);
    expect(db(w).prepare("SELECT COUNT(*) AS n FROM workflow_runs").get()).toEqual({ n: 0 });
    expect(t.candidates).toBeUndefined();

    // A budget that covers all three starts all three together, in one round, each naming its own candidate.
    await run(w, "mission.budget.set", "raise", { missionId: id, budget: { maxMicroUsd: 2000, memberCap: 2, attemptReserveMicroUsd: 400 } }, (await mission(w, id)).version);
    t = await item(w, id, "t");
    expect(t.state).toBe("in-progress");
    expect(linksOf(w, t.workItemId).map((link) => [link.candidateId, link.round])).toEqual([["c1", 1], ["c2", 1], ["c3", 1]]);
    expect(t.candidates?.items.map((entry) => [entry.candidateId, entry.label, entry.state])).toEqual([["c1", "writer", "waiting"], ["c2", "reviewer", "waiting"], ["c3", "general-single-b", "waiting"]]);

    // The member cap holds at the claim: two attempts run, the third waits for a free member, and each acts as its own member.
    const runner: Runner = register(w, "runner-best-of-n");
    const first = running(w, runner, "k1"), second = running(w, runner, "k2");
    expect(w.brain.jobProtocol.claim(runner, "k3")).toBeNull();
    const memberOf = (offer: Offer): string | undefined => w.brain.jobProtocol.sessionCredential(runner, offer.attemptId).memberId;
    const byRun = (offer: Offer): string => (w.brain.store.control.prepare("SELECT workflow_run_id AS id FROM jobs WHERE id=?").get(offer.jobId) as { id: string }).id;
    const members = new Map([first, second].map((offer) => [byRun(offer), memberOf(offer)] as const));
    expect(members.get(runOf(w, t.workItemId, "c1"))).toBe("writer");
    expect(members.get(runOf(w, t.workItemId, "c2"))).toBe("reviewer");
    expect(w.brain.store.control.prepare("SELECT queue_reason AS reason FROM jobs WHERE workflow_run_id=?").get(runOf(w, t.workItemId, "c3"))).toEqual({ reason: "waiting: member cap" });
    expect((await item(w, id, "t")).candidates?.items.map((entry) => entry.state)).toEqual(["running", "running", "waiting"]);
  });

  it("judges each candidate by its own verdict, keeps the one a person picks and retains the others as compared outputs", async () => {
    const w = world();
    const id = await newMission(w, "keep", [candidateTask()]);
    const t0 = await item(w, id, "t");
    expect(t0.state).toBe("in-progress");

    // Each candidate that finishes records its own output version at once; the task waits for the others.
    await finishRun(w, runOf(w, t0.workItemId, "c1"), true, "Writer draft");
    expect((await item(w, id, "t")).state).toBe("in-progress");
    await finishRun(w, runOf(w, t0.workItemId, "c2"), true, "Reviewer draft");
    // One candidate failing does not fail the task: the others can still be kept.
    await finishRun(w, runOf(w, t0.workItemId, "c3"), false);
    const t = await item(w, id, "t");
    expect(t.state).toBe("review");
    expect(t.failedAttempts).toBe(0);
    expect(t.nextAction).toBe("2 of 3 candidates finished: compare them and keep one");
    expect(t.candidates?.items.map((entry) => [entry.candidateId, entry.state])).toEqual([["c1", "succeeded"], ["c2", "succeeded"], ["c3", "failed"]]);
    const versions = t.candidates!.items.filter((entry) => entry.outputVersionId);
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((entry) => entry.outputVersionId)).size).toBe(2);
    expect(new Set(versions.map((entry) => entry.outputId)).size).toBe(1);

    // Independent verdicts: the first candidate's evaluator verified it, the second's did not. Only the verified one is proposed.
    const verifiedDigest = verdict(w, runOf(w, t.workItemId, "c1"), "verified", "aaa1");
    const rejectedDigest = verdict(w, runOf(w, t.workItemId, "c2"), "rejected", "bbb2");
    let seen = (await item(w, id, "t")).candidates!;
    expect(seen.items.map((entry) => [entry.candidateId, entry.verdict, entry.proposed === true])).toEqual([["c1", "verified", true], ["c2", "not-verified", false], ["c3", "not-verified", false]]);
    expect(seen.keptRunId).toBeUndefined();

    // Nothing is kept by itself, and Done needs a kept candidate's evidence.
    let tries = 0;
    const done = async (digest: string) => run(w, "workItem.transition", `done-${digest.slice(7, 11)}-${++tries}`, { workItemId: t.workItemId, state: "done", evidenceDigest: digest }, (await item(w, id, "t")).version);
    await expect(done(verifiedDigest)).rejects.toThrow(/one kept candidate/u);
    // Only a person keeps, and only a candidate that finished.
    const agent = { ...w.owner, kind: "agent" as const };
    await expect(run(w, "workItem.candidate.keep", "keep-agent", { workItemId: t.workItemId, runId: runOf(w, t.workItemId, "c1") }, undefined, agent)).rejects.toThrow();
    await expect(run(w, "workItem.candidate.keep", "keep-failed", { workItemId: t.workItemId, runId: runOf(w, t.workItemId, "c3") })).rejects.toThrow(/finished/u);
    await expect(run(w, "workItem.candidate.keep", "keep-stranger", { workItemId: t.workItemId, runId: "run-not-a-candidate" })).rejects.toThrow(/not a candidate/u);
    const kept = await run(w, "workItem.candidate.keep", "keep-c2", { workItemId: t.workItemId, runId: runOf(w, t.workItemId, "c2") });
    expect(kept.accepted).toBe(true);
    // A person may change their mind until the task is Done.
    await run(w, "workItem.candidate.keep", "keep-c1", { workItemId: t.workItemId, runId: runOf(w, t.workItemId, "c1") });
    seen = (await item(w, id, "t")).candidates!;
    expect(seen.keptRunId).toBe(runOf(w, t.workItemId, "c1"));
    expect(seen.keptBy).toBe("owner-1");
    expect(seen.items.filter((entry) => entry.kept)).toHaveLength(1);

    // Done is the kept candidate's own evidence: another candidate's bundle is refused, even a rejected verdict is not its evidence.
    await expect(done(rejectedDigest)).rejects.toThrow(/not produced by a run of this work item|accepted independent verdict|verified evidence bundle/u);
    expect((await done(verifiedDigest)).accepted).toBe(true);
    const finished = await item(w, id, "t");
    expect(finished.state).toBe("done");

    // The kept version is verified; the other candidate's version is retained, unverified, and still readable beside it.
    const detail = await output(w, versions[0]!.outputId!);
    expect(detail.output.versions).toHaveLength(2);
    expect(detail.output.versions.map((version) => [version.versionId === versions[0]!.outputVersionId, version.verified])).toEqual([[true, true], [false, false]]);
    expect(detail.artifacts).toHaveLength(2);
  });

  it("never proposes a candidate while several are verified, and never keeps one by itself", async () => {
    const w = world();
    const id = await newMission(w, "several", [candidateTask()]);
    const t0 = await item(w, id, "t");
    for (const [candidate, title] of [["c1", "One"], ["c2", "Two"], ["c3", "Three"]] as const) await finishRun(w, runOf(w, t0.workItemId, candidate), true, title);
    verdict(w, runOf(w, t0.workItemId, "c1"), "verified", "ccc1");
    verdict(w, runOf(w, t0.workItemId, "c2"), "verified", "ccc2");
    verdict(w, runOf(w, t0.workItemId, "c3"), "rejected", "ccc3");
    const t = await item(w, id, "t");
    expect(t.state).toBe("review");
    expect(t.candidates!.items.map((entry) => [entry.verdict, entry.proposed === true])).toEqual([["verified", false], ["verified", false], ["not-verified", false]]);
    expect(t.candidates!.keptRunId).toBeUndefined();
    // The sweep that completes an auto-start mission's verified work leaves a task with candidates to a person.
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    expect((await item(w, id, "t")).state).toBe("review");
  });

  it("proposes the one verified candidate only where the autonomy policy is not supervised", async () => {
    const w = world();
    const id = await newMission(w, "supervised", [candidateTask()], { autonomy: "supervised" });
    const t0 = await item(w, id, "t");
    for (const candidate of ["c1", "c2", "c3"]) await finishRun(w, runOf(w, t0.workItemId, candidate), true, candidate);
    verdict(w, runOf(w, t0.workItemId, "c2"), "verified", "ddd2");
    const t = await item(w, id, "t");
    expect(t.candidates!.items.map((entry) => [entry.verdict, entry.proposed === true])).toEqual([["not-verified", false], ["verified", false], ["not-verified", false]]);
  });

  it("fails the task, with the usual remedy, only when no candidate produced a result", async () => {
    const w = world();
    const id = await newMission(w, "allfail", [candidateTask()]);
    const t0 = await item(w, id, "t");
    for (const candidate of ["c1", "c2", "c3"]) await finishRun(w, runOf(w, t0.workItemId, candidate), false);
    const t = await item(w, id, "t");
    expect(t.failedAttempts).toBe(1);
    expect(t.state).not.toBe("review");
    // The retry is a new round of all three candidates.
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    await until(() => linksOf(w, t0.workItemId).some((link) => link.round === 2), "round two starts");
    expect(linksOf(w, t0.workItemId).filter((link) => link.round === 2).map((link) => link.candidateId)).toEqual(["c1", "c2", "c3"]);
    expect(t.candidates).toBeDefined();
  });

  it("starts the candidates of a task a person starts by hand, together, and refuses a second fan-out while the first runs", async () => {
    const w = world();
    const id = await newMission(w, "manual", [candidateTask()], { autoStart: false });
    const t0 = await item(w, id, "t");
    expect(t0.state).toBe("ready");
    const digest = w.brain.activeRelease(w.org)!.digest;
    const dispatch = (key: string) => run(w, "workflow.dispatch", key, { workflow: { id: "general-single", digest }, input: { situation: "Write the brief" }, workItemId: t0.workItemId });
    const started = await dispatch("start-1");
    expect(started.accepted).toBe(true);
    expect(linksOf(w, t0.workItemId).map((link) => link.candidateId)).toEqual(["c1", "c2", "c3"]);
    expect((await item(w, id, "t")).state).toBe("in-progress");
    await expect(dispatch("start-2")).rejects.toThrow(/already running/u);
    expect(linksOf(w, t0.workItemId)).toHaveLength(3);
  });

  it("refuses a plan whose candidates are fewer than two, more than four, alike, off the team or on a subtask", async () => {
    const w = world();
    const id = (await run(w, "mission.create", "val-create", { title: "val", intent: "Check the plan", successCriteria: ["delivered"] })).resourceId ?? "";
    const propose = async (key: string, tasks: PlanTask[]) => (await run(w, "plan.propose", key, { missionId: id, origin: "manual", tasks, team })).resourceId ?? "";
    const confirm = async (key: string, tasks: PlanTask[]) => run(w, "plan.confirm", `${key}-c`, { planVersionId: await propose(key, tasks) }, (await mission(w, id)).version);
    await expect(confirm("one", [candidateTask({ candidates: [{ id: "c1", memberId: "writer" }] })])).rejects.toThrow();
    await expect(confirm("five", [candidateTask({ candidates: ["a", "b", "c", "d", "e"].map((name) => ({ id: name, workflowId: `general-${name}` })) })])).rejects.toThrow();
    await expect(confirm("alike", [candidateTask({ candidates: [{ id: "c1", memberId: "writer" }, { id: "c2", memberId: "writer" }] })])).rejects.toThrow(/same member/u);
    await expect(confirm("bare", [candidateTask({ candidates: [{ id: "c1", memberId: "writer" }, { id: "c2" }] })])).rejects.toThrow(/neither/u);
    await expect(confirm("stranger", [candidateTask({ candidates: [{ id: "c1", memberId: "writer" }, { id: "c2", memberId: "nobody" }] })])).rejects.toThrow(/not on the mission team/u);
    await expect(confirm("ghost", [candidateTask({ candidates: [{ id: "c1", memberId: "writer" }, { id: "c2", workflowId: "not-in-release" }] })])).rejects.toThrow(/not in the active release/u);
    await expect(confirm("subtask", [candidateTask(), { id: "child", title: "Child", criteria: ["x"], dependsOn: [], parentId: "t" }])).rejects.toThrow(/cannot be a subtask or have subtasks/u);
  });

  it("does not let a replan change the candidates of started work", async () => {
    const w = world();
    const id = await newMission(w, "replan", [candidateTask()]);
    expect((await item(w, id, "t")).state).toBe("in-progress");
    await expect(run(w, "plan.propose", "replan-2", { missionId: id, origin: "manual", team, tasks: [candidateTask({ candidates: [{ id: "c1", memberId: "writer" }, { id: "c2", memberId: "reviewer" }] })] })).rejects.toThrow(/changes started work/u);
  });
});
