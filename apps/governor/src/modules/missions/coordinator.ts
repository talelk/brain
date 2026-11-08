import type { JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";

type Db = ReturnType<Store["workspaceDb"]>;

/** Why a coordinator is woken (ADR 0004): missions advance on events, never inside a long run. */
export type WakeReason = "work-verified" | "message" | "plan-resolved" | "budget-changed" | "mission-paused";

/** The host capability to start the coordinator's workflow run, bound at the composition root. */
export interface CoordinatorPort {
  startCoordinatorRun(input: { organizationId: string; workspaceId: string; actorId: string; workflowId: string; missionId: string; reasons: readonly string[]; executionKey: string }): { runId: string };
}

const FINISHED = new Set(["succeeded", "failed", "cancelled", "partial"]);

/** Records a durable wake for a mission that has a coordinator; events without one need no coordinator. */
export function wake(store: Store, db: Db, missionId: string, reason: WakeReason, detail = ""): void {
  const mission = db.prepare("SELECT coordinator_member_id FROM missions WHERE id=?").get(missionId) as { coordinator_member_id: string | null } | undefined;
  if (!mission?.coordinator_member_id) return;
  db.prepare("INSERT INTO mission_wakes(id,mission_id,reason,detail,created_at_ms) VALUES (?,?,?,?,?)").run(store.id("wake"), missionId, reason, detail.slice(0, 500), store.now());
}

/**
 * Dispatches pending wakes: at most one coordinator run is live per mission;
 * a new one starts only when the previous has finished, carrying every wake
 * that accumulated, so a burst of events coalesces into one bounded session.
 * The coordinator acts only through Brain commands from inside that run.
 */
export function pump(store: Store, db: Db, organizationId: string, workspaceId: string, port: CoordinatorPort | undefined): number {
  if (!port) return 0;
  let started = 0;
  const missions = db.prepare(`SELECT DISTINCT m.id, m.owner_id, m.coordinator_workflow, m.state FROM mission_wakes w JOIN missions m ON m.id=w.mission_id
    WHERE w.consumed_by_run IS NULL AND m.coordinator_workflow IS NOT NULL`).all() as Array<{ id: string; owner_id: string; coordinator_workflow: string; state: string }>;
  for (const mission of missions) {
    if (mission.state === "closed") continue;
    const live = db.prepare("SELECT r.state FROM mission_runs m JOIN workflow_runs r ON r.id=m.run_id WHERE m.mission_id=? ORDER BY m.created_at_ms DESC LIMIT 1").get(mission.id) as { state: string } | undefined;
    if (live && !FINISHED.has(live.state)) continue;
    const wakes = db.prepare("SELECT id, reason, detail FROM mission_wakes WHERE mission_id=? AND consumed_by_run IS NULL ORDER BY created_at_ms, id").all(mission.id) as Array<{ id: string; reason: string; detail: string }>;
    if (wakes.length === 0) continue;
    let runId: string;
    try {
      ({ runId } = port.startCoordinatorRun({
        organizationId, workspaceId, actorId: mission.owner_id, workflowId: mission.coordinator_workflow, missionId: mission.id,
        reasons: wakes.map((entry) => entry.detail ? `${entry.reason}: ${entry.detail}` : entry.reason), executionKey: `coordinator:${wakes[0]!.id}`,
      }));
    } catch (error) {
      // The wakes stay pending and carry the reason, so the failure is visible and retried on the next pass.
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      for (const entry of wakes) db.prepare("UPDATE mission_wakes SET last_error=? WHERE id=?").run(message, entry.id);
      continue;
    }
    store.inTx(db, () => {
      db.prepare("INSERT OR IGNORE INTO mission_runs(run_id,mission_id,purpose,created_at_ms) VALUES (?,?, 'coordinator', ?)").run(runId, mission.id, store.now());
      for (const entry of wakes) db.prepare("UPDATE mission_wakes SET consumed_by_run=? WHERE id=? AND consumed_by_run IS NULL").run(runId, entry.id);
    });
    started++;
  }
  return started;
}

/** The run input a coordinator workflow receives. */
export function coordinatorInput(missionId: string, reasons: readonly string[]): JsonValue {
  return { missionId, reasons: [...reasons] } as JsonValue;
}
