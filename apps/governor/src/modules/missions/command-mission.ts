import type { Store } from "../../application/store";

/**
 * The missions a command's payload refers to, whether it names a mission or only a work item, plan version or run of one. A machine
 * principal is bound to one mission (ADR 0032): the funnel admits its command only when this is exactly that mission.
 */
export function missionsOfCommand(store: Store, organizationId: string, workspaceId: string, payload: Readonly<Record<string, unknown>>): string[] {
  const db = store.workspaceDb(workspaceId, organizationId);
  const found = new Set<string>();
  const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
  const via = (sql: string, id: string | undefined): void => {
    if (!id) return;
    const row = db.prepare(sql).get(id) as { mission_id: string } | undefined;
    // An id that names nothing is a reference to nothing this mission owns.
    found.add(row?.mission_id ?? `unknown:${id}`);
  };
  const mission = text(payload["missionId"]);
  if (mission) found.add(mission);
  via("SELECT mission_id FROM work_items WHERE id=?", text(payload["workItemId"]));
  via("SELECT mission_id FROM plan_versions WHERE id=?", text(payload["planVersionId"]));
  via("SELECT mission_id FROM execution_links WHERE run_id=? LIMIT 1", text(payload["runId"]));
  // A delegation names the session it starts from; that session's task decides which mission it is for.
  via("SELECT w.mission_id AS mission_id FROM sessions s JOIN work_items w ON w.id=s.work_item_id WHERE s.id=?", text(payload["parentSessionId"]));
  return [...found];
}
