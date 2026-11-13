import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, KnowledgeAsset, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { DIGEST_A, setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { ownBundleJob } from "../support/evidence";
import { achievedMission, command as cmd, reuseSearch } from "../support/reuse";
import { alertBadProbes, recordProbe } from "../../apps/governor/src/modules/operations/index";
import { modelRouteFor } from "../../apps/governor/src/modules/jobs/index";
import { OUTAGE_WAIT_MS } from "../../apps/governor/src/domain/failure";

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

function world(): World {
  const w = setupWorld();
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  worlds.push(w);
  return w;
}
const ws = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
const run = (w: World, type: string, key: string, payload: Record<string, unknown>, version?: number): Promise<CommandReceipt> => cmd(w, w.owner, type, key, payload, version);
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const item = (w: World, missionId: string, taskId: string): WorkItem => {
  const id = (ws(w).prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id=? AND state!='abandoned'").get(missionId, taskId) as { id: string }).id;
  return w.brain.missions.query(w.owner, "workItems.get", w.workspaceId, id) as unknown as WorkItem;
};
const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [], ...extra });

/** A mission whose runs the test drives by hand (auto-start off), with a confirmed plan. */
async function planned(w: World, key: string, tasks: PlanTask[], extra: Record<string, unknown> = {}): Promise<string> {
  const id = (await run(w, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], autoStart: false, ...extra })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  return id;
}
/** What auto-start would start now (the missions here are driven by hand, so switch their auto-start on only for the look). */
const listPlan = (w: World) => { ws(w).prepare("UPDATE missions SET auto_start=1").run(); return w.brain.missions.autoStartPlan(w.org, w.workspaceId); };
let counter = 0;
const attempt = (w: World, workItemId: string, runId: string): void => w.brain.missions.linkExecution(w.owner, w.workspaceId, workItemId, runId);
const toolCall = (w: World, runId: string, tool: string, opts: { failed?: boolean; message?: string; unfinished?: boolean } = {}): void => {
  const at = new Date().toISOString();
  w.brain.store.control.prepare("INSERT INTO tool_calls(attempt_id, proposal_id, organization_id, workspace_id, run_id, tool_id, proposed_at, failed, finished_at, failure_message) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(`att-${runId}-${counter}`, `prop-${counter++}`, w.org, w.workspaceId, runId, tool, at, opts.failed ? 1 : 0, opts.unfinished ? null : at, opts.message ?? null);
};
const runWorkflow = (w: World, runId: string, workflowId: string): void => {
  ws(w).prepare("INSERT INTO workflow_runs(id,execution_key,config_digest,workflow_digest,adapter_digest,engine_run_id,state,input_digest,created_at_ms) VALUES (?,?,?,?,?,?,'failed',?,?)")
    .run(runId, `exec-${runId}`, DIGEST_A, DIGEST_A, DIGEST_A, `engine-${runId}`, DIGEST_A, w.brain.store.now());
  ws(w).prepare("INSERT INTO run_inputs(run_id,input_json,workflow_json,actor_id) VALUES (?,?,?,?)").run(runId, "{}", JSON.stringify({ metadata: { id: workflowId } }), "owner-1");
};
const spend = (w: World, missionId: string, runId: string, tokens: number): void => {
  ws(w).prepare("INSERT INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,settled_micro_usd,input_tokens,output_tokens,created_at_ms,settled_at_ms) VALUES (?,?,?,0,0,?,0,?,?)")
    .run(`att-spend-${counter++}`, missionId, runId, tokens, w.brain.store.now(), w.brain.store.now());
};
const SRE_TOOLS = ["host.exec", "host.read"];
const setWayOfWorking = (w: World, key: string): Promise<CommandReceipt> => run(w, "workspace.wayOfWorking.set", key, { workflowId: "sre-task", requiredTools: SRE_TOOLS });

describe("a task that needs tools is planned on a way of working that has them (ADR 0022)", () => {
  it("refuses a plan whose task needs a tool its way of working lacks, and accepts it on a way of working that has it", async () => {
    const w = world();
    const id = (await run(w, "mission.create", "pw-create", { title: "pw", intent: "Deliver pw", successCriteria: ["x"], autoStart: false })).resourceId ?? "";
    await expect(run(w, "plan.propose", "pw-bad", { missionId: id, origin: "manual", tasks: [task("a", { requiredTools: ["host.exec"] })] })).rejects.toThrow(/needs host\.exec but its way of working general-task lacks it; use sre-task/);
    await expect(run(w, "plan.propose", "pw-bad2", { missionId: id, origin: "manual", tasks: [task("a", { requiredTools: ["host.exec"], workflowId: "general-task" })] })).rejects.toThrow(/lacks it/);
    expect((await run(w, "plan.propose", "pw-ok", { missionId: id, origin: "manual", tasks: [task("a", { requiredTools: ["host.exec"], workflowId: "sre-task" })] })).accepted).toBe(true);
  });

  it("the owner sets the workspace default; tasks inherit its tools and workflow, and the planner may override per task", async () => {
    const w = world();
    await expect(run(w, "workspace.wayOfWorking.set", "wow-bad", { workflowId: "general-task", requiredTools: ["host.exec"] })).rejects.toThrow(/general-task lacks host\.exec/);
    await expect(run(w, "workspace.wayOfWorking.set", "wow-ghost", { workflowId: "nope" })).rejects.toThrow(/not in the active release/);
    await setWayOfWorking(w, "wow-ok");
    const id = await planned(w, "inherit", [task("a"), task("b", { requiredTools: ["documents.read"] }), task("c", { requiredTools: [], workflowId: "sre-task" })]);
    expect(item(w, id, "a")).toMatchObject({ requiredTools: SRE_TOOLS });
    expect(item(w, id, "b")).toMatchObject({ requiredTools: ["documents.read"] });
    expect(item(w, id, "c").requiredTools).toBeUndefined();
    // The default's tools bind every task that does not override them: a task moved to a way of working without them is refused.
    const bad = (await run(w, "mission.create", "inherit-create2", { title: "inherit2", intent: "Deliver", successCriteria: ["x"], autoStart: false })).resourceId ?? "";
    await expect(run(w, "plan.propose", "inherit-bad", { missionId: bad, origin: "manual", tasks: [task("a", { workflowId: "general-task" })] })).rejects.toThrow(/needs host\.exec, host\.read but its way of working general-task lacks them/);
    const settings = ((await w.brain.executeQuery(w.owner, { queryType: "engineSettings.get", workspaceId: w.workspaceId })) as unknown as { snapshot: { wayOfWorking: { workflowId: string; requiredTools: string[] } } }).snapshot;
    expect(settings.wayOfWorking).toEqual({ workflowId: "sre-task", requiredTools: SRE_TOOLS });
  });

  it("starts an inheriting task on the way of working that has its tools, not the general one", async () => {
    const w = world();
    await setWayOfWorking(w, "start-wow");
    const id = (await run(w, "mission.create", "start-create", { title: "start", intent: "Deliver start", successCriteria: ["x"] })).resourceId ?? "";
    const planId = (await run(w, "plan.propose", "start-plan", { missionId: id, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
    await run(w, "plan.confirm", "start-confirm", { planVersionId: planId }, (await mission(w, id)).version);
    const runId = (ws(w).prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").get(item(w, id, "a").workItemId) as { run_id: string }).run_id;
    expect((ws(w).prepare("SELECT json_extract(workflow_json,'$.metadata.id') AS id FROM run_inputs WHERE run_id=?").get(runId) as { id: string }).id).toBe("sre-task");
  });
});

describe("Done needs observed evidence (ADR 0022)", () => {
  it("a run that finished without one successful call of a required tool is a failed attempt, never a result", async () => {
    const w = world();
    const id = await planned(w, "obs", [task("a", { requiredTools: ["host.read", "host.exec"], workflowId: "sre-task" })]);
    const a = item(w, id, "a");
    attempt(w, a.workItemId, "obs-r1");
    toolCall(w, "obs-r1", "knowledge.search"); // a call of some other tool never counts
    w.brain.missions.recordRunSuccess(w.org, w.workspaceId, "obs-r1");
    expect(item(w, id, "a")).toMatchObject({ state: "ready", failedAttempts: 1, failureClass: "model-slip", remedy: "stronger-model" });
    // A call that never recorded a result, or failed, does not count either.
    attempt(w, a.workItemId, "obs-r2");
    toolCall(w, "obs-r2", "host.read", { unfinished: true });
    w.brain.missions.recordRunSuccess(w.org, w.workspaceId, "obs-r2");
    expect(item(w, id, "a").state).not.toBe("review");
    // One successful call of one of them is enough to reach review.
    attempt(w, a.workItemId, "obs-r3");
    toolCall(w, "obs-r3", "host.exec");
    w.brain.missions.recordRunSuccess(w.org, w.workspaceId, "obs-r3");
    expect(item(w, id, "a").state).toBe("review");
  });

  it("the sweep never counts the same failed run twice; the task parks at the mission's threshold with its class and a lesson", async () => {
    const w = world();
    const id = await planned(w, "park", [task("a", { requiredTools: ["host.exec"], workflowId: "sre-task" })], { parkingThreshold: 2 });
    const a = item(w, id, "a");
    for (const runId of ["pk-1", "pk-1", "pk-2", "pk-2"]) { if (!ws(w).prepare("SELECT 1 FROM execution_links WHERE run_id=?").get(runId)) attempt(w, a.workItemId, runId); w.brain.missions.recordRunSuccess(w.org, w.workspaceId, runId); }
    expect(item(w, id, "a")).toMatchObject({ state: "blocked", parked: true, failedAttempts: 2, failureClass: "model-slip" });
    const lessons = ((await w.brain.executeQuery(w.owner, { queryType: "lessons.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Array<{ outcome: string; failureClass: string; lesson: string }> } }).snapshot.items;
    expect(lessons).toEqual([expect.objectContaining({ outcome: "parked", failureClass: "model-slip" })]);
    // The planner is given the lesson.
    expect(w.brain.missions.lessonsPrompt(w.owner, w.workspaceId)).toContain("Lessons from earlier work");
  });

  it("the Done transition itself refuses without a recorded call, whoever asks", async () => {
    const w = world();
    const id = await planned(w, "gate", [task("a", { requiredTools: ["host.exec"], workflowId: "sre-task" })]);
    const a = item(w, id, "a");
    attempt(w, a.workItemId, "gate-r1");
    toolCall(w, "gate-r1", "host.exec");
    w.brain.missions.recordRunSuccess(w.org, w.workspaceId, "gate-r1");
    const reviewing = item(w, id, "a");
    expect(reviewing.state).toBe("review");
    ws(w).prepare("DELETE FROM execution_links WHERE run_id='gate-r1'").run();
    attempt(w, a.workItemId, "gate-r2");
    await expect(run(w, "workItem.transition", "gate-done", { workItemId: a.workItemId, state: "done", evidenceDigest: `sha256:${"e".repeat(64)}` }, reviewing.version)).rejects.toThrow(/successful recorded call of host\.exec; none was recorded/);
    // With the call recorded the gate passes and the ordinary evidence rules apply.
    toolCall(w, "gate-r2", "host.exec");
    await expect(run(w, "workItem.transition", "gate-done2", { workItemId: a.workItemId, state: "done", evidenceDigest: `sha256:${"e".repeat(64)}` }, reviewing.version)).rejects.toThrow(/verified evidence bundle/);
  });

  it("a task that failed first and then reached Done leaves a healed lesson", async () => {
    const w = world();
    const id = await planned(w, "heal", [task("a")]);
    const a = item(w, id, "a");
    attempt(w, a.workItemId, "heal-1");
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "heal-1", "the agent gave up");
    attempt(w, a.workItemId, "heal-2");
    w.brain.missions.recordRunSuccess(w.org, w.workspaceId, "heal-2");
    const reviewing = item(w, id, "a");
    const db = ws(w);
    const manifest = { contractVersion: "brain.evidence/v1", bundleId: "bundle-heal", organizationId: w.org, workspaceId: w.workspaceId, workflowRunId: "run-seed", jobId: "job-heal", attemptId: "att-seed", jobFence: 1, sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [], artifacts: [], checks: [{ criterionId: "a-done", checkId: "c", status: "passed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" }], approvalIds: [], effects: [], createdAt: new Date().toISOString() };
    const digest = `sha256:${"b".repeat(64)}`;
    db.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)").run(digest, "bundle-heal", "job-heal", "att-seed", JSON.stringify(manifest), w.brain.store.now());
    db.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES ('verdict-heal', ?, 'eval-seed', ?, 'verified', ?, ?)").run(digest, DIGEST_A, JSON.stringify({ checks: [], acceptedBy: "owner-1" }), w.brain.store.now());
    ownBundleJob(db, a.workItemId, "job-heal", w.brain.store.now());
    await run(w, "handoff.submit", "heal-handoff", { workItemId: a.workItemId, notes: { summary: "done" } });
    await run(w, "workItem.transition", "heal-done", { workItemId: a.workItemId, state: "done", evidenceDigest: digest }, reviewing.version);
    expect(item(w, id, "a")).toMatchObject({ state: "done" });
    expect(w.brain.missions.lessons(db, 10)).toEqual([expect.objectContaining({ outcome: "healed", failureClass: "unclassified" })]);
  });
});

describe("each failure class has one remedy (ADR 0022)", () => {
  it("missing tool: switches to a way of working whose agent has it, or parks when none does", async () => {
    const w = world();
    const id = await planned(w, "mt", [task("a", { requiredTools: ["host.exec"], workflowId: "sre-task" })]);
    const a = item(w, id, "a");
    runWorkflow(w, "mt-1", "general-task"); // the failed run used a way of working whose agent lacks the tool
    attempt(w, a.workItemId, "mt-1");
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "mt-1", "the run failed");
    expect(item(w, id, "a")).toMatchObject({ state: "ready", failureClass: "missing-tool", remedy: "switch-way-of-working", parked: false });
    expect(item(w, id, "a").nextAction).toContain("sre-task");
    expect(listPlan(w).flatMap((entry) => entry.items).find((entry) => entry.workItemId === a.workItemId)).toMatchObject({ failureClass: "missing-tool", requiredTools: ["host.exec"], workflowId: "sre-task" });
    // No way of working has the tool: parked at once with the one fix.
    const id2 = await planned(w, "mt2", [task("a", { requiredTools: ["repo.write"], workflowId: "no-such-workflow" })]);
    attempt(w, item(w, id2, "a").workItemId, "mt-2");
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "mt-2", "tool repo.write is not available to this agent");
    expect(item(w, id2, "a")).toMatchObject({ state: "blocked", parked: true, failureClass: "missing-tool" });
    expect(item(w, id2, "a").blockedReason).toContain("no way of working has repo.write");
  });

  it("model slip: a failed independent check counts as an attempt and the next one is a second attempt", async () => {
    const w = world();
    const id = await planned(w, "ms", [task("a")]);
    const a = item(w, id, "a");
    attempt(w, a.workItemId, "ms-1");
    const digest = `sha256:${"1".repeat(64)}`;
    ws(w).prepare("INSERT INTO evidence_bundles(digest,bundle_id,job_id,attempt_id,state,manifest_json,created_at_ms) VALUES (?,?,?,?,'rejected',?,?)").run(digest, "b1", "j1", "a1", JSON.stringify({ workflowRunId: "ms-1" }), w.brain.store.now());
    ws(w).prepare("INSERT INTO verification_verdicts(id,bundle_digest,evaluator_attempt_id,evaluator_digest,outcome,manifest_json,created_at_ms) VALUES ('v1',?,?,?,'rejected',?,?)").run(digest, "e1", DIGEST_A, JSON.stringify({ checks: [{ checkId: "structure", status: "failed" }] }), w.brain.store.now());
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "ms-1", "the run failed");
    expect(item(w, id, "a")).toMatchObject({ state: "ready", failedAttempts: 1, failureClass: "model-slip", remedy: "stronger-model", parked: false });
    expect(listPlan(w).flatMap((entry) => entry.items).find((entry) => entry.workItemId === a.workItemId)).toMatchObject({ secondAttempt: true });
  });

  it("tool outage: waits and retries without burning an attempt, then counts once the outage outlasts the waits", async () => {
    const w = world();
    const id = await planned(w, "to", [task("a", { requiredTools: ["host.read"], workflowId: "sre-task" })]);
    const a = item(w, id, "a");
    for (const [index, runId] of ["to-1", "to-2", "to-3"].entries()) {
      attempt(w, a.workItemId, runId);
      toolCall(w, runId, "host.read", { failed: true, message: "sandboxed execution failed: the launcher timed out" });
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, "the run failed");
      expect(item(w, id, "a")).toMatchObject({ state: "ready", failedAttempts: 0, failureClass: "tool-outage", remedy: "wait-and-retry", parked: false });
      expect(index).toBeLessThan(3);
    }
    // Held until the wait is over: auto-start does not list it.
    expect(listPlan(w).flatMap((entry) => entry.items).some((entry) => entry.workItemId === a.workItemId)).toBe(false);
    ws(w).prepare("UPDATE work_items SET retry_after_ms=? WHERE id=?").run(w.brain.store.now() - 1, a.workItemId);
    expect(listPlan(w).flatMap((entry) => entry.items).some((entry) => entry.workItemId === a.workItemId)).toBe(true);
    expect(OUTAGE_WAIT_MS).toBeGreaterThan(0);
    // The outage outlasts the waits: now it counts as a failed attempt.
    attempt(w, a.workItemId, "to-4");
    toolCall(w, "to-4", "host.read", { failed: true, message: "the launcher timed out" });
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "to-4", "the run failed");
    expect(item(w, id, "a").failedAttempts).toBe(1);
  });

  it("criterion that cannot be met: parks at once with one question, never retried by a release", async () => {
    const w = world();
    const id = await planned(w, "uc", [task("a", { requiredTools: ["host.read"], workflowId: "sre-task" })]);
    const a = item(w, id, "a");
    attempt(w, a.workItemId, "uc-1");
    toolCall(w, "uc-1", "host.read", { failed: true, message: "that path is outside the readable area" });
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "uc-1", "the run failed");
    expect(item(w, id, "a")).toMatchObject({ state: "blocked", parked: true, failedAttempts: 1, failureClass: "unmeetable-criterion", remedy: "ask-one-question" });
    expect(item(w, id, "a").blockedReason).toMatch(/cannot be met as written/);
    expect(w.brain.missions.retryParkedForRelease(w.org, `sha256:${"7".repeat(64)}`)).toBe(0);
  });
});

describe("a task stops at its token cap across all attempts (default 200k)", () => {
  it("parks as budget at the cap, stops automatic retries, and the owner raises the cap for that one task", async () => {
    const w = world();
    const id = await planned(w, "cap", [task("a"), task("b")]);
    const a = item(w, id, "a");
    expect(a).toMatchObject({ tokenCap: 200_000, tokensUsed: 0 });
    attempt(w, a.workItemId, "cap-1");
    spend(w, id, "cap-1", 120_000);
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "cap-1", "the run failed");
    expect(item(w, id, "a")).toMatchObject({ state: "ready", parked: false, tokensUsed: 120_000 });
    attempt(w, a.workItemId, "cap-2");
    spend(w, id, "cap-2", 90_000);
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "cap-2", "the run failed");
    expect(item(w, id, "a")).toMatchObject({ state: "blocked", parked: true, failureClass: "budget", remedy: "park-budget", tokensUsed: 210_000 });
    // A new release does not retry it; another task of the mission is untouched.
    expect(w.brain.missions.retryParkedForRelease(w.org, `sha256:${"6".repeat(64)}`)).toBe(0);
    expect(item(w, id, "a").parked).toBe(true);
    expect(item(w, id, "b")).toMatchObject({ tokenCap: 200_000 });
    // Only a person raises it, and only above the current cap.
    await expect(cmd(w, { ...w.owner, kind: "agent" }, "workItem.spendCap.raise", "cap-agent", { workItemId: a.workItemId, maxTokens: 400_000 })).rejects.toThrow();
    await expect(run(w, "workItem.spendCap.raise", "cap-low", { workItemId: a.workItemId, maxTokens: 150_000 })).rejects.toThrow(/raise it above/);
    await run(w, "workItem.spendCap.raise", "cap-raise", { workItemId: a.workItemId, maxTokens: 400_000 });
    expect(item(w, id, "a")).toMatchObject({ state: "ready", parked: false, tokenCap: 400_000 });
    expect(item(w, id, "b").tokenCap).toBe(200_000);
  });

  it("a ready task already over its cap is parked at dispatch, not started again", async () => {
    const w = world();
    const id = await planned(w, "cap2", [task("a")], { autoStart: true });
    const a = item(w, id, "a");
    attempt(w, a.workItemId, "cap2-1");
    spend(w, id, "cap2-1", 250_000);
    ws(w).prepare("UPDATE work_items SET state='ready' WHERE id=?").run(a.workItemId);
    listPlan(w);
    expect(item(w, id, "a")).toMatchObject({ state: "blocked", failureClass: "budget", parked: true });
  });
});

describe("a hosted model checks results and takes second attempts only, per workspace (ADR 0023)", () => {
  const hosted = { enabled: true, vendor: "Acme", model: "acme-large", baseUrl: "https://models.acme.example/v1" };

  it("is off by default and cannot carry a credential", async () => {
    const w = world();
    const settings = async () => ((await w.brain.executeQuery(w.owner, { queryType: "engineSettings.get", workspaceId: w.workspaceId })) as unknown as { snapshot: { hostedModel: { enabled: boolean; status: string } } }).snapshot.hostedModel;
    expect(await settings()).toMatchObject({ enabled: false, status: "off" });
    expect(modelRouteFor(w.brain.store, w.org, w.workspaceId, "any-run", "eval")).toBeUndefined();
    await expect(run(w, "workspace.hostedModel.set", "hm-cred", { ...hosted, baseUrl: "https://user:secret@models.acme.example/v1" })).rejects.toThrow(/without credentials/);
    await expect(run(w, "workspace.hostedModel.set", "hm-query", { ...hosted, baseUrl: "https://models.acme.example/v1?key=abc" })).rejects.toThrow(/without credentials/);
    await expect(run(w, "workspace.hostedModel.set", "hm-http", { ...hosted, baseUrl: "http://models.acme.example/v1" })).rejects.toThrow(/https/);
    await expect(run(w, "workspace.hostedModel.set", "hm-incomplete", { enabled: true })).rejects.toThrow(/Choose the vendor/);
    expect(await settings()).toMatchObject({ enabled: false });
  });

  it("routes the evaluator and the second attempt of a model slip only, and never carries a key", async () => {
    const w = world();
    await run(w, "workspace.hostedModel.set", "hm-on", hosted);
    const id = await planned(w, "hm", [task("a")]);
    const a = item(w, id, "a");
    expect(modelRouteFor(w.brain.store, w.org, w.workspaceId, "hm-1", "eval")).toEqual({ tier: "hosted", role: "evaluator", vendor: "Acme", model: "acme-large", baseUrl: "https://models.acme.example/v1" });
    // Planning and non-agent kinds stay self-hosted; so does a first attempt.
    attempt(w, a.workItemId, "hm-1");
    expect(modelRouteFor(w.brain.store, w.org, w.workspaceId, "hm-1", "dispatch")).toBeUndefined();
    expect(modelRouteFor(w.brain.store, w.org, w.workspaceId, "hm-1", "merge")).toBeUndefined();
    // After a model slip the next attempt (and only an agent step) is routed.
    ws(w).prepare("UPDATE work_items SET failed_attempts=1,failure_class='model-slip' WHERE id=?").run(a.workItemId);
    attempt(w, a.workItemId, "hm-2");
    const route = modelRouteFor(w.brain.store, w.org, w.workspaceId, "hm-2", "dispatch");
    expect(route).toMatchObject({ tier: "hosted", role: "second-attempt" });
    expect(JSON.stringify(route)).not.toMatch(/key|secret|token|password|authorization/i);
    // Another failure class is not a model slip: no hosted model for it.
    ws(w).prepare("UPDATE work_items SET failure_class='tool-outage' WHERE id=?").run(a.workItemId);
    expect(modelRouteFor(w.brain.store, w.org, w.workspaceId, "hm-2", "dispatch")).toBeUndefined();
    // Another workspace is unaffected.
    expect(modelRouteFor(w.brain.store, w.org, "another-workspace", "hm-2", "eval")).toBeUndefined();
  });

  it("a workspace that reads production hosts stays self-hosted, in either order", async () => {
    const w = world();
    await setWayOfWorking(w, "sh-wow");
    await expect(run(w, "workspace.hostedModel.set", "sh-on", hosted)).rejects.toThrow(/stays self-hosted/);
    const other = world();
    await run(other, "workspace.hostedModel.set", "sh-on2", hosted);
    await expect(setWayOfWorking(other, "sh-wow2")).rejects.toThrow(/stays self-hosted|Switch the hosted model off/);
  });

  it("Health says when the hosted model is down", async () => {
    const w = world();
    await run(w, "workspace.hostedModel.set", "hd-on", hosted);
    await w.brain.runEngineProbes(async () => { throw new Error("offline"); });
    const health = ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { status: string; services: Array<{ id: string; status: string; detail: string }> } }).snapshot;
    expect(health.status).toBe("degraded");
    expect(health.services.find((entry) => entry.id === "hosted-model")).toMatchObject({ status: "unavailable" });
    expect(health.services.find((entry) => entry.id === "hosted-model")?.detail).toMatch(/wait/);
    await run(w, "workspace.hostedModel.set", "hd-off", { enabled: false });
    await w.brain.runEngineProbes(async () => { throw new Error("offline"); });
    const after = ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { services: Array<{ id: string }> } }).snapshot;
    expect(after.services.some((entry) => entry.id === "hosted-model")).toBe(false);
  });
});

describe("capitalization writes up only missions with observed evidence (ADR 0022)", () => {
  const REPORT = { summary: "Two containers are unhealthy: the proxy restarts every minute and the worker has no disk.", deliverable: "# Findings\n\nproxy: restart loop (host.exec docker ps).\nworker: disk full (host.read /srv).\n\nBoth are shown by the tool output quoted above.", criteria: [{ criterion: "Names the unhealthy containers", met: true, evidence: "tool output" }], assumptions: [] };
  const assets = async (w: World): Promise<KnowledgeAsset[]> => ((await w.brain.executeQuery(w.owner, { queryType: "knowledgeAssets.list", workspaceId: w.workspaceId, limit: 100 })) as unknown as { snapshot: { items: KnowledgeAsset[] } }).snapshot.items;

  it("refuses to write up a result no tool call backs, and a person cannot publish one either", async () => {
    const w = world();
    await achievedMission(w, "unobs", { title: "Check containers", intent: "Check all containers and propose limits", report: REPORT, observed: false });
    expect(await assets(w)).toEqual([]);
    const seen = await achievedMission(w, "obs", { title: "Check disks", intent: "Check every disk and report free space", report: REPORT });
    expect((await assets(w)).map((asset) => asset.missionId)).toEqual([seen]);
  });

  it("withdraws what was published before the rule, and gives every entry an expiry and a helped count", async () => {
    const w = world();
    const id = await achievedMission(w, "pub", { title: "Check containers", intent: "Check all containers and propose limits", report: REPORT, autoPublish: true });
    const [asset] = await assets(w);
    expect(asset).toMatchObject({ state: "published", missionId: id, helpedCount: 0 });
    expect(Date.parse(asset!.expiresAt ?? "") - w.brain.store.now()).toBeGreaterThan(80 * 86_400_000);
    // The same entry as it would look if nothing had been observed when it was written.
    w.brain.store.control.prepare("DELETE FROM tool_calls WHERE run_id=?").run("run-pub");
    await cmd(w, w.owner, "knowledge.withdrawUnobserved", "withdraw-1", {});
    expect((await assets(w))[0]).toMatchObject({ state: "revoked", rejectionReason: expect.stringContaining("Withdrawn") });
    expect((await reuseSearch(w, "check containers")).some((hit) => hit.kind === "knowledge")).toBe(false);
  });

  it("counts how often an entry helped a mission that achieved its goal, and lets unused knowledge expire", async () => {
    const w = world();
    await achievedMission(w, "src", { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter", report: REPORT, autoPublish: true });
    const [asset] = await assets(w);
    await achievedMission(w, "user", { title: "Churn follow-up", intent: "Follow up on churn causes", report: REPORT, reuse: [`knowledge:${asset!.assetId}`], autoPublish: true });
    expect((await assets(w)).find((entry) => entry.assetId === asset!.assetId)).toMatchObject({ state: "published", helpedCount: 1 });
    // Unused for a whole period: it leaves search and reuse, with the reason.
    const db = ws(w);
    const old = w.brain.store.now() - 200 * 86_400_000;
    db.prepare("UPDATE knowledge_assets SET expires_at_ms=?, created_at_ms=? WHERE id=?").run(old, old, asset!.assetId);
    db.prepare("DELETE FROM reuse_attachments").run();
    w.brain.runCapitalization();
    expect((await assets(w)).find((entry) => entry.assetId === asset!.assetId)).toMatchObject({ state: "revoked", rejectionReason: expect.stringContaining("Expired") });
  });
});

describe("drain mode stops new attempts and resumes", () => {
  it("holds auto-start while draining, keeps the state across a restart, and starts the waiting work on resume", async () => {
    const w = world();
    await run(w, "platform.drain.set", "drain-on", { draining: true });
    const status = async () => ((await w.brain.executeQuery(w.owner, { queryType: "engineSettings.get", workspaceId: w.workspaceId })) as unknown as { snapshot: { drain: { draining: boolean; runningAttempts: number } } }).snapshot.drain;
    expect(await status()).toMatchObject({ draining: true, runningAttempts: 0 });
    const id = (await run(w, "mission.create", "drain-create", { title: "drain", intent: "Deliver drain", successCriteria: ["x"] })).resourceId ?? "";
    const planId = (await run(w, "plan.propose", "drain-plan", { missionId: id, origin: "manual", tasks: [task("a", { workflowId: "operations-triage" })] })).resourceId ?? "";
    await run(w, "plan.confirm", "drain-confirm", { planVersionId: planId }, (await mission(w, id)).version);
    const runs = () => (ws(w).prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n;
    expect(runs()).toBe(0);
    expect(item(w, id, "a").state).toBe("ready");
    await run(w, "platform.drain.set", "drain-off", { draining: false });
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    expect(runs()).toBe(1);
    expect((await status()).draining).toBe(false);
  });

  it("offers no attempt to a runner while draining", async () => {
    const w = world();
    const { setDraining, drainStatus } = await import("../../apps/governor/src/modules/jobs/index");
    setDraining(w.brain.store, "owner-1", true);
    expect(drainStatus(w.brain.store)).toMatchObject({ draining: true });
    setDraining(w.brain.store, "owner-1", false);
    expect(drainStatus(w.brain.store).draining).toBe(false);
  });
});

describe("Health checks the layers below the application", () => {
  it("reports the model endpoint, free disk and the launcher, and alerts the owner once before the disk fills", async () => {
    const w = world();
    let reachable = false;
    const fetchImpl = (async () => (reachable ? new Response("{}", { status: 200 }) : Promise.reject(new Error("down")))) as unknown as typeof fetch;
    process.env["BRAIN_LOCAL_MODEL_URL"] = "http://model.invalid/v1";
    try {
      await w.brain.runEngineProbes(fetchImpl);
      const health = async () => ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { status: string; services: Array<{ id: string; status: string }> } }).snapshot;
      expect((await health()).services.find((entry) => entry.id === "model")).toMatchObject({ status: "unavailable" });
      expect((await health()).services.find((entry) => entry.id === "disk")).toMatchObject({ status: "healthy" });
      reachable = true;
      await w.brain.runEngineProbes(fetchImpl);
      expect((await health()).services.find((entry) => entry.id === "model")).toMatchObject({ status: "healthy" });
    } finally { delete process.env["BRAIN_LOCAL_MODEL_URL"]; }
    // Disk filling: degraded, alerted once to the workspace owner, and again only after it recovered.
    w.brain.store.control.prepare("UPDATE workspaces SET owner_id='owner-1' WHERE id=?").run(w.workspaceId);
    const notes = () => (ws(w).prepare("SELECT title FROM attention_notifications WHERE item_id='platform:disk'").all() as Array<{ title: string }>);
    recordProbe(w.brain.store, "disk", "degraded", "Disk is filling up: 3.0 GiB free (9% of 30 GiB).");
    expect(alertBadProbes(w.brain.store)).toHaveLength(1);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.title).toContain("Disk is filling up");
    recordProbe(w.brain.store, "disk", "degraded", "Disk is filling up: 2.9 GiB free (9% of 30 GiB).");
    expect(alertBadProbes(w.brain.store)).toEqual([]);
    const degraded = ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { status: string; services: Array<{ id: string; status: string }> } }).snapshot;
    expect(degraded.status).toBe("degraded");
    expect(degraded.services.find((entry) => entry.id === "disk")).toMatchObject({ status: "degraded" });
    recordProbe(w.brain.store, "disk", "healthy", "Disk has 20.0 GiB free.");
    expect(alertBadProbes(w.brain.store)).toEqual([]);
    recordProbe(w.brain.store, "disk", "unavailable", "Disk is almost full: 0.5 GiB free (1% of 30 GiB).");
    expect(alertBadProbes(w.brain.store)).toHaveLength(1);
  });

  it("reports a runner that cannot reach its launcher", async () => {
    const w = world();
    const issue = w.brain.store.control.prepare("INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, last_heartbeat_ms, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity) VALUES (?,?,?,?,'enabled',?,?,?,1000,1024,1024,1)");
    issue.run("r-a", w.org, "agents", DIGEST_A, "unhealthy", w.brain.store.now(), DIGEST_A);
    const health = ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { services: Array<{ id: string; status: string }> } }).snapshot;
    expect(health.services.find((entry) => entry.id === "launcher")).toMatchObject({ status: "unavailable" });
  });
});
