import { describe, expect, it } from "vitest";
import type { CommandReceipt, Objective, PlanTask, PlanVersion, BoardView } from "@brain/contracts";
import { setupWorld, DIGEST_A } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}

async function objective(w: World): Promise<string> {
  return (await run(w, "objective.create", "objective-1", { title: "Stabilize authentication", intent: "Find and fix session failures", successCriteria: ["Sessions remain valid"] })).resourceId ?? "";
}

async function propose(w: World, objectiveId: string, key = "plan-1", tasks?: PlanTask[]): Promise<string> {
  return (await run(w, "plan.propose", key, {
    objectiveId, origin: "agent", summary: "Investigate before changing code",
    tasks: tasks ?? [
      { id: "audit", title: "Audit sessions", criteria: ["audit-complete"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } },
      { id: "fix", title: "Fix session handling", criteria: ["fix-verified"], dependsOn: ["audit"], workflowId: "fixture-workflow" },
      { id: "review", title: "Review the result", criteria: ["review-complete"], dependsOn: ["fix"], assignment: { kind: "agent", id: "claude", role: "reviewer" } },
    ],
  })).resourceId ?? "";
}

async function board(w: World): Promise<BoardView> {
  return ((await w.brain.executeQuery(w.owner, { queryType: "board.get", workspaceId: w.workspaceId })) as { snapshot: BoardView }).snapshot;
}

function seedEvidence(w: World, criteria: string[]): void {
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const manifest = { workflowRunId: "run-work", checks: criteria.map((criterionId) => ({ criterionId, status: "passed" })) };
  ws.prepare("INSERT INTO evidence_bundles(digest,bundle_id,job_id,attempt_id,state,manifest_json,created_at_ms) VALUES (?,?,?,?,'verified',?,?)")
    .run(DIGEST_A, "bundle-work", "job-work", "attempt-work", JSON.stringify(manifest), w.brain.store.now());
  ws.prepare("INSERT INTO verification_verdicts(id,bundle_digest,evaluator_attempt_id,evaluator_digest,outcome,manifest_json,created_at_ms) VALUES (?,?,?,?,'verified',?,?)")
    .run("verdict-work", DIGEST_A, "evaluator-work", DIGEST_A, "{}", w.brain.store.now());
}

describe("Objective -> PlanVersion -> WorkItem -> Execution", () => {
  it("materializes an approved DAG and advances dependencies only after verified completion", async () => {
    const w = setupWorld();
    const objectiveId = await objective(w);
    const planId = await propose(w, objectiveId);
    await run(w, "plan.confirm", "confirm-1", { planVersionId: planId }, 1);
    const initial = await board(w);
    expect(initial.items.map((item) => item.state)).toEqual(["ready", "backlog", "backlog"]);
    const audit = initial.items.find((item) => item.planTaskId === "audit")!;
    const fix = initial.items.find((item) => item.planTaskId === "fix")!;
    expect(fix.dependsOn).toEqual([audit.workItemId]);
    await expect(Promise.resolve().then(async () => await run(w, "workItem.transition", "fix-early", { workItemId: fix.workItemId, state: "ready" }, 1))).rejects.toThrow(/illegal transition|dependencies/i);

    w.brain.work.linkExecution(w.owner, w.workspaceId, audit.workItemId, "run-audit");
    const linked = await board(w);
    expect(linked.executions).toEqual([expect.objectContaining({ workItemId: audit.workItemId, runId: "run-audit" })]);
    expect(linked.items.find((item) => item.workItemId === audit.workItemId)?.state).toBe("in-progress");
    const currentAudit = linked.items.find((item) => item.workItemId === audit.workItemId)!;
    await run(w, "workItem.transition", "audit-review", { workItemId: audit.workItemId, state: "review" }, currentAudit.version);
    seedEvidence(w, ["audit-complete"]);
    await run(w, "workItem.transition", "audit-done", { workItemId: audit.workItemId, state: "done", evidenceDigest: DIGEST_A }, currentAudit.version + 1);
    expect((await board(w)).items.find((item) => item.planTaskId === "fix")?.state).toBe("ready");
    w.brain.close();
  });

  it("replanning retains unchanged work and history while replacing changed tasks (E102)", async () => {
    const w = setupWorld();
    const objectiveId = await objective(w);
    const firstId = await propose(w, objectiveId);
    await run(w, "plan.confirm", "confirm-1", { planVersionId: firstId }, 1);
    const first = await board(w);
    const audit = first.items.find((item) => item.planTaskId === "audit")!;
    const oldFix = first.items.find((item) => item.planTaskId === "fix")!;
    w.brain.work.linkExecution(w.owner, w.workspaceId, audit.workItemId, "run-original");
    const secondId = await propose(w, objectiveId, "plan-2", [
      { id: "audit", title: "Audit sessions", criteria: ["audit-complete"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } },
      { id: "fix", title: "Fix refresh-token rotation", criteria: ["rotation-verified"], dependsOn: ["audit"] },
    ]);
    await run(w, "plan.confirm", "confirm-2", { planVersionId: secondId }, 2);
    const second = await board(w);
    expect(second.items.find((item) => item.planTaskId === "audit")?.workItemId).toBe(audit.workItemId);
    expect(second.items.find((item) => item.planTaskId === "fix")?.workItemId).not.toBe(oldFix.workItemId);
    expect(second.executions).toEqual([expect.objectContaining({ workItemId: audit.workItemId, runId: "run-original" })]);
    const plan = ((await w.brain.executeQuery(w.owner, { queryType: "plans.get", workspaceId: w.workspaceId, resourceId: firstId })) as { snapshot: PlanVersion }).snapshot;
    expect(plan.state).toBe("superseded");
    const currentObjective = ((await w.brain.executeQuery(w.owner, { queryType: "objectives.get", workspaceId: w.workspaceId, resourceId: objectiveId })) as { snapshot: Objective }).snapshot;
    expect(currentObjective.activePlanVersionId).toBe(secondId);
    w.brain.close();
  });

  it("rejects invalid plans and requires evidence covering every criterion (E103)", async () => {
    const w = setupWorld();
    const objectiveId = await objective(w);
    await expect(Promise.resolve().then(async () => await propose(w, objectiveId, "cycle", [
      { id: "a", title: "A", criteria: ["a-done"], dependsOn: ["b"] },
      { id: "b", title: "B", criteria: ["b-done"], dependsOn: ["a"] },
    ]))).rejects.toThrow(/cycle/i);
    const planId = await propose(w, objectiveId, "single", [{ id: "single", title: "Single", criteria: ["one", "two"], dependsOn: [] }]);
    await run(w, "plan.confirm", "confirm-single", { planVersionId: planId }, 1);
    const item = (await board(w)).items[0]!;
    await run(w, "workItem.transition", "single-progress", { workItemId: item.workItemId, state: "in-progress" }, 1);
    await run(w, "workItem.transition", "single-review", { workItemId: item.workItemId, state: "review" }, 2);
    await expect(Promise.resolve().then(async () => await run(w, "workItem.transition", "single-done", { workItemId: item.workItemId, state: "done" }, 3))).rejects.toThrow(/evidence/i);
    seedEvidence(w, ["one"]);
    await expect(Promise.resolve().then(async () => await run(w, "workItem.transition", "single-partial", { workItemId: item.workItemId, state: "done", evidenceDigest: DIGEST_A }, 3))).rejects.toThrow(/criteria/i);
    w.brain.close();
  });
});
