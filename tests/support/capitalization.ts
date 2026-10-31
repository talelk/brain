import { domainDigest, type EvidenceBundle, type JsonValue, type ReleaseRef } from "../../packages/contracts/src/index";
import type { Brain } from "../../apps/governor/src/application/brain";

export interface CapitalizationWorld { brain: Brain; org: string; workspaceId: string }

export function verifiedEvidence(world: CapitalizationWorld, rootRunId: string): string {
  const release = world.brain.activeRelease(world.org)!;
  const bundle: EvidenceBundle = {
    contractVersion: "brain.evidence/v1", bundleId: `bundle-${rootRunId}`, organizationId: world.org,
    workspaceId: world.workspaceId, workflowRunId: rootRunId, jobId: `job-${rootRunId}`, attemptId: `attempt-${rootRunId}`,
    jobFence: 1, sourceRevision: "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4",
    configDigest: release.digest, workflowDigest: domainDigest("brain:test-workflow:v1", { rootRunId }), primitiveVersions: {},
    toolReleases: [], artifacts: [], checks: [{ criterionId: "operation", checkId: "verified-operation", status: "passed", oracleDigest: release.digest, artifacts: [], detail: "verified fixture operation" }],
    approvalIds: [], effects: [], createdAt: world.brain.store.nowIso(),
  };
  const digest = domainDigest("brain:evidence-bundle:v1", bundle as unknown as JsonValue);
  const db = world.brain.store.workspaceDb(world.workspaceId, world.org);
  db.prepare("INSERT INTO evidence_bundles(digest,bundle_id,job_id,attempt_id,state,manifest_json,created_at_ms) VALUES (?,?,?,?,'verified',?,?)")
    .run(digest, bundle.bundleId, bundle.jobId, bundle.attemptId, JSON.stringify(bundle), world.brain.store.now());
  db.prepare("INSERT INTO verification_verdicts(id,bundle_digest,evaluator_attempt_id,evaluator_digest,outcome,manifest_json,created_at_ms,finalized_at_ms) VALUES (?,?,?,?,'verified',?,?,?)")
    .run(`verdict-${rootRunId}`, digest, `evaluator-${rootRunId}`, release.digest, JSON.stringify({ outcome: "verified" }), world.brain.store.now(), world.brain.store.now());
  return digest;
}

export function activeTool(world: CapitalizationWorld, id = "fixture.echo"): ReleaseRef {
  const release = world.brain.activeRelease(world.org)!;
  const stored = JSON.parse(release.manifest) as { manifest: { tools: Array<{ id: string; digest: string }> } };
  const tool = stored.manifest.tools.find((entry) => entry.id === id);
  if (!tool) throw new Error(`active tool ${id} not found`);
  return { id: tool.id, digest: tool.digest };
}

export function captureOperation(world: CapitalizationWorld, rootRunId: string, release = activeTool(world)): string {
  const evidenceDigest = verifiedEvidence(world, rootRunId);
  const parameterShape = { message: "string" };
  const signature = domainDigest("brain:operation-signature:v1", { operationId: release.id, parameterShape, effectClass: "read" });
  world.brain.recordToolObservation({
    organizationId: world.org, workspaceId: world.workspaceId, signature, rootOperationId: rootRunId,
    packageDigest: release.digest, evidenceDigest, operationId: release.id, parameterShape, effectClass: "read", verified: true,
  });
  return evidenceDigest;
}
