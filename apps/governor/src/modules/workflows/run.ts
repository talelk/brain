import type { Run } from "@brain/contracts";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";

/**
 * The Run aggregate (ADR 0019). One execution of a released workflow; the
 * workflow_runs row is the source of truth, run_inputs names the release, and
 * execution_links / mission_runs supply the mission and work item links.
 * Returns undefined when the run does not exist in the workspace.
 */
export function readRun(store: Store, organizationId: string, workspaceId: string, runId: string): Run | undefined {
  const ws = store.workspaceDb(workspaceId, organizationId);
  const row = ws.prepare("SELECT id, config_digest, workflow_digest, state, version, input_digest, output_digest, created_at_ms FROM workflow_runs WHERE id=?")
    .get(runId) as { id: string; config_digest: string; workflow_digest: string; state: string; version: number; input_digest: string; output_digest: string | null; created_at_ms: number } | undefined;
  if (!row) return undefined;
  const release = ws.prepare("SELECT json_extract(workflow_json,'$.metadata.id') AS id FROM run_inputs WHERE run_id=?").get(runId) as { id: string } | undefined;
  const link = ws.prepare("SELECT mission_id, work_item_id FROM execution_links WHERE run_id=? ORDER BY created_at_ms LIMIT 1").get(runId) as { mission_id: string; work_item_id: string } | undefined;
  const coordinator = link ? undefined : ws.prepare("SELECT mission_id FROM mission_runs WHERE run_id=?").get(runId) as { mission_id: string } | undefined;
  const missionId = link?.mission_id ?? coordinator?.mission_id;
  return {
    runId: row.id,
    organizationId,
    workspaceId,
    release: { id: release?.id ?? "", digest: row.workflow_digest },
    configDigest: row.config_digest,
    state: row.state as Run["state"],
    version: row.version,
    createdAt: iso(row.created_at_ms),
    inputDigest: row.input_digest,
    ...(row.output_digest ? { outputDigest: row.output_digest } : {}),
    ...(missionId ? { missionId } : {}),
    ...(link ? { workItemId: link.work_item_id } : {}),
  };
}
