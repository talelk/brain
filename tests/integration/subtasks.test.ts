import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, Mission, WorkItem } from "@brain/contracts";
import { setupWorld, DIGEST_A } from "../helpers";
import { ownBundleJob } from "../support/evidence";

// Spec #90, story 79 (#131): a work item may have subtasks, proposed inside a plan version. The parent rolls them up (progress and cost) and
// is Done only when every live subtask is Done on its own evidence and the parent has its own (ADR 0022 unchanged). Abandoning a parent with
// open subtasks is refused unless a person takes them with it and says why.
type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });
const world = (): World => { const w = setupWorld(); worlds.push(w); return w; };

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const items = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "workItems.list", workspaceId: w.workspaceId, limit: 100 })) as { snapshot: { items: WorkItem[] } }).snapshot.items;
const byTask = async (w: World, missionId: string): Promise<Record<string, WorkItem>> => Object.fromEntries((await items(w)).filter((item) => item.missionId === missionId && item.state !== "abandoned").map((item) => [item.planTaskId, item]));

interface Task { id: string; parentId?: string; dependsOn?: string[]; title?: string; criteria?: string[] }
const full = (task: Task) => ({ title: `Task ${task.id}`, criteria: [`${task.id}-ok`], dependsOn: [], ...task });

async function propose(w: World, key: string, missionId: string, tasks: Task[]): Promise<CommandReceipt> {
  return run(w, "plan.propose", key, { missionId, origin: "manual", tasks: tasks.map(full) });
}
async function confirmPlan(w: World, key: string, missionId: string, tasks: Task[]): Promise<void> {
  const planId = (await propose(w, `${key}-p`, missionId, tasks)).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-c`, { planVersionId: planId }, (await mission(w, missionId)).version);
}
async function newMission(w: World, key: string, tasks: Task[]): Promise<{ missionId: string; at: () => Promise<Record<string, WorkItem>> }> {
  const missionId = (await run(w, "mission.create", `${key}-m`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], autoStart: false })).resourceId ?? "";
  await confirmPlan(w, key, missionId, tasks);
  return { missionId, at: () => byTask(w, missionId) };
}

function seedBundle(w: World, digest: string, jobId: string, criteria: readonly string[]): void {
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const manifest = {
    contractVersion: "brain.evidence/v1", bundleId: `bundle-${digest.slice(7, 12)}`, organizationId: w.org, workspaceId: w.workspaceId, workflowRunId: "run-sub", jobId, attemptId: `att-${jobId}`, jobFence: 1,
    sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [], artifacts: [],
    checks: criteria.map((criterionId, index) => ({ criterionId, checkId: `c${index}`, status: "passed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" })),
    approvalIds: [], effects: [], createdAt: new Date().toISOString(),
  };
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?,'verified',?,?)").run(digest, manifest.bundleId, jobId, `att-${jobId}`, JSON.stringify(manifest), w.brain.store.now());
  ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)")
    .run(`verdict-${jobId}`, digest, `eval-${jobId}`, DIGEST_A, JSON.stringify({ checks: [], acceptedBy: "owner-1" }), w.brain.store.now());
}

const fresh = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "workItems.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: WorkItem }).snapshot;
const move = async (w: World, key: string, id: string, state: string, extra: Record<string, unknown> = {}) => run(w, "workItem.transition", key, { workItemId: id, state, ...extra }, (await fresh(w, id)).version);

/** Start, review and bind the item's own verified evidence: the Done rule of ADR 0022, one item at a time. */
async function finish(w: World, key: string, item: WorkItem): Promise<void> {
  await move(w, `${key}-start`, item.workItemId, "in-progress");
  await move(w, `${key}-review`, item.workItemId, "review");
  const digest = `sha256:${key.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/gu, "a")}`;
  const jobId = `job-${key}`;
  seedBundle(w, digest, jobId, item.criteria);
  ownBundleJob(w.brain.store.workspaceDb(w.workspaceId, w.org), item.workItemId, jobId, w.brain.store.now());
  await move(w, `${key}-done`, item.workItemId, "done", { evidenceDigest: digest });
}

const PLAN: Task[] = [{ id: "parent" }, { id: "c1", parentId: "parent" }, { id: "c2", parentId: "parent" }, { id: "other" }];

describe("subtasks (#131)", () => {
  it("a plan version names subtasks; each shows its parent and the parent rolls them up", async () => {
    const w = world();
    const { at } = await newMission(w, "roll", PLAN);
    const all = await at();
    expect(all["c1"]).toMatchObject({ parentId: all["parent"]!.workItemId, parentTitle: "Task parent" });
    expect(all["c1"]!.subtasks).toBeUndefined();
    expect(all["parent"]!.parentId).toBeUndefined();
    expect(all["parent"]!.subtasks).toMatchObject({ total: 2, done: 0 });
    expect(all["other"]!.subtasks).toBeUndefined();
    // Priority and tags are per item: the parent's do not reach its subtasks.
    await run(w, "workItem.details.set", "pri", { workItemId: all["parent"]!.workItemId, priority: "urgent", tags: ["release"] }, all["parent"]!.version);
    const after = await at();
    expect(after["parent"]).toMatchObject({ priority: "urgent", tags: ["release"] });
    expect(after["c1"]).toMatchObject({ priority: "normal", tags: [] });
  });

  it("refuses plans whose subtasks cannot finish", async () => {
    const w = world();
    const missionId = (await run(w, "mission.create", "bad-m", { title: "bad", intent: "bad", successCriteria: ["x"], autoStart: false })).resourceId ?? "";
    await expect(propose(w, "unknown", missionId, [{ id: "a", parentId: "ghost" }])).rejects.toThrow(/unknown task ghost/);
    await expect(propose(w, "self", missionId, [{ id: "a", parentId: "a" }])).rejects.toThrow(/own parent/);
    await expect(propose(w, "deep", missionId, [{ id: "a" }, { id: "b", parentId: "a" }, { id: "c", parentId: "b" }])).rejects.toThrow(/itself a subtask/);
    await expect(propose(w, "wait-parent", missionId, [{ id: "a" }, { id: "b", parentId: "a", dependsOn: ["a"] }])).rejects.toThrow(/cannot depend on each other/);
    // x waits for the parent, the parent waits for its subtask, the subtask waits for x.
    await expect(propose(w, "loop", missionId, [{ id: "p" }, { id: "x", dependsOn: ["p"] }, { id: "k", parentId: "p", dependsOn: ["x"] }])).rejects.toThrow(/cycle/);
  });

  it("a parent is not Done until every subtask is Done on evidence, and still needs its own evidence", async () => {
    const w = world();
    const { at } = await newMission(w, "gate", PLAN);
    let all = await at();
    await move(w, "p-start", all["parent"]!.workItemId, "in-progress");
    await move(w, "p-review", all["parent"]!.workItemId, "review");
    const digest = `sha256:${"b".repeat(64)}`;
    seedBundle(w, digest, "job-parent", all["parent"]!.criteria);
    ownBundleJob(w.brain.store.workspaceDb(w.workspaceId, w.org), all["parent"]!.workItemId, "job-parent", w.brain.store.now());
    // The parent's own evidence is fine; its open subtasks are what hold it back.
    await expect(move(w, "p-early", all["parent"]!.workItemId, "done", { evidenceDigest: digest })).rejects.toThrow(/Done waits for its subtasks: Task c1, Task c2/);
    expect((await fresh(w, all["parent"]!.workItemId)).state).toBe("review");

    await finish(w, "c1", all["c1"]!);
    all = await at();
    expect(all["parent"]!.subtasks).toMatchObject({ total: 2, done: 1 });
    await expect(move(w, "p-half", all["parent"]!.workItemId, "done", { evidenceDigest: digest })).rejects.toThrow(/Done waits for its subtask: Task c2/);
    await finish(w, "c2", all["c2"]!);
    expect((await at())["parent"]!.subtasks).toMatchObject({ total: 2, done: 2 });
    // Every subtask Done does not make the parent Done: without evidence of its own it is still refused.
    await expect(move(w, "p-noev", all["parent"]!.workItemId, "done")).rejects.toThrow(/evidence/i);
    await move(w, "p-done", all["parent"]!.workItemId, "done", { evidenceDigest: digest });
    expect((await at())["parent"]!.state).toBe("done");
  });

  it("cost rolls up from the subtasks into the parent and the item's own cost stays its own", async () => {
    const w = world();
    const { missionId, at } = await newMission(w, "cost", PLAN);
    const all = await at();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const spend = (item: WorkItem, micro: number, tokens: number) => {
      const run = `run-${item.planTaskId}`;
      ws.prepare("INSERT INTO execution_links(mission_id,work_item_id,run_id,job_id,created_at_ms) VALUES (?,?,?,?,?)").run(missionId, item.workItemId, run, `job-${item.planTaskId}`, w.brain.store.now());
      ws.prepare("INSERT INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,settled_micro_usd,input_tokens,output_tokens,created_at_ms,settled_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`att-${item.planTaskId}`, missionId, run, 0, micro, tokens, 0, w.brain.store.now(), w.brain.store.now());
    };
    spend(all["parent"]!, 1000, 100); spend(all["c1"]!, 2500, 250); spend(all["c2"]!, 500, 50); spend(all["other"]!, 9000, 900);
    const after = await at();
    expect(after["parent"]!.subtasks).toMatchObject({ settledMicroUsd: 4000, tokensUsed: 400, reservedMicroUsd: 0 });
    expect(after["parent"]!.tokensUsed).toBe(100);
    expect(after["c1"]!.tokensUsed).toBe(250);
    // The mission total counts each attempt once: the roll-up is a view of the parts, not extra spend.
    expect((await mission(w, missionId)).usage.settledMicroUsd).toBe(13000);
  });

  it("a replan keeps finished subtasks, follows a replaced parent and refuses a new subtask under a finished parent", async () => {
    const w = world();
    const { missionId, at } = await newMission(w, "replan", PLAN);
    const first = await at();
    await finish(w, "r1", first["c1"]!);
    // Retitle the (not started) parent: it becomes a new work item and both subtasks follow it, the finished one included.
    await confirmPlan(w, "replan-2", missionId, PLAN.map((task) => task.id === "parent" ? { ...task, title: "Parent renamed" } : task));
    const second = await at();
    expect(second["parent"]!.workItemId).not.toBe(first["parent"]!.workItemId);
    expect(second["c1"]!.workItemId).toBe(first["c1"]!.workItemId);
    expect(second["c1"]!.parentId).toBe(second["parent"]!.workItemId);
    expect(second["c2"]!.parentTitle).toBe("Parent renamed");
    expect(second["parent"]!.subtasks).toMatchObject({ total: 2, done: 1 });
    // A person adds a subtask in a new plan version.
    await confirmPlan(w, "replan-3", missionId, [...PLAN.map((task) => task.id === "parent" ? { ...task, title: "Parent renamed" } : task), { id: "c3", parentId: "parent" }]);
    expect((await at())["parent"]!.subtasks).toMatchObject({ total: 3, done: 1 });
  });

  it("abandoning a parent with open subtasks is refused, or a person takes them with it and gives a reason", async () => {
    const w = world();
    const { at } = await newMission(w, "drop", PLAN);
    let all = await at();
    await finish(w, "d1", all["c1"]!);
    all = await at();
    await expect(move(w, "ab-plain", all["parent"]!.workItemId, "abandoned")).rejects.toThrow(/still has 1 open subtask \(Task c2\)/);
    await expect(move(w, "ab-flag", all["parent"]!.workItemId, "abandoned", { cascade: true })).rejects.toThrow(/needs a reason/);
    await expect(move(w, "ab-wrong", all["other"]!.workItemId, "blocked", { cascade: true, reason: "x" })).rejects.toThrow(/only abandoning/);
    expect((await fresh(w, all["parent"]!.workItemId)).state).not.toBe("abandoned");
    await move(w, "ab-cascade", all["parent"]!.workItemId, "abandoned", { cascade: true, reason: "The release was cancelled" });
    expect((await fresh(w, all["parent"]!.workItemId)).state).toBe("abandoned");
    const c2 = await fresh(w, all["c2"]!.workItemId);
    expect(c2.state).toBe("abandoned");
    expect(c2.nextAction).toBe("Parent abandoned: The release was cancelled");
    // Finished work stays finished: its evidence is not undone by the parent's abandonment.
    expect((await fresh(w, all["c1"]!.workItemId)).state).toBe("done");
  });

  it("a parent whose subtasks are all Done or abandoned can be abandoned without the flag", async () => {
    const w = world();
    const { at } = await newMission(w, "plain", [{ id: "parent" }, { id: "c1", parentId: "parent" }]);
    const all = await at();
    await finish(w, "pl1", all["c1"]!);
    await move(w, "pl-ab", all["parent"]!.workItemId, "abandoned");
    expect((await fresh(w, all["parent"]!.workItemId)).state).toBe("abandoned");
  });

  it("a parent that is already Done takes no new subtask", async () => {
    const w = world();
    const plan: Task[] = [{ id: "parent" }, { id: "c1", parentId: "parent" }];
    const { missionId, at } = await newMission(w, "late", plan);
    const all = await at();
    await finish(w, "l1", all["c1"]!);
    await finish(w, "l2", all["parent"]!);
    await expect(propose(w, "late-add", missionId, [...plan, { id: "c2", parentId: "parent" }])).rejects.toThrow(/already done, so it takes no new subtask c2/);
  });
});
