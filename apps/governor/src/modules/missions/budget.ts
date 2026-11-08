import type { BudgetUsage, MissionBudget } from "@brain/contracts";
import type { Store } from "../../application/store";
import { transitionState } from "../../domain/states";

type Db = ReturnType<Store["workspaceDb"]>;
type BudgetRow = {
  id: string; state: string; budget_micro_usd: number | null; budget_wall_ms: number | null; member_cap: number;
  attempt_reserve_micro_usd: number; active_ms: number; active_since_ms: number | null;
};

/** Why an attempt of a mission was not admitted, as Live and "while you were away" show it (#36). */
export type WaitingReason = "budget" | "member cap" | "mission paused";

export function budgetOf(row: Pick<BudgetRow, "budget_micro_usd" | "budget_wall_ms" | "member_cap" | "attempt_reserve_micro_usd">): MissionBudget {
  return {
    ...(row.budget_micro_usd !== null ? { maxMicroUsd: row.budget_micro_usd } : {}),
    ...(row.budget_wall_ms !== null ? { maxWallClockMs: row.budget_wall_ms } : {}),
    memberCap: row.member_cap, attemptReserveMicroUsd: row.attempt_reserve_micro_usd,
  };
}

/** Wall-clock time counts only while the mission is not paused or closed. */
export function activeMs(row: Pick<BudgetRow, "active_ms" | "active_since_ms">, now: number): number {
  return row.active_ms + (row.active_since_ms !== null ? Math.max(0, now - row.active_since_ms) : 0);
}

/** Starts or stops the wall clock as a mission changes state. */
export function clockSet(next: string, row: Pick<BudgetRow, "active_ms" | "active_since_ms">, now: number): Record<string, unknown> {
  const running = next === "active" || next === "verifying";
  if (running) return row.active_since_ms === null ? { active_since_ms: now } : {};
  return { active_ms: activeMs(row, now), active_since_ms: null };
}

/**
 * Settles reservations whose attempts have released their runner capacity:
 * the charge is the attempt's reported usage (a final total when the engine
 * gives one, otherwise the sum of incremental reports). Uncertain usage stays
 * reserved until it is settled.
 */
export function settle(store: Store, db: Db, missionId: string): void {
  const open = db.prepare("SELECT attempt_id FROM mission_spend WHERE mission_id=? AND settled_at_ms IS NULL").all(missionId) as Array<{ attempt_id: string }>;
  for (const { attempt_id: attemptId } of open) {
    const released = store.control.prepare("SELECT released_at_ms FROM capacity_reservations WHERE attempt_id=?").get(attemptId) as { released_at_ms: number | null } | undefined;
    if (!released?.released_at_ms) continue;
    let incremental = 0; let final: number | undefined;
    for (const row of store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attemptId) as Array<{ event_json: string }>) {
      const event = JSON.parse(row.event_json) as { kind?: string; payload?: { microUsd?: number; accounting?: string } };
      if (event.kind !== "usage" || typeof event.payload?.microUsd !== "number") continue;
      if (event.payload.accounting === "final-total") final = event.payload.microUsd; else incremental += event.payload.microUsd;
    }
    db.prepare("UPDATE mission_spend SET settled_micro_usd=?,settled_at_ms=? WHERE attempt_id=? AND settled_at_ms IS NULL").run(final ?? incremental, store.now(), attemptId);
  }
}

export function usageOf(db: Db, row: BudgetRow, now: number): BudgetUsage {
  const spend = db.prepare(`SELECT COALESCE(SUM(settled_micro_usd),0) AS settled,
    COALESCE(SUM(CASE WHEN settled_at_ms IS NULL THEN reserved_micro_usd ELSE 0 END),0) AS reserved,
    COUNT(*) FILTER (WHERE settled_at_ms IS NULL) AS running FROM mission_spend WHERE mission_id=?`).get(row.id) as { settled: number; reserved: number; running: number };
  return { settledMicroUsd: spend.settled, reservedMicroUsd: spend.reserved, activeMs: activeMs(row, now), runningMembers: spend.running };
}

/**
 * Mission-local admission (#36), before runner capacity: the member cap
 * counts running work sessions, and an attempt is admitted only if its
 * reservation fits in budget minus committed spend (settled plus open
 * reservations). When nothing fits and nothing runs, the mission auto-pauses
 * with reason budget; a human raises the budget and resumes it.
 */
export function admit(store: Store, db: Db, missionId: string): { admitted: true; reserve: number; running: number } | { admitted: false; reason: WaitingReason; running: number } {
  settle(store, db, missionId);
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as BudgetRow | undefined;
  if (!row) return { admitted: true, reserve: 0, running: 0 };
  const now = store.now();
  const usage = usageOf(db, row, now);
  const running = usage.runningMembers;
  if (row.state !== "active") return { admitted: false, reason: "mission paused", running };
  if (running >= row.member_cap) return { admitted: false, reason: "member cap", running };
  const reserve = row.attempt_reserve_micro_usd;
  const spendExhausted = row.budget_micro_usd !== null && usage.settledMicroUsd + usage.reservedMicroUsd + reserve > row.budget_micro_usd;
  const clockExhausted = row.budget_wall_ms !== null && usage.activeMs >= row.budget_wall_ms;
  if (spendExhausted || clockExhausted) {
    if (usage.runningMembers === 0) {
      transitionState(db, "mission", row.id, "paused", { set: { pause_reason: "budget", updated_at_ms: now, ...clockSet("paused", row, now) }, bumpVersion: true });
      store.emit(db, { aggregateType: "mission", aggregateId: row.id, eventType: "mission.stateChanged", payload: { missionId: row.id, missionState: "paused" } });
    }
    return { admitted: false, reason: "budget", running };
  }
  return { admitted: true, reserve, running };
}

/** Records the reservation of an admitted attempt against its mission. */
export function reserve(store: Store, db: Db, input: { missionId: string; runId: string; attemptId: string; microUsd: number }): void {
  db.prepare("INSERT OR IGNORE INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,created_at_ms) VALUES (?,?,?,?,?)")
    .run(input.attemptId, input.missionId, input.runId, input.microUsd, store.now());
}

/** True when a budget pause can be lifted: spend and clock both have headroom again. */
export function hasHeadroom(store: Store, db: Db, missionId: string): boolean {
  settle(store, db, missionId);
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as BudgetRow;
  const usage = usageOf(db, row, store.now());
  return (row.budget_micro_usd === null || usage.settledMicroUsd + usage.reservedMicroUsd + row.attempt_reserve_micro_usd <= row.budget_micro_usd)
    && (row.budget_wall_ms === null || usage.activeMs < row.budget_wall_ms);
}
