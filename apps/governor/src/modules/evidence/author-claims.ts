import type { CheckResult, JsonValue, ReleaseRef } from "@brain/contracts";
import type { Store } from "../../application/store";

/**
 * Author-claim structure (T27): the Governor computes, from the pinned release
 * and run, the exact check claims an author bundle must carry and the tool
 * releases it must name. The runner assembles its bundle from this structure
 * plus its own uploaded artifacts — it invents neither the criteria nor the
 * oracles, and the independent evaluator still decides the outcome.
 */
export function authorEvidenceFor(
  s: Store,
  organizationId: string,
  workspaceId: string,
  workflowRunId: string,
  configDigest: string,
): { toolReleases: ReleaseRef[]; claimedChecks: CheckResult[]; sourceRevision: string; primitiveVersions: Record<string, string> } {
  const empty = { toolReleases: [] as ReleaseRef[], claimedChecks: [] as CheckResult[], sourceRevision: "", primitiveVersions: {} as Record<string, string> };
  const rel = s.control.prepare("SELECT source_revision, manifest_json FROM config_releases WHERE digest=?").get(configDigest) as
    | { source_revision: string; manifest_json: string } | undefined;
  if (!rel) return empty;
  let primitiveVersions: Record<string, string> = {};
  try {
    const parsed = JSON.parse(rel.manifest_json) as { manifest?: { primitiveVersions?: Record<string, string> } };
    primitiveVersions = parsed.manifest?.primitiveVersions ?? {};
  } catch { return empty; }
  let run: { workflow_digest: string } | undefined;
  let meta: { workflow_json: string } | undefined;
  try {
    const ws = s.workspaceDb(workspaceId, organizationId);
    run = ws.prepare("SELECT workflow_digest FROM workflow_runs WHERE id=?").get(workflowRunId) as { workflow_digest: string } | undefined;
    // run_inputs is created by the workflow engine on first dispatch; an
    // offer for a not-yet-dispatched job simply carries no claims.
    meta = ws.prepare("SELECT workflow_json FROM run_inputs WHERE run_id=?").get(workflowRunId) as { workflow_json: string } | undefined;
  } catch { return { ...empty, sourceRevision: rel.source_revision, primitiveVersions }; }
  if (!run || !meta) return { ...empty, sourceRevision: rel.source_revision, primitiveVersions };
  const workflow = JSON.parse(meta.workflow_json) as { spec?: { jobs?: Record<string, { kind?: string; evaluator?: { id: string; digest: string } }> } };
  const evaluator = Object.values(workflow.spec?.jobs ?? {}).find((j) => j.kind === "eval");
  let claimedChecks: CheckResult[] = [];
  if (evaluator?.kind === "eval" && evaluator.evaluator) {
    try {
      const parsed = JSON.parse(rel.manifest_json) as { evaluators?: Record<string, { spec?: { requiredChecks?: string[] } }> };
      const evaluatorRef = evaluator.evaluator;
      const required = parsed.evaluators?.[evaluatorRef.id]?.spec?.requiredChecks ?? [];
      claimedChecks = required.map((checkId) => ({
        criterionId: checkId, checkId, status: "passed" as const, oracleDigest: evaluatorRef.digest,
        artifacts: [], detail: "Author claims this criterion; independent evaluator required",
      }));
    } catch { claimedChecks = []; }
  }
  return { toolReleases: [], claimedChecks, sourceRevision: rel.source_revision, primitiveVersions };
}

/** Tool releases named by a job payload's step (author bundle provenance). */
export function toolReleasesForPayload(payload: JsonValue): ReleaseRef[] {
  const step = (payload as { step?: { uses?: { release?: ReleaseRef } } }).step;
  return step?.uses?.release ? [step.uses.release] : [];
}
