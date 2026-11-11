import type { BudgetUsage, MissionBudget } from "@brain/contracts";
import type { Store } from "../../application/store";
import { transitionState } from "../../domain/states";
import { capReached, missionUsage, tallyUsage } from "./usage";

type Db = ReturnType<Store["workspaceDb"]>;
type BudgetRow = {
  id: string; state: string; budget_micro_usd: number | null; budget_wall_ms: number | null; member_cap: number;
  attempt_reserve_micro_usd: number; final_allowance_micro_usd: number;
  budget_tokens: number | null; attempt_reserve_tokens: number; budget_wall_explicit: number; wall_extended: number; policy_json: string;
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

/** Merges overlapping intervals and returns their total length: parallel attempts count once (ADR 0016). */
export function unionMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [from, to] of sorted) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

/**
 * Working time of a mission (ADR 0016): the union of the intervals in which one of its attempts held a runner reservation, from its
 * ledger row to the release of its capacity (to now while it runs, and never past the lease of an attempt a restart left behind).
 * Waiting for a person, planning, queueing and Governor downtime with nothing in flight are not working time. Reviewer runs of
 * "Challenge this result" are charged to the mission but are not its work.
 */
export function workingMs(store: Store, db: Db, missionId: string, now: number): number {
  const attempts = db.prepare(`SELECT attempt_id, created_at_ms FROM mission_spend WHERE mission_id=?
    AND run_id NOT IN (SELECT id FROM workflow_runs WHERE execution_key LIKE 'challenge-%')`).all(missionId) as Array<{ attempt_id: string; created_at_ms: number }>;
  const lookup = store.control.prepare(`SELECT a.lease_expires_at_ms AS lease, r.released_at_ms AS released FROM job_attempts a
    LEFT JOIN capacity_reservations r ON r.attempt_id=a.id WHERE a.id=?`);
  const intervals: Array<readonly [number, number]> = [];
  for (const attempt of attempts) {
    const found = lookup.get(attempt.attempt_id) as { lease: number; released: number | null } | undefined;
    const end = Math.min(found?.released ?? now, found ? Math.max(found.lease, attempt.created_at_ms) : now, now);
    intervals.push([attempt.created_at_ms, end]);
  }
  return unionMs(intervals);
}

/**
 * Settles reservations whose attempts have released their runner capacity:
 * the ledger row takes the attempt's reported usage (a final total when the
 * engine gives one, otherwise each usage id counted once) in tokens and
 * micro-USD. Uncertain usage stays reserved until it is settled.
 */
export function settle(store: Store, db: Db, missionId: string): void {
  const open = db.prepare("SELECT attempt_id FROM mission_spend WHERE mission_id=? AND settled_at_ms IS NULL").all(missionId) as Array<{ attempt_id: string }>;
  for (const { attempt_id: attemptId } of open) settleAttempt(store, db, "mission_spend", attemptId);
}

function settleAttempt(store: Store, db: Db, table: "mission_spend" | "workspace_spend", attemptId: string): void {
  const released = store.control.prepare("SELECT released_at_ms FROM capacity_reservations WHERE attempt_id=?").get(attemptId) as { released_at_ms: number | null } | undefined;
  if (!released?.released_at_ms) return;
  const events = (store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attemptId) as Array<{ event_json: string }>).map((row) => JSON.parse(row.event_json) as Parameters<typeof tallyUsage>[0][number]);
  const usage = tallyUsage(events);
  db.prepare(`UPDATE ${table} SET settled_micro_usd=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,accounting=?,estimated=?,settled_at_ms=? WHERE attempt_id=? AND settled_at_ms IS NULL`)
    .run(usage.microUsd, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.accounting, usage.estimated ? 1 : 0, store.now(), attemptId);
}

/** Settles every mission's released attempts and the interactive attempts outside missions, so workspace totals and the spend cap see current usage. */
export function settleAll(store: Store, db: Db): void {
  for (const { mission_id: missionId } of db.prepare("SELECT DISTINCT mission_id FROM mission_spend WHERE settled_at_ms IS NULL").all() as Array<{ mission_id: string }>) settle(store, db, missionId);
  for (const { attempt_id: attemptId } of db.prepare("SELECT attempt_id FROM workspace_spend WHERE settled_at_ms IS NULL").all() as Array<{ attempt_id: string }>) settleAttempt(store, db, "workspace_spend", attemptId);
}

export function usageOf(store: Store, db: Db, row: Pick<BudgetRow, "id">, now: number): BudgetUsage {
  const spend = missionUsage(db, row.id);
  return {
    settledMicroUsd: spend.settledMicroUsd, reservedMicroUsd: spend.reservedMicroUsd, activeMs: workingMs(store, db, row.id, now), runningMembers: spend.openAttempts,
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
export function admit(store: Store, db: Db, missionId: string, coordinator = false, onPaused?: (missionId: string) => void, mayExtendTime?: () => boolean): { admitted: true; reserve: number; running: number } | { admitted: false; reason: WaitingReason; running: number } {
  settleAll(store, db);
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as BudgetRow | undefined;
  if (!row) return { admitted: true, reserve: 0, running: 0 };
  const now = store.now();
  const usage = usageOf(store, db, row, now);
  const running = usage.runningMembers;
  // A coordinator may still run while paused for budget, to write the final checkpoint and handoff.
  if (row.state !== "active" && !(coordinator && row.state === "paused")) return { admitted: false, reason: "mission paused", running };
  if (running >= row.member_cap) return { admitted: false, reason: "member cap", running };
  const reserve = row.attempt_reserve_micro_usd;
  // Ordinary work leaves the final allowance untouched; only the coordinator may spend it (#36).
  const ceiling = row.budget_micro_usd === null ? null : row.budget_micro_usd - (coordinator ? 0 : row.final_allowance_micro_usd);
  const spendExhausted = ceiling !== null && usage.settledMicroUsd + usage.reservedMicroUsd + reserve > ceiling;
  // The coordinator is exempt from the time limit like from money and tokens, so a paused mission can still write its final checkpoint.
  let clockExhausted = !coordinator && row.budget_wall_ms !== null && usage.activeMs >= row.budget_wall_ms;
  // Local models cost no dollars, so the token ceiling is what bounds them; the workspace cap bounds all missions together (#78, #55).
  const tokensOut = !coordinator && tokensExhausted(row, usage);
  const capOut = !coordinator && capReached(db, now, reserve);
  // Only time ran out, nobody else could object and autonomy is standard: extend the time limit once by half (ADR 0016); never money or tokens.
  if (clockExhausted && !spendExhausted && !tokensOut && !capOut && row.state === "active" && row.wall_extended === 0 && row.budget_wall_ms !== null
    && presetOf(row.policy_json) === "standard" && mayExtendTime?.()) {
    const extended = row.budget_wall_ms + Math.ceil(row.budget_wall_ms / 2);
    db.prepare("UPDATE missions SET budget_wall_ms=?, wall_extended=1, updated_at_ms=? WHERE id=?").run(extended, now, row.id);
    store.emit(db, { aggregateType: "mission", aggregateId: row.id, eventType: "mission.budgetChanged", payload: { missionId: row.id, note: EXTENDED_NOTE, by: "brain" } });
    clockExhausted = false;
  }
  if (spendExhausted || clockExhausted || tokensOut || capOut) {
    if (usage.runningMembers === 0 && row.state === "active") {
      transitionState(db, "mission", row.id, "paused", { set: { pause_reason: "budget", updated_at_ms: now }, bumpVersion: true });
      onPaused?.(row.id);
      store.emit(db, { aggregateType: "mission", aggregateId: row.id, eventType: "mission.stateChanged", payload: { missionId: row.id, missionState: "paused" } });
    }
    return { admitted: false, reason: "budget", running };
  }
  return { admitted: true, reserve, running };
}

export const minutesWord = (ms: number): string => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
const dollarsWord = (micro: number): string => `$${Number((micro / 1_000_000).toFixed(2))}`;

/** One plain sentence for the activity feed: which limits a person changed, from what to what (ADR 0016). */
export function limitChangeNote(before: { budget_wall_ms: number | null; budget_micro_usd: number | null; budget_tokens: number | null }, next: { maxWallClockMs?: number; maxMicroUsd?: number; maxTokens?: number }): string {
  const parts: string[] = [];
  const word = (value: number | null, say: (n: number) => string): string => (value === null ? "none" : say(value));
  const after = { wall: next.maxWallClockMs ?? null, usd: next.maxMicroUsd ?? null, tokens: next.maxTokens ?? null };
  if (after.wall !== before.budget_wall_ms) parts.push(`time limit ${word(before.budget_wall_ms, minutesWord)} to ${word(after.wall, minutesWord)}`);
  if (after.usd !== before.budget_micro_usd) parts.push(`dollar budget ${word(before.budget_micro_usd, dollarsWord)} to ${word(after.usd, dollarsWord)}`);
  if (after.tokens !== before.budget_tokens) parts.push(`token ceiling ${word(before.budget_tokens, String)} to ${word(after.tokens, String)}`);
  return parts.length ? `Limits changed: ${parts.join("; ")}` : "Limits saved unchanged";
}

/** The note shown on a mission whose time limit Brain raised by itself. */
export const EXTENDED_NOTE = "Brain extended the time limit once";

function presetOf(policyJson: string): string | undefined {
  try { return (JSON.parse(policyJson) as { preset?: string }).preset; } catch { return undefined; }
}

/** Which limits stop new work of a mission right now, in words a person reads (ADR 0016); an empty list means none. */
export function reachedLimits(store: Store, db: Db, missionId: string): Array<"time" | "money" | "tokens" | "workspace cap"> {
  settleAll(store, db);
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as BudgetRow | undefined;
  if (!row) return [];
  const now = store.now();
  const usage = usageOf(store, db, row, now);
  const out: Array<"time" | "money" | "tokens" | "workspace cap"> = [];
  if (row.budget_wall_ms !== null && usage.activeMs >= row.budget_wall_ms) out.push("time");
  if (row.budget_micro_usd !== null && usage.settledMicroUsd + usage.reservedMicroUsd + row.attempt_reserve_micro_usd > row.budget_micro_usd - row.final_allowance_micro_usd) out.push("money");
  if (tokensExhausted(row, usage)) out.push("tokens");
  if (capReached(db, now, row.attempt_reserve_micro_usd)) out.push("workspace cap");
  return out;
}

/** Records the reservation of an admitted attempt against its mission, or against the workspace's "Outside missions" bucket when it has none. */
export function reserve(store: Store, db: Db, input: { missionId?: string; runId: string; attemptId: string; microUsd: number }): void {
  if (!input.missionId) {
    db.prepare("INSERT OR IGNORE INTO workspace_spend(attempt_id,run_id,reserved_micro_usd,created_at_ms) VALUES (?,?,?,?)").run(input.attemptId, input.runId, input.microUsd, store.now());
    return;
  }
  const tokens = (db.prepare("SELECT attempt_reserve_tokens FROM missions WHERE id=?").get(input.missionId) as { attempt_reserve_tokens: number } | undefined)?.attempt_reserve_tokens ?? 0;
  db.prepare("INSERT OR IGNORE INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,reserved_tokens,created_at_ms) VALUES (?,?,?,?,?,?)")
    .run(input.attemptId, input.missionId, input.runId, input.microUsd, tokens, store.now());
}

/** Admission of interactive work outside any mission: only the workspace spend cap applies; it is then charged to the workspace bucket. */
export function admitOutsideMission(store: Store, db: Db): { admitted: true; reserve: number; running: number } | { admitted: false; reason: string; running: number } {
  settleAll(store, db);
  return capReached(db, store.now(), 0) ? { admitted: false, reason: "workspace spend cap", running: 0 } : { admitted: true, reserve: 0, running: 0 };
}

/** True when a budget pause can be lifted: spend and clock both have headroom again. */
export function hasHeadroom(store: Store, db: Db, missionId: string): boolean {
  settleAll(store, db);
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as BudgetRow;
  const usage = usageOf(store, db, row, store.now());
  // The same ceiling admission enforces: the final allowance is not ordinary headroom, or a resume could pass and re-pause at once.
  return (row.budget_micro_usd === null || usage.settledMicroUsd + usage.reservedMicroUsd + row.attempt_reserve_micro_usd <= row.budget_micro_usd - row.final_allowance_micro_usd)
    && (row.budget_wall_ms === null || usage.activeMs < row.budget_wall_ms)
    && !tokensExhausted(row, usage) && !capReached(db, store.now(), row.attempt_reserve_micro_usd);
}

/**
 * The budget a mission gets when its command (and its play) names none (#47):
 * a person who types one sentence is not asked to pick a ceiling, and no
 * mission runs without one. $5 of settled spend, three members at a time, no
 * time limit (a bound on working time would pause long-lived work for no cost reason). Raise it in the plan.
 */
export const DEFAULT_MISSION_BUDGET: MissionBudget = { maxMicroUsd: 5_000_000, memberCap: 3, attemptReserveMicroUsd: 0 };

/**
 * Admission of a reviewer run asked for by "Challenge this result" (ADR 0012). Its spend is charged to the mission it reviews, so the
 * mission's usage and budget see it, but it is not a work session: it does not need an active mission (challenges usually follow a
 * closed one), takes no member slot decision and never pauses the mission. The money, token and workspace-cap limits apply.
 */
export function admitChallenge(store: Store, db: Db, missionId: string): { admitted: true; reserve: number; running: number } | { admitted: false; reason: WaitingReason; running: number } {
  settleAll(store, db);
  const row = db.prepare("SELECT * FROM missions WHERE id=?").get(missionId) as BudgetRow | undefined;
  if (!row) return { admitted: true, reserve: 0, running: 0 };
  const now = store.now();
  const usage = usageOf(store, db, row, now);
  const reserve = row.attempt_reserve_micro_usd;
  const ceiling = row.budget_micro_usd === null ? null : row.budget_micro_usd - row.final_allowance_micro_usd;
  const out = (ceiling !== null && usage.settledMicroUsd + usage.reservedMicroUsd + reserve >= ceiling) || tokensExhausted(row, usage) || capReached(db, now, reserve);
  return out ? { admitted: false, reason: "budget", running: usage.runningMembers } : { admitted: true, reserve, running: usage.runningMembers };
}
