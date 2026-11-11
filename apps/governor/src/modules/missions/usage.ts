import type { SpendCapView, UsageSummary, UsageView } from "@brain/contracts";
import type { Store } from "../../application/store";

type Db = ReturnType<Store["workspaceDb"]>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One attempt's usage as the usage ledger records it at settlement (#76). */
export type AttemptUsage = {
  inputTokens: number; outputTokens: number; cachedInputTokens: number; microUsd: number;
  accounting: "final-total" | "incremental"; estimated: boolean;
};

type UsageEvent = { kind?: string; payload?: { usageId?: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; microUsd?: number; accounting?: string; estimated?: boolean } };
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/**
 * Totals one attempt's usage events. An engine that reports a final total
 * (the last one wins) is charged that total; otherwise incremental reports are
 * summed, counting each usage id once so a replayed report is not charged twice.
 */
export function tallyUsage(events: readonly UsageEvent[]): AttemptUsage {
  const incremental = new Map<string, AttemptUsage>();
  let final: AttemptUsage | undefined;
  let anonymous = 0;
  for (const event of events) {
    const p = event.payload;
    if (event.kind !== "usage" || !p) continue;
    const entry = { inputTokens: count(p.inputTokens), outputTokens: count(p.outputTokens), cachedInputTokens: count(p.cachedInputTokens), microUsd: count(p.microUsd), estimated: p.estimated === true };
    if (p.accounting === "final-total") final = { ...entry, accounting: "final-total" };
    else incremental.set(typeof p.usageId === "string" ? p.usageId : `anonymous-${anonymous++}`, { ...entry, accounting: "incremental" });
  }
  if (final) return final;
  const total: AttemptUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0, accounting: "incremental", estimated: false };
  for (const entry of incremental.values()) {
    total.inputTokens += entry.inputTokens; total.outputTokens += entry.outputTokens; total.cachedInputTokens += entry.cachedInputTokens;
    total.microUsd += entry.microUsd; total.estimated ||= entry.estimated;
  }
  return total;
}


const SUMMARY_SQL = `SELECT
  COALESCE(SUM(settled_micro_usd),0) AS settledMicroUsd,
  COALESCE(SUM(CASE WHEN settled_at_ms IS NULL THEN reserved_micro_usd ELSE 0 END),0) AS reservedMicroUsd,
  COALESCE(SUM(CASE WHEN settled_at_ms IS NOT NULL THEN input_tokens+output_tokens+cached_input_tokens ELSE 0 END),0) AS settledTokens,
  COALESCE(SUM(CASE WHEN settled_at_ms IS NULL THEN reserved_tokens ELSE 0 END),0) AS reservedTokens,
  COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cached_input_tokens),0) AS cachedInputTokens,
  COUNT(*) AS attempts, COUNT(*) FILTER (WHERE settled_at_ms IS NULL) AS openAttempts,
  COALESCE(MAX(estimated),0) AS estimated FROM mission_spend`;

function summarize(db: Db, from: string, ...params: unknown[]): UsageSummary {
  const row = db.prepare(`${SUMMARY_SQL} ${from}`).get(...params as never[]) as Omit<UsageSummary, "estimated"> & { estimated: number };
  return { ...row, estimated: row.estimated === 1 };
}

export const missionUsage = (db: Db, missionId: string): UsageSummary => summarize(db, "WHERE mission_id=?", missionId);
export const taskUsage = (db: Db, workItemId: string): UsageSummary => summarize(db, "WHERE run_id IN (SELECT run_id FROM execution_links WHERE work_item_id=?)", workItemId);
export const workspaceUsage = (db: Db): UsageSummary => summarize(db, "");

/** Settled spend over the last 24 hours and 7 days plus every open reservation, against the workspace cap (#55). */
export function spendCapOf(db: Db, now: number): SpendCapView {
  const cap = db.prepare("SELECT daily_micro_usd, weekly_micro_usd FROM workspace_spend_cap WHERE id=1").get() as { daily_micro_usd: number | null; weekly_micro_usd: number | null } | undefined;
  const open = (db.prepare("SELECT COALESCE(SUM(reserved_micro_usd),0) AS v FROM mission_spend WHERE settled_at_ms IS NULL").get() as { v: number }).v;
  const since = (ms: number): number => (db.prepare("SELECT COALESCE(SUM(settled_micro_usd),0) AS v FROM mission_spend WHERE settled_at_ms >= ?").get(now - ms) as { v: number }).v;
  return {
    ...(cap?.daily_micro_usd != null ? { dailyMicroUsd: cap.daily_micro_usd } : {}),
    ...(cap?.weekly_micro_usd != null ? { weeklyMicroUsd: cap.weekly_micro_usd } : {}),
    dailySpentMicroUsd: since(DAY_MS) + open, weeklySpentMicroUsd: since(7 * DAY_MS) + open,
  };
}

/** True when a new attempt reserving `reserve` micro-USD would reach the daily or weekly workspace cap. */
export function capReached(db: Db, now: number, reserve: number): boolean {
  const view = spendCapOf(db, now);
  const reached = (spent: number, cap: number | undefined): boolean => cap !== undefined && (spent >= cap || spent + reserve > cap);
  return reached(view.dailySpentMicroUsd, view.dailyMicroUsd) || reached(view.weeklySpentMicroUsd, view.weeklyMicroUsd);
}

const TERMINAL_ATTEMPT = new Set(["succeeded", "failed", "partial", "cancelled", "declined", "expired", "outcome_unknown"]);

/**
 * One run's attempts, mission or interactive: settled attempts read the ledger, an attempt still in
 * flight shows what its engine has reported so far. The summary totals finished attempts only,
 * so settled and in-flight usage are never mixed.
 */
export function runUsage(store: Store, db: Db, workspaceId: string, runId: string): UsageView {
  const attempts = store.control.prepare(`SELECT ja.id AS attempt_id, ja.state AS state FROM job_attempts ja JOIN jobs j ON j.id=ja.job_id
    WHERE j.workflow_run_id=? AND j.workspace_id=? ORDER BY j.created_at_ms, ja.attempt_no`).all(runId, workspaceId) as Array<{ attempt_id: string; state: string }>;
  const attemptRows = attempts.map(({ attempt_id: attemptId, state }) => {
    const ledger = db.prepare("SELECT reserved_micro_usd, settled_at_ms, settled_micro_usd, input_tokens, output_tokens, cached_input_tokens, accounting, estimated FROM mission_spend WHERE attempt_id=?").get(attemptId) as
      { reserved_micro_usd: number; settled_at_ms: number | null; settled_micro_usd: number | null; input_tokens: number; output_tokens: number; cached_input_tokens: number; accounting: "final-total" | "incremental" | null; estimated: number } | undefined;
    if (ledger?.settled_at_ms) {
      return { attemptId, runId, settled: true, inputTokens: ledger.input_tokens, outputTokens: ledger.output_tokens, cachedInputTokens: ledger.cached_input_tokens, microUsd: ledger.settled_micro_usd ?? 0, reservedMicroUsd: 0, ...(ledger.accounting ? { accounting: ledger.accounting } : {}), estimated: ledger.estimated === 1 };
    }
    const events = (store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attemptId) as Array<{ event_json: string }>).map((r) => JSON.parse(r.event_json) as UsageEvent);
    const live = tallyUsage(events);
    return { attemptId, runId, settled: TERMINAL_ATTEMPT.has(state), inputTokens: live.inputTokens, outputTokens: live.outputTokens, cachedInputTokens: live.cachedInputTokens, microUsd: live.microUsd, reservedMicroUsd: ledger?.reserved_micro_usd ?? 0, accounting: live.accounting, estimated: live.estimated };
  });
  const done = attemptRows.filter((row) => row.settled);
  const sum = (pick: (row: (typeof attemptRows)[number]) => number, rows = done): number => rows.reduce((total, row) => total + pick(row), 0);
  const usage: UsageSummary = {
    settledMicroUsd: sum((row) => row.microUsd), reservedMicroUsd: sum((row) => row.reservedMicroUsd, attemptRows.filter((row) => !row.settled)),
    settledTokens: sum((row) => row.inputTokens + row.outputTokens + row.cachedInputTokens), reservedTokens: (db.prepare("SELECT COALESCE(SUM(reserved_tokens),0) AS v FROM mission_spend WHERE run_id=? AND settled_at_ms IS NULL").get(runId) as { v: number }).v,
    inputTokens: sum((row) => row.inputTokens), outputTokens: sum((row) => row.outputTokens), cachedInputTokens: sum((row) => row.cachedInputTokens),
    attempts: attemptRows.length, openAttempts: attemptRows.length - done.length, estimated: done.some((row) => row.estimated),
  };
  return { scope: "run", id: runId, usage, attemptRows };
}

/** Stores the workspace cap; an omitted limit means no cap of that kind (a limit of 0 blocks all new work). */
export function setSpendCap(db: Db, actorId: string, now: number, cap: { daily: number | undefined; weekly: number | undefined }): void {
  db.prepare(`INSERT INTO workspace_spend_cap(id,daily_micro_usd,weekly_micro_usd,updated_by,updated_at_ms) VALUES (1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET daily_micro_usd=excluded.daily_micro_usd,weekly_micro_usd=excluded.weekly_micro_usd,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
    .run(cap.daily ?? null, cap.weekly ?? null, actorId, now);
}
