import type { BudgetUsage, MissionBudget } from "@brain/contracts";
import type { Store } from "../../application/store";
import { transitionState } from "../../domain/states";
import { capReached, missionUsage, tallyUsage } from "./usage";

type Db = ReturnType<Store["workspaceDb"]>;
type BudgetRow = {
  id: string; state: string; budget_micro_usd: number | null; budget_wall_ms: number | null; member_cap: number;
  attempt_reserve_micro_usd: number; active_ms: number; active_since_ms: number | null; final_allowance_micro_usd: number;
  budget_tokens: number | null; attempt_reserve_tokens: number;
};

/** Why an attempt of a mission was not admitted, as Live and "while you were away" show it (#36). */
export type WaitingReason = "budget" | "member cap" | "mission paused";

export function budgetOf(row: Pick<BudgetRow, "budget_micro_usd" | "budget_wall_ms" | "member_cap" | "attempt_reserve_micro_usd" | "final_allowance_micro_usd" | "budget_tokens" | "attempt_reserve_tokens">): MissionBudget {
  return {
    ...(row.budget_tokens !== null ? { maxTokens: row.budget_tokens } : {}),
    ...(row.attempt_reserve_tokens > 0 ? { attemptReserveTokens: row.attempt_reserve_tokens } : {}),
    ...(row.budget_micro_usd !== null ? { maxMicroUsd: row.budget_micro_usd } : {}),
    ...(row.budget_wall_ms !== null ? { maxWallClockMs: row.budget_wall_ms } : {}),
    memberCap: row.member_cap, attemptReserveMicroUsd: row.attempt_reserve_micro_usd,
    ...(row.final_allowance_micro_usd > 0 ? { finalAllowanceMicroUsd: row.final_allowance_micro_usd } : {}),
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
 * the ledger row takes the attempt's reported usage (a final total when the
 * engine gives one, otherwise each usage id counted once) in tokens and
 * micro-USD. Uncertain usage stays reserved until it is settled.
 */
export function settle(store: Store, db: Db, missionId: string): void {
  const open = db.prepare("SELECT attempt_id FROM mission_spend WHERE mission_id=? AND settled_at_ms IS NULL").all(missionId) as Array<{ attempt_id: string }>;
  for (const { attempt_id: attemptId } of open) {
    const released = store.control.prepare("SELECT released_at_ms FROM capacity_reservations WHERE attempt_id=?").get(attemptId) as { released_at_ms: number | null } | undefined;
    if (!released?.released_at_ms) continue;
    const events = (store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attemptId) as Array<{ event_json: string }>).map((row) => JSON.parse(row.event_json) as Parameters<typeof tallyUsage>[0][number]);
    const usage = tallyUsage(events);
    db.prepare("UPDATE mission_spend SET settled_micro_usd=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,accounting=?,estimated=?,settled_at_ms=? WHERE attempt_id=? AND settled_at_ms IS NULL")
      .run(usage.microUsd, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.accounting, usage.estimated ? 1 : 0, store.now(), attemptId);
  }
}

/** Settles every mission's released attempts, so workspace totals and the spend cap see current usage. */
export function settleAll(store: Store, db: Db): void {
  for (const { mission_id: missionId } of db.prepare("SELECT DISTINCT mission_id FROM mission_spend WHERE settled_at_ms IS NULL").all() as Array<{ mission_id: string }>) settle(store, db, missionId);
}

export function usageOf(db: Db, row: BudgetRow, now: number): BudgetUsage {
  const spend = missionUsage(db, row.id);
  return {
    settledMicroUsd: spend.settledMicroUsd, reservedMicroUsd: spend.reservedMicroUsd, activeMs: activeMs(row, now), runningMembers: spend.openAttempts,
    settledTokens: spend.settledTokens, reservedTokens: spend.reservedTokens, inputTokens: spend.inputTokens, outputTokens: spend.outputTokens, cachedInputTokens: spend.cachedInputTokens, estimated: spend.estimated,
  };
}

/** The token ceiling is reached once settled plus reserved tokens meet it, or one more attempt's reserve would pass it. */
function tokensExhausted(row: BudgetRow, usage: BudgetUsage): boolean {
  if (row.budget_tokens === null) return false;
  const used = usage.settledTokens + usage.reservedTokens;
  return used >= row.budget_tokens || used + row.attempt_reserve_tokens > row.budget_tokens;
}

/**
 * Mission-local admission (#36), before runner capacity: the member cap
 * counts running work sessions, and an attempt is admitted only if its
 * reservation fits in budget minus committed spend (settled plus open
 * reservations). When nothing fits and nothing runs, the mission auto-pauses
 * with reason budget; a human raises the budget and resumes it.
 */
export function admit(store: Store, db: Db, missionId: string, coordinator = false, onPaused?: (missionId: string) => void): { admitted: true; reserve: number; running: number } | { admitted: false; reason: WaitingReason; running: number } {
  settleAll(store, db);
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as BudgetRow | undefined;
  if (!row) return { admitted: true, reserve: 0, running: 0 };
  const now = store.now();
  const usage = usageOf(db, row, now);
  const running = usage.runningMembers;
  // A coordinator may still run while paused for budget, to write the final checkpoint and handoff.
  if (row.state !== "active" && !(coordinator && row.state === "paused")) return { admitted: false, reason: "mission paused", running };
  if (running >= row.member_cap) return { admitted: false, reason: "member cap", running };
  const reserve = row.attempt_reserve_micro_usd;
  // Ordinary work leaves the final allowance untouched; only the coordinator may spend it (#36).
  const ceiling = row.budget_micro_usd === null ? null : row.budget_micro_usd - (coordinator ? 0 : row.final_allowance_micro_usd);
  const spendExhausted = ceiling !== null && usage.settledMicroUsd + usage.reservedMicroUsd + reserve > ceiling;
  const clockExhausted = row.budget_wall_ms !== null && usage.activeMs >= row.budget_wall_ms;
  // Local models cost no dollars, so the token ceiling is what bounds them; the workspace cap bounds all missions together (#78, #55).
  const tokensOut = !coordinator && tokensExhausted(row, usage);
  const capOut = !coordinator && capReached(db, now, reserve);
  if (spendExhausted || clockExhausted || tokensOut || capOut) {
    if (usage.runningMembers === 0 && row.state === "active") {
      transitionState(db, "mission", row.id, "paused", { set: { pause_reason: "budget", updated_at_ms: now, ...clockSet("paused", row, now) }, bumpVersion: true });
      onPaused?.(row.id);
      store.emit(db, { aggregateType: "mission", aggregateId: row.id, eventType: "mission.stateChanged", payload: { missionId: row.id, missionState: "paused" } });
    }
    return { admitted: false, reason: "budget", running };
  }
  return { admitted: true, reserve, running };
}

/** Records the reservation of an admitted attempt against its mission. */
export function reserve(store: Store, db: Db, input: { missionId: string; runId: string; attemptId: string; microUsd: number }): void {
  const tokens = (db.prepare("SELECT attempt_reserve_tokens FROM missions WHERE id=?").get(input.missionId) as { attempt_reserve_tokens: number } | undefined)?.attempt_reserve_tokens ?? 0;
  db.prepare("INSERT OR IGNORE INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,reserved_tokens,created_at_ms) VALUES (?,?,?,?,?,?)")
    .run(input.attemptId, input.missionId, input.runId, input.microUsd, tokens, store.now());
}

/** True when a budget pause can be lifted: spend and clock both have headroom again. */
export function hasHeadroom(store: Store, db: Db, missionId: string): boolean {
  settleAll(store, db);
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as BudgetRow;
  const usage = usageOf(db, row, store.now());
  return (row.budget_micro_usd === null || usage.settledMicroUsd + usage.reservedMicroUsd + row.attempt_reserve_micro_usd <= row.budget_micro_usd)
    && (row.budget_wall_ms === null || usage.activeMs < row.budget_wall_ms)
    && !tokensExhausted(row, usage) && !capReached(db, store.now(), row.attempt_reserve_micro_usd);
}

/**
 * The budget a mission gets when its command (and its play) names none (#47):
 * a person who types one sentence is not asked to pick a ceiling, and no
 * mission runs without one. $5 of settled spend, three members at a time, no
 * wall-clock limit (wall time counts only while a mission runs, and a bound on
 * it would pause long-lived work for no cost reason). Raise it in the plan.
 */
export const DEFAULT_MISSION_BUDGET: MissionBudget = { maxMicroUsd: 5_000_000, memberCap: 3, attemptReserveMicroUsd: 0 };
