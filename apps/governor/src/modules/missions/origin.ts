import type { ApprovalOrigin } from "@brain/contracts";
import type { Store } from "../../application/store";

type Db = ReturnType<Store["workspaceDb"]>;
type Link = { mission_id: string; work_item_id: string };

const latestLink = (db: Db, runId: string): Link | undefined =>
  db.prepare("SELECT mission_id, work_item_id FROM execution_links WHERE run_id=? ORDER BY created_at_ms DESC LIMIT 1").get(runId) as Link | undefined;

/** The mission and work item a run serves (empty for a run that serves none), as the references an approval binds (ADR 0048). */
export function runLink(db: Db, runId: string): { missionId?: string; workItemId?: string } {
  const link = latestLink(db, runId);
  return link ? { missionId: link.mission_id, workItemId: link.work_item_id } : {};
}

/** Where an approval was asked, as the Governor binds it: the run the proposing task is part of, and its work item and mission when it serves one. */
export function originOfRun(db: Db, runId: string): ApprovalOrigin {
  return { runId, ...runLink(db, runId) };
}

/** A plain reason when a caller-supplied origin is not what the run's own link says; undefined when it matches. Nothing a caller claims is shown as fact. */
export function originProblem(db: Db, origin: ApprovalOrigin): string | undefined {
  const known = db.prepare("SELECT 1 FROM workflow_runs WHERE id=? UNION ALL SELECT 1 FROM execution_links WHERE run_id=? LIMIT 1").get(origin.runId, origin.runId);
  if (!known) return "the origin names a run this workspace does not have";
  const link = runLink(db, origin.runId);
  if (origin.workItemId !== link.workItemId || origin.missionId !== link.missionId) return "the origin names a mission or task that this run does not serve";
  return undefined;
}

/** What the people reading an approval are told about its origin: current titles, looked up now, never part of what is bound. */
export function describeOrigin(db: Db, origin: ApprovalOrigin): { mission?: { missionId: string; title: string }; workItem?: { workItemId: string; title: string }; runId: string } {
  const mission = origin.missionId ? db.prepare("SELECT title FROM missions WHERE id=?").get(origin.missionId) as { title: string } | undefined : undefined;
  const workItem = origin.workItemId ? db.prepare("SELECT title FROM work_items WHERE id=?").get(origin.workItemId) as { title: string } | undefined : undefined;
  return {
    runId: origin.runId,
    ...(origin.missionId && mission ? { mission: { missionId: origin.missionId, title: mission.title } } : {}),
    ...(origin.workItemId && workItem ? { workItem: { workItemId: origin.workItemId, title: workItem.title } } : {}),
  };
}
