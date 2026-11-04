import { describe, expect, it } from "vitest";
import type { CommandReceipt, WorkItem } from "@brain/contracts";
import { setupWorld, DIGEST_A } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}

/** One work item with the given criteria, materialized through the canonical plan path. */
async function createWorkItem(w: World, key: string, criteria: string[]): Promise<WorkItem> {
  const objectiveId = (await run(w, "objective.create", `${key}-obj`, { title: key, intent: "board test", successCriteria: ["done well"] })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", `${key}-plan`, {
    objectiveId, origin: "agent", summary: "single task",
    tasks: [{ id: "task", title: key, criteria, dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }],
  })).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, 1);
  const listed = (await w.brain.executeQuery(w.owner, { queryType: "board.get", workspaceId: w.workspaceId })) as { snapshot: { items: WorkItem[] } };
  return listed.snapshot.items.find((item) => item.title === key)!;
}

async function transition(w: World, key: string, workItemId: string, state: string, version: number, evidenceDigest?: string) {
  return await run(w, "workItem.transition", key, { workItemId, state, ...(evidenceDigest ? { evidenceDigest } : {}) }, version);
}

function seedBundle(w: World, digest: string, state: string, checks: Array<{ criterionId: string; checkId: string; status: string }>): void {
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const manifest = {
    contractVersion: "brain.evidence/v1", bundleId: `bundle-${digest.slice(7, 12)}`, organizationId: w.org, workspaceId: w.workspaceId,
    workflowRunId: "run-board", jobId: "job-board", attemptId: "att-board", jobFence: 1,
    sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A, primitiveVersions: {}, toolReleases: [],
    artifacts: [], checks: checks.map((c) => ({ ...c, oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" })),
    approvalIds: [], effects: [], createdAt: new Date().toISOString(),
  };
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,? ,?,?,?)")
    .run(digest, manifest.bundleId, "job-board", "att-board", state, JSON.stringify(manifest), w.brain.store.now());
  if (state === "verified") {
    ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)")
      .run(`verdict-${digest.slice(7, 12)}`, digest, "eval-board", DIGEST_A, JSON.stringify({ checks: [], acceptedBy: "owner-1" }), w.brain.store.now());
  }
}

const D = (ch: string) => `sha256:${ch.repeat(64)}`;

describe("work item Done requires explicit verified criterion evidence (T31/T37)", () => {
  it("binds a work item to a verified bundle only when every criterion passed", async () => {
    const w = setupWorld();
    const item = await createWorkItem(w, "work-1", ["echo", "bytes"]);
    expect(item.state).toBe("ready");
    // ready -> done is not a legal transition; the path runs through in-progress and review.
    await expect(Promise.resolve().then(async () => await transition(w, "t-skip", item.workItemId, "done", item.version))).rejects.toThrow(/illegal transition/i);
    await transition(w, "t-start", item.workItemId, "in-progress", item.version);
    const started = (await w.brain.executeQuery(w.owner, { queryType: "workItems.get", workspaceId: w.workspaceId, resourceId: item.workItemId })) as { snapshot: WorkItem };
    expect(started.snapshot.state).toBe("in-progress");
    await transition(w, "t-review", item.workItemId, "review", started.snapshot.version);
    const reviewing = (await w.brain.executeQuery(w.owner, { queryType: "workItems.get", workspaceId: w.workspaceId, resourceId: item.workItemId })) as { snapshot: WorkItem };
    const reviewVersion = reviewing.snapshot.version;
    await expect(Promise.resolve().then(async () => await transition(w, "t-noev", item.workItemId, "done", reviewVersion))).rejects.toThrow(/evidence/i);
    await expect(Promise.resolve().then(async () => await transition(w, "t-unknown", item.workItemId, "done", reviewVersion, D("f")))).rejects.toThrow(/verified/i);
    seedBundle(w, D("a"), "submitted", [{ criterionId: "echo", checkId: "c1", status: "passed" }, { criterionId: "bytes", checkId: "c2", status: "passed" }]);
    await expect(Promise.resolve().then(async () => await transition(w, "t-unverified", item.workItemId, "done", reviewVersion, D("a")))).rejects.toThrow(/verified/i);
    seedBundle(w, D("b"), "verified", [{ criterionId: "echo", checkId: "c1", status: "passed" }]);
    await expect(Promise.resolve().then(async () => await transition(w, "t-partial", item.workItemId, "done", reviewVersion, D("b")))).rejects.toThrow(/criter/);
    seedBundle(w, D("c"), "verified", [{ criterionId: "echo", checkId: "c1", status: "passed" }, { criterionId: "bytes", checkId: "c2", status: "failed" }]);
    await expect(Promise.resolve().then(async () => await transition(w, "t-failed", item.workItemId, "done", reviewVersion, D("c")))).rejects.toThrow(/criter/);
    seedBundle(w, D("d"), "verified", [{ criterionId: "echo", checkId: "c1", status: "passed" }, { criterionId: "bytes", checkId: "c2", status: "passed" }]);
    const listed = w.brain.listVerifiedEvidence(w.owner, w.workspaceId) as { items: { digest: string; passedCriteria: string[] }[] };
    expect(listed.items.find((bundle) => bundle.digest === D("d"))?.passedCriteria).toEqual(["echo", "bytes"]);
    await transition(w, "t-done", item.workItemId, "done", reviewVersion, D("d"));
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const row = ws.prepare("SELECT state, evidence_digest FROM work_items WHERE id=?").get(item.workItemId) as { state: string; evidence_digest: string };
    expect(row.state).toBe("done");
    expect(row.evidence_digest).toBe(D("d"));
    w.brain.close();
  });

  it("concurrent comments from two actors both land; missing work item is NOT_FOUND (T31)", async () => {
    const w = setupWorld();
    const item = await createWorkItem(w, "work-comments", ["c1"]);
    const comment = async (actor: World["owner"], key: string, text: string, target = item.workItemId) => await w.brain.executeCommand(actor, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workItem.comment",
      workspaceId: w.workspaceId, idempotencyKey: key, payload: { workItemId: target, text },
    } as never, key);
    const other = w.actor("owner-1", w.workspaceId);
    await comment(w.owner, "cmt-1", "first note");
    await comment(other, "cmt-2", "second note");
    // Idempotent replay of the first comment does not duplicate it.
    await comment(w.owner, "cmt-1", "first note");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const rows = ws.prepare("SELECT body FROM work_item_comments WHERE work_item_id=? ORDER BY created_at_ms, id").all(item.workItemId) as Array<{ body: string }>;
    expect(rows.map((r) => r.body)).toEqual(["first note", "second note"]);
    await expect(Promise.resolve().then(async () => await comment(w.owner, "cmt-3", "orphan", "work-missing"))).rejects.toThrow(/not found/i);
    w.brain.close();
  });
});
