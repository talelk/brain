import type { Store } from "../../application/store";

type Db = ReturnType<Store["workspaceDb"]>;

/** Why a failed or stuck run no longer needs a person. */
export type RunResolution = "retried-and-succeeded" | "retried" | "mission-closed" | "set-aside";

export interface RunContext {
  missionId: string;
  missionTitle: string;
  workItemId: string;
  workItemTitle: string;
  resolution?: RunResolution;
}

/**
 * The one read-model rule behind both the Runs "Needs intervention" view and Today's Needs-you queue: which work a run belongs to
 * and whether a later event already settled it. A run whose task was finished by another attempt, is being tried again, was set
 * aside, or whose mission is closed is history; everything else linked to open work is still unresolved. A run with no task
 * behind it (a standalone dispatch) has no context and is judged by its own state alone.
 */
export function runContext(db: Db, runId: string, jobState?: string): RunContext | undefined {
  const row = db.prepare(`SELECT l.mission_id AS missionId, m.title AS missionTitle, m.state AS missionState, w.id AS workItemId, w.title AS workItemTitle,
      w.state AS workState, l.created_at_ms AS linkedAt
    FROM execution_links l JOIN work_items w ON w.id=l.work_item_id JOIN missions m ON m.id=l.mission_id WHERE l.run_id=? LIMIT 1`).get(runId) as
    { missionId: string; missionTitle: string; missionState: string; workItemId: string; workItemTitle: string; workState: string; linkedAt: number } | undefined;
  if (!row) return undefined;
  const base = { missionId: row.missionId, missionTitle: row.missionTitle, workItemId: row.workItemId, workItemTitle: row.workItemTitle };
  // A run that itself succeeded needs no settling story.
  if (jobState === "succeeded" || db.prepare("SELECT 1 FROM workflow_runs WHERE id=? AND state='succeeded'").get(runId)) return base;
  if (row.workState === "done") return { ...base, resolution: "retried-and-succeeded" };
  if (row.missionState === "closed") return { ...base, resolution: "mission-closed" };
  if (row.workState === "abandoned") return { ...base, resolution: "set-aside" };
  const later = db.prepare("SELECT 1 FROM execution_links WHERE work_item_id=? AND run_id!=? AND created_at_ms>?").get(row.workItemId, runId, row.linkedAt);
  return later ? { ...base, resolution: "retried" } : base;
}

/** Same rule for a job row: only stuck or failed states with no settling event ask for a person, and Brain's own restarts never do. */
export function jobNeedsYou(state: string, restarting: boolean, context: RunContext | undefined): boolean {
  return ["blocked", "outcome_unknown", "failed"].includes(state) && !restarting && !context?.resolution;
}
