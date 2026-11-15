import type { SpendCapView, UsageBreakdown, UsageGroup, UsageSeries, UsageSummary, UsageView, VerifiedCostReport } from "@brain/contracts";
import type { Store } from "../../application/store";

type Db = ReturnType<Store["workspaceDb"]>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One attempt's usage as the usage ledger records it at settlement (#76). */
export type AttemptUsage = {
  inputTokens: number; outputTokens: number; cachedInputTokens: number; microUsd: number;
  accounting: "final-total" | "incremental"; estimated: boolean;
};

type UsagePayload = { usageId?: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; microUsd?: number; accounting?: string; estimated?: boolean };
/**
 * An attempt event as stored: the runner wraps each engine event, so a usage report is
 * `{ kind: "engine", payload: { kind: "usage", payload: {...} } }`.
 */
type UsageEvent = { kind?: string; payload?: { kind?: string; payload?: UsagePayload } };
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
    const engineEvent = event.kind === "engine" ? event.payload : undefined;
    const p = engineEvent?.kind === "usage" ? engineEvent.payload : undefined;
    if (!p) continue;
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


/** Every ledger row of the workspace: mission attempts, and interactive attempts outside any mission (mission_id NULL). */
const SPEND_COLUMNS = "attempt_id, run_id, reserved_micro_usd, settled_micro_usd, reserved_tokens, input_tokens, output_tokens, cached_input_tokens, accounting, estimated, source, agent_id, member_id, engine_id, model_id, created_at_ms, settled_at_ms";
const ALL_SPEND = `(SELECT mission_id, ${SPEND_COLUMNS} FROM mission_spend
  UNION ALL SELECT NULL AS mission_id, ${SPEND_COLUMNS} FROM workspace_spend)`;
const MISSION_SPEND = "mission_spend";

const TOTALS_SQL = `
  COALESCE(SUM(settled_micro_usd),0) AS settledMicroUsd,
  COALESCE(SUM(CASE WHEN settled_at_ms IS NULL THEN reserved_micro_usd ELSE 0 END),0) AS reservedMicroUsd,
  COALESCE(SUM(CASE WHEN settled_at_ms IS NOT NULL THEN input_tokens+output_tokens+cached_input_tokens ELSE 0 END),0) AS settledTokens,
  COALESCE(SUM(CASE WHEN settled_at_ms IS NULL THEN reserved_tokens ELSE 0 END),0) AS reservedTokens,
  COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cached_input_tokens),0) AS cachedInputTokens,
  COUNT(*) AS attempts, COUNT(*) FILTER (WHERE settled_at_ms IS NULL) AS openAttempts,
  COALESCE(MAX(estimated),0) AS estimated`;

type Totals = Omit<UsageSummary, "estimated"> & { estimated: number };
const asSummary = ({ estimated, ...row }: Totals): UsageSummary => ({ ...row, estimated: estimated === 1 });

function summarize(db: Db, ledger: string, from: string, ...params: unknown[]): UsageSummary {
  return asSummary(db.prepare(`SELECT ${TOTALS_SQL} FROM ${ledger} ${from}`).get(...params as never[]) as Totals);
}

/** The ledger columns a usage breakdown can group by: the team member, the agent definition, the engine and the model that produced the usage. */
const DIMENSIONS = { member: "member_id", agent: "agent_id", engine: "engine_id", model: "model_id" } as const;

/**
 * The same totals as `summarize`, split by one attribution column. Each row of the ledger falls in exactly one group, so the groups of
 * one breakdown always sum to the total of the rows they were drawn from. A group is keyed by its source too: the advisory judge's calls
 * (#95) are spend with no agent, member or engine, and are not mixed into "not reported". Largest spend first.
 */
function grouped(db: Db, ledger: string, where: string, params: readonly unknown[], column: (typeof DIMENSIONS)[keyof typeof DIMENSIONS]): UsageGroup[] {
  const rows = db.prepare(`SELECT source, ${column} AS id, ${TOTALS_SQL} FROM ${ledger} ${where} GROUP BY source, ${column}
    ORDER BY SUM(settled_micro_usd) DESC, SUM(input_tokens+output_tokens+cached_input_tokens) DESC, source, ${column}`).all(...params as never[]) as Array<Totals & { source: "attempt" | "judge"; id: string | null }>;
  return rows.map(({ source, id, ...totals }) => ({ source, ...(id !== null ? { id } : {}), usage: asSummary(totals as Totals) }));
}

function breakdownOf(db: Db, ledger: string, where: string, params: readonly unknown[], dimensions: ReadonlyArray<keyof typeof DIMENSIONS>): UsageBreakdown {
  return Object.fromEntries(dimensions.map((dimension) => [dimension, grouped(db, ledger, where, params, DIMENSIONS[dimension])])) as UsageBreakdown;
}

export const missionUsage = (db: Db, missionId: string): UsageSummary => summarize(db, MISSION_SPEND, "WHERE mission_id=?", missionId);
export const taskUsage = (db: Db, workItemId: string): UsageSummary => summarize(db, ALL_SPEND, "WHERE run_id IN (SELECT run_id FROM execution_links WHERE work_item_id=?)", workItemId);
export const workspaceUsage = (db: Db): UsageSummary => summarize(db, ALL_SPEND, "");
/** Usage of interactive runs outside any mission (ad-hoc task runs, conversations): the workspace-level "Outside missions" bucket. */
export const outsideMissionsUsage = (db: Db): UsageSummary => summarize(db, "workspace_spend", "");
/** A mission's usage split by team member, agent definition, engine and model: each split sums to `missionUsage`. */
export const missionBreakdown = (db: Db, missionId: string): UsageBreakdown => breakdownOf(db, MISSION_SPEND, "WHERE mission_id=?", [missionId], ["member", "agent", "engine", "model"]);
/** Everything one agent definition used in the workspace, in missions and outside them. */
export const agentUsage = (db: Db, agentId: string): { usage: UsageSummary; breakdown: UsageBreakdown } => ({
  usage: summarize(db, ALL_SPEND, "WHERE agent_id=?", agentId), breakdown: breakdownOf(db, ALL_SPEND, "WHERE agent_id=?", [agentId], ["engine", "model"]),
});
/** Everything one team member of one mission used (member ids belong to a mission's plan, so two missions may both have a "reviewer"). */
export const memberUsage = (db: Db, missionId: string, memberId: string): { usage: UsageSummary; breakdown: UsageBreakdown } => ({
  usage: summarize(db, MISSION_SPEND, "WHERE mission_id=? AND member_id=?", missionId, memberId), breakdown: breakdownOf(db, MISSION_SPEND, "WHERE mission_id=? AND member_id=?", [missionId, memberId], ["agent", "engine", "model"]),
});

export const SERIES_MAX_DAYS = 90;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Daily spend of one scope, read from the same ledger rows as every total: a row counts on the UTC day its attempt settled, so the days of
 * a window that reaches back to the first settlement add up to the scope's settled total, and a day with no spend is present as zero.
 * Reserved (unsettled) amounts are not spend yet and are not in the series.
 */
export function spendSeries(db: Db, scope: "workspace" | "mission" | "agent", id: string, now: number, days: number): UsageSeries {
  const [ledger, where, params]: [string, string, unknown[]] = scope === "workspace" ? [ALL_SPEND, "", []] : scope === "mission" ? [MISSION_SPEND, "AND mission_id=?", [id]] : [ALL_SPEND, "AND agent_id=?", [id]];
  const today = Math.floor(now / DAY_MS);
  const from = (today - (days - 1)) * DAY_MS;
  const to = (today + 1) * DAY_MS - 1;
  const rows = db.prepare(`SELECT settled_at_ms / ${DAY_MS} AS day, SUM(settled_micro_usd) AS microUsd, SUM(input_tokens+output_tokens+cached_input_tokens) AS tokens, COUNT(*) AS attempts
    FROM ${ledger} WHERE settled_at_ms IS NOT NULL AND settled_at_ms >= ? AND settled_at_ms <= ? ${where} GROUP BY settled_at_ms / ${DAY_MS}`).all(from, to, ...params as never[]) as Array<{ day: number; microUsd: number; tokens: number; attempts: number }>;
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const series = Array.from({ length: days }, (_, index) => {
    const row = byDay.get(today - (days - 1) + index);
    return { day: iso(from + index * DAY_MS).slice(0, 10), settledMicroUsd: row?.microUsd ?? 0, settledTokens: row?.tokens ?? 0, attempts: row?.attempts ?? 0 };
  });
  return {
    scope, id, window: { from: iso(from), to: iso(to), days },
    definition: "Settled model spend per UTC day, by the day each attempt settled, read from the usage ledger. Days with no spend show zero; spend still reserved for running work is not included.",
    days: series, totalMicroUsd: series.reduce((sum, day) => sum + day.settledMicroUsd, 0), totalTokens: series.reduce((sum, day) => sum + day.settledTokens, 0),
  };
}

/**
 * Cost per verified task by agent and by Play over the trailing window, with the Quality summary's arithmetic: spend settled in the window divided by
 * tasks that reached Done in the window. Nothing is estimated and no model computes anything.
 */
export function verifiedCost(db: Db, now: number, days: number): VerifiedCostReport {
  const from = now - days * DAY_MS;
  const done = db.prepare("SELECT DISTINCT e.aggregate_id AS id, w.mission_id AS missionId FROM events e JOIN work_items w ON w.id=e.aggregate_id WHERE e.event_type='workItem.transitioned' AND json_extract(e.payload_json,'$.state')='done' AND e.created_at_ms>=?").all(from) as Array<{ id: string; missionId: string | null }>;
  const agentsOfTask = db.prepare(`SELECT DISTINCT s.agent_id AS agent FROM execution_links l JOIN ${ALL_SPEND} s ON s.run_id=l.run_id WHERE l.work_item_id=? AND s.agent_id IS NOT NULL AND s.source='attempt'`);
  const playOf = db.prepare("SELECT play_id AS playId FROM missions WHERE id=?");
  const verifiedByAgent = new Map<string, number>();
  const verifiedByPlay = new Map<string, number>();
  for (const task of done) {
    for (const row of agentsOfTask.all(task.id) as Array<{ agent: string }>) verifiedByAgent.set(row.agent, (verifiedByAgent.get(row.agent) ?? 0) + 1);
    if (task.missionId) {
      const play = (playOf.get(task.missionId) as { playId: string | null } | undefined)?.playId ?? "";
      verifiedByPlay.set(play, (verifiedByPlay.get(play) ?? 0) + 1);
    }
  }
  const agentSpend = new Map((db.prepare(`SELECT agent_id AS id, SUM(settled_micro_usd) AS spend FROM ${ALL_SPEND} WHERE settled_at_ms >= ? AND agent_id IS NOT NULL AND source='attempt' GROUP BY agent_id`).all(from) as Array<{ id: string; spend: number }>).map((row) => [row.id, row.spend]));
  const playSpend = new Map((db.prepare("SELECT COALESCE(m.play_id,'') AS id, SUM(s.settled_micro_usd) AS spend FROM mission_spend s JOIN missions m ON m.id=s.mission_id WHERE s.settled_at_ms >= ? AND s.source='attempt' GROUP BY COALESCE(m.play_id,'')").all(from) as Array<{ id: string; spend: number }>).map((row) => [row.id, row.spend]));
  const rowsOf = (spend: Map<string, number>, verified: Map<string, number>) => [...new Set([...spend.keys(), ...verified.keys()])].map((key) => {
    const spendMicroUsd = spend.get(key) ?? 0, verifiedTasks = verified.get(key) ?? 0;
    return { ...(key !== "" ? { id: key } : {}), spendMicroUsd, verifiedTasks, ...(verifiedTasks ? { costPerVerifiedMicroUsd: Math.round(spendMicroUsd / verifiedTasks) } : {}) };
  }).sort((a, b) => b.spendMicroUsd - a.spendMicroUsd || (a.id ?? "").localeCompare(b.id ?? ""));
  return {
    window: { from: iso(from), to: iso(now), days },
    byAgentDefinition: "Settled spend of the agent's attempts in the window, divided by tasks that reached Done in the window and had at least one attempt by that agent. A task several agents worked on counts for each of them, so these counts overlap; the advisory judge's calls have no agent and are left out.",
    byPlayDefinition: "Settled spend of the missions started from the Play in the window, divided by tasks of those missions that reached Done in the window. Missions not started from a Play are grouped together; runs outside any mission belong to no Play.",
    byAgent: rowsOf(agentSpend, verifiedByAgent), byPlay: rowsOf(playSpend, verifiedByPlay),
  };
}

/** Settled spend over the last 24 hours and 7 days plus every open reservation, against the workspace cap (#55). */
export function spendCapOf(db: Db, now: number): SpendCapView {
  const cap = db.prepare("SELECT daily_micro_usd, weekly_micro_usd FROM workspace_spend_cap WHERE id=1").get() as { daily_micro_usd: number | null; weekly_micro_usd: number | null } | undefined;
  const open = (db.prepare(`SELECT COALESCE(SUM(reserved_micro_usd),0) AS v FROM ${ALL_SPEND} WHERE settled_at_ms IS NULL`).get() as { v: number }).v;
  const since = (ms: number): number => (db.prepare(`SELECT COALESCE(SUM(settled_micro_usd),0) AS v FROM ${ALL_SPEND} WHERE settled_at_ms >= ?`).get(now - ms) as { v: number }).v;
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
    const ledger = db.prepare(`SELECT reserved_micro_usd, settled_at_ms, settled_micro_usd, input_tokens, output_tokens, cached_input_tokens, accounting, estimated, source, agent_id, member_id, engine_id, model_id FROM ${ALL_SPEND} WHERE attempt_id=?`).get(attemptId) as
      { reserved_micro_usd: number; settled_at_ms: number | null; settled_micro_usd: number | null; input_tokens: number; output_tokens: number; cached_input_tokens: number; accounting: "final-total" | "incremental" | null; estimated: number;
        source: "attempt" | "judge"; agent_id: string | null; member_id: string | null; engine_id: string | null; model_id: string | null } | undefined;
    // An attempt still running has no engine or model on its ledger row yet: show what its runner has reported so far.
    const reported = ledger?.settled_at_ms ? undefined : store.control.prepare("SELECT reported_engine AS engine, reported_model AS model FROM job_attempts WHERE id=?").get(attemptId) as { engine: string | null; model: string | null } | undefined;
    const engine = ledger?.engine_id ?? reported?.engine, model = ledger?.model_id ?? reported?.model;
    const who = { source: ledger?.source ?? "attempt" as const, ...(ledger?.agent_id ? { agentId: ledger.agent_id } : {}), ...(ledger?.member_id ? { memberId: ledger.member_id } : {}), ...(engine ? { engine } : {}), ...(model ? { model } : {}) };
    if (ledger?.settled_at_ms) {
      return { attemptId, runId, settled: true, inputTokens: ledger.input_tokens, outputTokens: ledger.output_tokens, cachedInputTokens: ledger.cached_input_tokens, microUsd: ledger.settled_micro_usd ?? 0, reservedMicroUsd: 0, ...(ledger.accounting ? { accounting: ledger.accounting } : {}), estimated: ledger.estimated === 1, ...who };
    }
    const events = (store.control.prepare("SELECT event_json FROM attempt_events WHERE attempt_id=? ORDER BY seq").all(attemptId) as Array<{ event_json: string }>).map((r) => JSON.parse(r.event_json) as UsageEvent);
    const live = tallyUsage(events);
    return { attemptId, runId, settled: TERMINAL_ATTEMPT.has(state), inputTokens: live.inputTokens, outputTokens: live.outputTokens, cachedInputTokens: live.cachedInputTokens, microUsd: live.microUsd, reservedMicroUsd: ledger?.reserved_micro_usd ?? 0, accounting: live.accounting, estimated: live.estimated, ...who };
  });
  const done = attemptRows.filter((row) => row.settled);
  const sum = (pick: (row: (typeof attemptRows)[number]) => number, rows = done): number => rows.reduce((total, row) => total + pick(row), 0);
  const usage: UsageSummary = {
    settledMicroUsd: sum((row) => row.microUsd), reservedMicroUsd: sum((row) => row.reservedMicroUsd, attemptRows.filter((row) => !row.settled)),
    settledTokens: sum((row) => row.inputTokens + row.outputTokens + row.cachedInputTokens), reservedTokens: (db.prepare(`SELECT COALESCE(SUM(reserved_tokens),0) AS v FROM ${ALL_SPEND} WHERE run_id=? AND settled_at_ms IS NULL`).get(runId) as { v: number }).v,
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
