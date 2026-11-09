import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, JsonValue, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { setupWorld, DIGEST_A } from "../helpers";
import { fixtureStarter } from "../support/starter";

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const items = (w: World, missionId: string): WorkItem[] => {
  const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
  return (db.prepare("SELECT id FROM work_items WHERE mission_id=? ORDER BY plan_task_id").all(missionId) as Array<{ id: string }>)
    .map((row) => w.brain.missions.query(w.owner, "workItems.get", w.workspaceId, row.id) as unknown as WorkItem);
};
const item = (w: World, missionId: string, taskId: string) => items(w, missionId).find((entry) => entry.planTaskId === taskId)!;
const runsOf = (w: World, workItemId: string) => (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").all(workItemId) as Array<{ run_id: string }>).map((row) => row.run_id);
const runCount = (w: World) => (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n;

const triage = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [], workflowId: "triage-single", ...extra });

/** The starter triage workflow without its independent evaluator step: one job, so a test can finish the run by itself. */
function singleStepTriage(documents: ReadonlyArray<{ path: string; text: string }>): { path: string; text: string } {
  const source = documents.find((doc) => doc.path.endsWith("operations-triage.yaml"))!;
  const workflow = JSON.parse(source.text);
  workflow.metadata.id = "triage-single";
  delete workflow.spec.jobs["validate"];
  workflow.spec.outputs["passed"] = { source: "literal", value: true };
  return { path: "config/triage-single.yaml", text: JSON.stringify(workflow, null, 2) + "\n" };
}

function world(): World {
  const w = setupWorld();
  const bundle = fixtureStarter();
  bundle.documents.push(singleStepTriage(bundle.documents));
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  worlds.push(w);
  return w;
}

/** A mission with a confirmed plan; auto-start (default on) runs as part of the confirm. */
async function confirmed(w: World, key: string, tasks: PlanTask[], extra: Record<string, unknown> = {}): Promise<string> {
  const id = (await run(w, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], ...extra })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  return id;
}

/** The run finished: its only job reports success once the engine has admitted it. */
async function finishRun(w: World, runId: string): Promise<void> {
  const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`run did not progress: ${JSON.stringify([db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId), db.prepare("SELECT step_id,state FROM workflow_steps WHERE run_id=?").all(runId)])}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await until(() => Boolean(w.brain.store.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(runId)));
  w.brain.workflows.completeStep(w.org, w.workspaceId, runId, "respond", { summary: "Triaged", blockers: [], nextActions: [] } as JsonValue, true);
  await until(() => (db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state === "succeeded");
}

function verifiedEvidence(w: World, digest: string, criteria: string[]): void {
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const manifest = {
    contractVersion: "brain.evidence/v1", bundleId: `bundle-${digest.slice(7, 12)}`, organizationId: w.org, workspaceId: w.workspaceId,
    workflowRunId: "run-seed", jobId: "job-seed", attemptId: "att-seed", jobFence: 1, sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A,
    primitiveVersions: {}, toolReleases: [], artifacts: [], checks: criteria.map((criterionId) => ({ criterionId, checkId: `c-${criterionId}`, status: "passed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" })),
    approvalIds: [], effects: [], createdAt: new Date().toISOString(),
  };
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)").run(digest, manifest.bundleId, "job-seed", "att-seed", JSON.stringify(manifest), w.brain.store.now());
  ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)")
    .run(`verdict-${digest.slice(7, 12)}`, digest, "eval-seed", DIGEST_A, JSON.stringify({ checks: [], acceptedBy: "owner-1" }), w.brain.store.now());
}

describe("auto-start (ADR 0004: the Governor reacts to events and dispatches bounded runs)", () => {
  it("is on by default and starts every ready task that has a workflow and valid input on plan.confirm", async () => {
    const w = world();
    const id = await confirmed(w, "auto", [triage("a"), triage("b"), triage("c", { dependsOn: ["a"] })]);
    expect((await mission(w, id)).autoStart).toBe(true);
    for (const task of ["a", "b"]) {
      const started = item(w, id, task);
      expect(started.state).toBe("in-progress");
      expect(runsOf(w, started.workItemId)).toHaveLength(1);
    }
    expect(item(w, id, "c").state).toBe("backlog");
    expect(runCount(w)).toBe(2);
    // Replaying the sweep never starts a second run for the same work.
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    expect(runCount(w)).toBe(2);
  });

  it("leaves tasks without a workflow or with unsatisfiable input ready, with a visible next action, and invents no input", async () => {
    const w = world();
    const id = await confirmed(w, "needs-input", [
      { id: "bare", title: "No workflow", criteria: ["x"], dependsOn: [] },
      triage("wrong-shape", { workflowId: "support-draft" }),
      triage("ghost", { workflowId: "not-in-release" }),
    ]);
    for (const task of ["bare", "wrong-shape", "ghost"]) {
      const waiting = item(w, id, task);
      expect(waiting.state).toBe("ready");
      expect(waiting.nextAction).toMatch(/^Needs input before it can start/);
      expect(runsOf(w, waiting.workItemId)).toHaveLength(0);
    }
    expect(runCount(w)).toBe(0);
    // Noting a blocker is advice, not a state change: the version is untouched so edits are not made stale.
    expect(item(w, id, "bare").version).toBe(1);
  });

  it("starts nothing in manual mode (ask me before each task) until the switch is turned on", async () => {
    const w = world();
    const id = await confirmed(w, "manual", [triage("a"), triage("b")], { autoStart: false });
    expect((await mission(w, id)).autoStart).toBe(false);
    expect(items(w, id).map((entry) => [entry.state, entry.nextAction])).toEqual([["ready", "Start this task"], ["ready", "Start this task"]]);
    expect(runCount(w)).toBe(0);
    await run(w, "mission.policy.set", "manual-on", { missionId: id, autoStart: true }, (await mission(w, id)).version);
    expect((await mission(w, id)).autoStart).toBe(true);
    expect(items(w, id).map((entry) => entry.state)).toEqual(["in-progress", "in-progress"]);
  });

  it("switching auto-start off restores the plain prompt on notes it left", async () => {
    const w = world();
    const id = await confirmed(w, "off", [{ id: "bare", title: "No workflow", criteria: ["x"], dependsOn: [] }]);
    expect(item(w, id, "bare").nextAction).toMatch(/^Needs input/);
    await run(w, "mission.policy.set", "off-set", { missionId: id, autoStart: false }, (await mission(w, id)).version);
    expect(item(w, id, "bare").nextAction).toBe("Start this task");
    expect((await mission(w, id)).autonomyPolicy.version).toBe(1);
  });

  it("moves in-progress work to review when its run succeeds, and Done still requires verified evidence", async () => {
    const w = world();
    const id = await confirmed(w, "success", [triage("a")]);
    const started = item(w, id, "a");
    expect(started.state).toBe("in-progress");
    await finishRun(w, runsOf(w, started.workItemId)[0]!);
    const reviewing = item(w, id, "a");
    expect(reviewing.state).toBe("review");
    expect(reviewing.nextAction).toMatch(/review the results/i);
    await expect(run(w, "workItem.transition", "success-done", { workItemId: reviewing.workItemId, state: "done" }, reviewing.version)).rejects.toThrow(/evidence/i);
    verifiedEvidence(w, `sha256:${"e".repeat(64)}`, ["a-done"]);
    await run(w, "workItem.transition", "success-done-ok", { workItemId: reviewing.workItemId, state: "done", evidenceDigest: `sha256:${"e".repeat(64)}` }, reviewing.version);
    expect(item(w, id, "a").state).toBe("done");
  });

  it("starts a dependent when its dependency becomes Done", async () => {
    const w = world();
    const id = await confirmed(w, "chain", [triage("a"), triage("b", { dependsOn: ["a"] })]);
    expect(item(w, id, "b").state).toBe("backlog");
    await finishRun(w, runsOf(w, item(w, id, "a").workItemId)[0]!);
    // Review is not Done: the dependent keeps waiting.
    expect(item(w, id, "b").state).toBe("backlog");
    verifiedEvidence(w, `sha256:${"d".repeat(64)}`, ["a-done"]);
    const reviewing = item(w, id, "a");
    await run(w, "handoff.submit", "chain-handoff", { workItemId: reviewing.workItemId, notes: { summary: "a is complete" } });
    await run(w, "workItem.transition", "chain-done", { workItemId: reviewing.workItemId, state: "done", evidenceDigest: `sha256:${"d".repeat(64)}` }, reviewing.version);
    expect(item(w, id, "b").state).toBe("in-progress");
    expect(runsOf(w, item(w, id, "b").workItemId)).toHaveLength(1);
  });

  it("does not unlock a dependent into a run in manual mode", async () => {
    const w = world();
    const id = await confirmed(w, "chain-manual", [triage("a"), triage("b", { dependsOn: ["a"] })], { autoStart: false });
    const a = item(w, id, "a");
    w.brain.missions.linkExecution(w.owner, w.workspaceId, a.workItemId, "run-manual-a");
    await run(w, "workItem.transition", "cm-review", { workItemId: a.workItemId, state: "review" }, item(w, id, "a").version);
    verifiedEvidence(w, `sha256:${"c".repeat(64)}`, ["a-done"]);
    await run(w, "handoff.submit", "cm-handoff", { workItemId: a.workItemId, notes: { summary: "a is complete" } });
    await run(w, "workItem.transition", "cm-done", { workItemId: a.workItemId, state: "done", evidenceDigest: `sha256:${"c".repeat(64)}` }, item(w, id, "a").version);
    expect(item(w, id, "b").state).toBe("ready");
    expect(runCount(w)).toBe(0);
  });

  it("holds new starts while the budget has no headroom and starts once it is raised", async () => {
    const w = world();
    const id = await confirmed(w, "budget", [triage("a")], { budget: { maxMicroUsd: 10, memberCap: 3, attemptReserveMicroUsd: 50 } });
    const held = item(w, id, "a");
    expect(held.state).toBe("ready");
    expect(held.nextAction).toMatch(/^Waiting for budget/);
    expect(runCount(w)).toBe(0);
    await run(w, "mission.budget.set", "budget-raise", { missionId: id, budget: { maxMicroUsd: 1000, memberCap: 3, attemptReserveMicroUsd: 50 } }, (await mission(w, id)).version);
    expect(item(w, id, "a").state).toBe("in-progress");
  });

  it("bounds in-progress work by the member cap and starts the next task when a run finishes", async () => {
    const w = world();
    const id = await confirmed(w, "cap", [triage("a"), triage("b")], { budget: { memberCap: 1 } });
    const states = () => items(w, id).map((entry) => entry.state);
    expect(states()).toEqual(["in-progress", "ready"]);
    expect(item(w, id, "b").nextAction).toMatch(/^Waiting for a free member/);
    await finishRun(w, runsOf(w, item(w, id, "a").workItemId)[0]!);
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    expect(states()).toEqual(["review", "in-progress"]);
  });

  it("starts nothing for a paused mission", async () => {
    const w = world();
    const id = (await run(w, "mission.create", "paused-create", { title: "paused", intent: "p", successCriteria: ["x"] })).resourceId ?? "";
    await run(w, "mission.pause", "paused-pause", { missionId: id }, (await mission(w, id)).version);
    const planId = (await run(w, "plan.propose", "paused-plan", { missionId: id, origin: "manual", tasks: [triage("a")] })).resourceId ?? "";
    await run(w, "plan.confirm", "paused-confirm", { planVersionId: planId }, (await mission(w, id)).version);
    expect(item(w, id, "a").state).toBe("ready");
    expect(runCount(w)).toBe(0);
    await run(w, "mission.resume", "paused-resume", { missionId: id }, (await mission(w, id)).version);
    expect(item(w, id, "a").state).toBe("in-progress");
  });
});
