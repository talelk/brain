import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A } from "../helpers";
import { sha256Digest } from "@brain/contracts";

// T44 packet acceptance (local slice): delivery dossiers render rubric
// outcomes deterministically (incomplete is inconclusive, never passed),
// criterion artifacts appear only when the artifact really exists, and
// reading a dossier never transitions its state — recommendation and
// approval stay separate. The optional calibrated judge remains uninstalled.
describe("delivery dossier rubric rendering (T44)", () => {
  it("maps rubric outcomes faithfully and never auto-advances state", () => {
    const w = setupWorld();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const now = w.brain.store.now();
    ws.prepare("INSERT INTO delivery_dossiers(id, source_revision, manifest_digest, rubric_digest, state, version, created_at_ms) VALUES ('dos-9',?,?,?,'evaluating',2,?)")
      .run("sha256:" + "4".repeat(64), DIGEST_A, DIGEST_A, now);
    ws.prepare("INSERT INTO rubric_results(dossier_id, criterion_id, evaluator_attempt_id, outcome, evidence_digest) VALUES ('dos-9','tests-pass','att-e','passed',?)").run(DIGEST_A);
    ws.prepare("INSERT INTO rubric_results(dossier_id, criterion_id, evaluator_attempt_id, outcome, evidence_digest) VALUES ('dos-9','docs-complete','att-e','incomplete',?)").run(DIGEST_A);
    ws.prepare("INSERT INTO rubric_results(dossier_id, criterion_id, evaluator_attempt_id, outcome, evidence_digest) VALUES ('dos-9','no-secrets','att-e','failed',?)").run(DIGEST_A);

    const res = w.brain.executeQuery(w.owner, { queryType: "delivery.get", workspaceId: w.workspaceId, resourceId: "dos-9" }) as unknown as {
      snapshot: { state: string; criteria: Array<{ criterionId: string; status: string; artifacts: unknown[] }>; rubric: { digest: string } };
    };
    const byId = Object.fromEntries(res.snapshot.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId).toEqual({ "tests-pass": "passed", "docs-complete": "inconclusive", "no-secrets": "failed" });
    // No artifact rows exist for the evidence digest: nothing is fabricated.
    for (const c of res.snapshot.criteria) expect(c.artifacts).toEqual([]);
    expect(res.snapshot.rubric.digest).toBe(DIGEST_A);
    // The read did not move the dossier.
    expect((ws.prepare("SELECT state, version FROM delivery_dossiers WHERE id='dos-9'").get() as { state: string; version: number })).toEqual({ state: "evaluating", version: 2 });
    w.brain.close();
  });
});

describe("delivery dossier lifecycle (T44)", () => {
  it("verifies only when every criterion passed; failures reject; finalized is immutable", () => {
    const w = setupWorld();
    const uploadEvidence = (text: string) => {
      const bytes = Buffer.from(text, "utf8");
      const digest = sha256Digest(bytes);
      const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
      return (w.brain.putUpload(w.owner, up.uploadId, bytes) as unknown as { digest: string }).digest;
    };
    const evidence = uploadEvidence("rubric evidence");
    const dossier = w.brain.createDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, sourceRevision: "abc123", manifestDigest: DIGEST_A, rubricDigest: DIGEST_A });
    // Draft (no results yet) cannot be finalized.
    expect(() => w.brain.finalizeDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, expectedVersion: 1 })).toThrow(/only evaluating/);
    // Results require a real evidence artifact.
    expect(() => w.brain.recordRubricResult({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, criterionId: "c0", evaluatorAttemptId: "att-0", outcome: "passed", evidenceDigest: DIGEST_A })).toThrow(/evidence artifact/);
    w.brain.recordRubricResult({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, criterionId: "c1", evaluatorAttemptId: "att-1", outcome: "passed", evidenceDigest: evidence });
    w.brain.recordRubricResult({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, criterionId: "c2", evaluatorAttemptId: "att-2", outcome: "passed", evidenceDigest: evidence });
    expect(w.brain.finalizeDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, expectedVersion: 2 })).toEqual({ state: "verified" });
    expect(() => w.brain.finalizeDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, expectedVersion: 3 })).toThrow(/only evaluating/);
    expect(() => w.brain.recordRubricResult({ actor: w.owner, workspaceId: w.workspaceId, dossierId: dossier.dossierId, criterionId: "c3", evaluatorAttemptId: "att-3", outcome: "passed", evidenceDigest: evidence })).toThrow(/finalized/);

    const failing = w.brain.createDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, sourceRevision: "def456", manifestDigest: DIGEST_A, rubricDigest: DIGEST_A });
    w.brain.recordRubricResult({ actor: w.owner, workspaceId: w.workspaceId, dossierId: failing.dossierId, criterionId: "c1", evaluatorAttemptId: "att-9", outcome: "incomplete", evidenceDigest: evidence });
    expect(w.brain.finalizeDeliveryDossier({ actor: w.owner, workspaceId: w.workspaceId, dossierId: failing.dossierId, expectedVersion: 2 })).toEqual({ state: "rejected" });
    w.brain.close();
  }, 120_000);
});
