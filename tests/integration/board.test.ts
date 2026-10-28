import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A } from "../helpers";

type World = ReturnType<typeof setupWorld>;

function createCard(w: World, key: string, criteria: string[]): string {
  const { receipt } = w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "board.create",
    workspaceId: w.workspaceId, idempotencyKey: key, payload: { title: key, criteria },
  }, key);
  return (receipt as { resourceId?: string }).resourceId ?? "";
}

function move(w: World, key: string, cardId: string, status: string, version: number, evidenceDigest?: string) {
  return w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "board.move",
    workspaceId: w.workspaceId, idempotencyKey: key, expectedVersion: version,
    payload: { cardId, status, ...(evidenceDigest ? { evidenceDigest } : {}) },
  }, key);
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

describe("board Done requires explicit verified criterion evidence (T31/T37)", () => {
  it("binds a card to a verified bundle only when every criterion passed", () => {
    const w = setupWorld();
    const cardId = createCard(w, "card-1", ["echo", "bytes"]);
    expect(() => move(w, "m1", cardId, "done", 1)).toThrow(/evidence/i);
    expect(() => move(w, "m2", cardId, "done", 1, D("f"))).toThrow();
    seedBundle(w, D("a"), "submitted", [{ criterionId: "echo", checkId: "c1", status: "passed" }, { criterionId: "bytes", checkId: "c2", status: "passed" }]);
    expect(() => move(w, "m3", cardId, "done", 1, D("a"))).toThrow(/verified/i);
    seedBundle(w, D("b"), "verified", [{ criterionId: "echo", checkId: "c1", status: "passed" }]);
    expect(() => move(w, "m4", cardId, "done", 1, D("b"))).toThrow(/criter/);
    seedBundle(w, D("c"), "verified", [{ criterionId: "echo", checkId: "c1", status: "passed" }, { criterionId: "bytes", checkId: "c2", status: "failed" }]);
    expect(() => move(w, "m5", cardId, "done", 1, D("c"))).toThrow(/criter/);
    seedBundle(w, D("d"), "verified", [{ criterionId: "echo", checkId: "c1", status: "passed" }, { criterionId: "bytes", checkId: "c2", status: "passed" }]);
    move(w, "m6", cardId, "verifying", 1);
    move(w, "m7", cardId, "done", 2, D("d"));
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const card = ws.prepare("SELECT state, evidence_digest FROM cards WHERE id=?").get(cardId) as { state: string; evidence_digest: string };
    expect(card.state).toBe("done");
    expect(card.evidence_digest).toBe(D("d"));
    w.brain.close();
  });

  it("concurrent comments from two actors both land; missing card is NOT_FOUND (T31)", () => {
    const w = setupWorld();
    const cardId = createCard(w, "card-comments", ["c1"]);
    const comment = (actor: World["owner"], key: string, text: string, target = cardId) => w.brain.executeCommand(actor, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "board.comment",
      workspaceId: w.workspaceId, idempotencyKey: key, payload: { cardId: target, text },
    }, key);
    const other = w.actor("owner-1", w.workspaceId);
    comment(w.owner, "cmt-1", "first note");
    comment(other, "cmt-2", "second note");
    // Idempotent replay of the first comment does not duplicate it.
    comment(w.owner, "cmt-1", "first note");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const rows = ws.prepare("SELECT body FROM card_comments WHERE card_id=? ORDER BY created_at_ms, id").all(cardId) as Array<{ body: string }>;
    expect(rows.map((r) => r.body)).toEqual(["first note", "second note"]);
    expect(() => comment(w.owner, "cmt-3", "orphan", "card-missing")).toThrow(/not found/i);
    w.brain.close();
  });
});
