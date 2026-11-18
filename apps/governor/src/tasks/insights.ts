import { BrainError, type FailureBucket, type InsightFailure, type InsightPercentiles, type InsightRank, type InsightTool, type Insights } from "@brain/contracts";
import { accessOf, visibleWorkspaces } from "../access";
import type { Governor } from "../app";
import type { Db } from "../db";
import type { Gov } from "../dispatch";
import { COST } from "../trust/usage";
import { activeManifest } from "../workspace/store";

/**
 * Insights (docs/model.md, "The timeline and Insights"): what happened over the last 7, 30 or 90 days, in the caller's own days, computed with grouped SQL from the rows
 * that already exist and kept for the minute of the Governor's clock. Every task and attempt is reached through `tasks_workspace_updated` and `attempts_task`.
 */
const DAY_MS = 86_400_000;
const TOP = 8;
const CACHE_MAX = 64;
const cache = new Map<string, Insights>();

const marks = (values: readonly unknown[]): string => values.map(() => "?").join(",");
const all = <T>(db: Db, sql: string, ...values: unknown[]): T[] => db.prepare(sql).all(...values) as T[];

/** The value at place ceil(p x n) of the n sorted values of each group `g`, for p 50 and 90 (integer arithmetic, so a test can state exact values). */
const PERCENTILES = (inner: string): string => `WITH x AS (SELECT g, v, ROW_NUMBER() OVER (PARTITION BY g ORDER BY v) AS rn, COUNT(*) OVER (PARTITION BY g) AS n FROM (${inner}))
  SELECT g, MAX(n) AS n, MAX(CASE WHEN rn = (n * 50 + 99) / 100 THEN v END) AS p50, MAX(CASE WHEN rn = (n * 90 + 99) / 100 THEN v END) AS p90 FROM x GROUP BY g`;

const BUCKET = `CASE WHEN la.id IS NULL THEN 'other' WHEN la.state = 'succeeded' THEN 'checks' WHEN la.state != 'failed' THEN 'other' ELSE CASE json_extract(la.failure_json, '$.reason')
  WHEN 'limit' THEN 'limits' WHEN 'setup' THEN 'setup' WHEN 'engine' THEN 'engine' WHEN 'model-refused' THEN 'engine' WHEN 'timeout' THEN 'engine' WHEN 'runner' THEN 'engine' ELSE 'other' END END`;

function compute(gov: Gov, ids: readonly string[], names: ReadonlyMap<string, { name: string; slug: string }>, days: number, tz: number, now: number): Insights {
  const { db } = gov;
  const off = tz * 60_000;
  const first = Math.floor((now + off) / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
  const since = first - off;
  const list = Array.from({ length: days }, (_, index) => new Date(first + index * DAY_MS).toISOString().slice(0, 10));
  const at = new Map(list.map((day, index) => [day, index]));
  const local = (column: string): string => `date((${column} + ${off}) / 1000, 'unixepoch')`;
  const inWs = (column: string): string => `${column} IN (${marks(ids)})`;
  const series = <T extends { d: string }>(rows: readonly T[], value: (row: T) => number): number[] => {
    const out = Array.from({ length: days }, () => 0);
    for (const row of rows) { const index = at.get(row.d); if (index !== undefined) out[index] = (out[index] ?? 0) + value(row); }
    return out;
  };
  /** Attempts of the window with their goal's root and their usage. */
  const ATTEMPTS = `FROM tasks t JOIN attempts a ON a.task_id = t.id JOIN tasks r ON r.id = t.root_id LEFT JOIN usage u ON u.attempt_id = a.id WHERE ${inWs("t.workspace_id")} AND t.updated_at_ms >= ? AND a.created_at_ms >= ?`;
  const RAN = "CASE WHEN a.started_at_ms IS NOT NULL AND a.finished_at_ms IS NOT NULL THEN a.finished_at_ms - a.started_at_ms ELSE 0 END";

  const started = all<{ d: string; n: number }>(db, `SELECT ${local("created_at_ms")} AS d, COUNT(*) AS n FROM tasks WHERE ${inWs("workspace_id")} AND parent_id IS NULL AND created_at_ms >= ? GROUP BY d`, ...ids, since);
  const finished = all<{ d: string; state: string; n: number }>(db, `SELECT ${local("finished_at_ms")} AS d, state, COUNT(*) AS n FROM tasks WHERE ${inWs("workspace_id")} AND parent_id IS NULL AND state IN ('done','failed','stopped') AND finished_at_ms >= ? GROUP BY d, state`, ...ids, since);
  const approvals = all<{ d: string; n: number }>(db, `SELECT ${local("created_at_ms")} AS d, COUNT(*) AS n FROM approvals WHERE ${inWs("workspace_id")} AND standing = 0 AND created_at_ms >= ? GROUP BY d`, ...ids, since);
  const questions = all<{ d: string; n: number }>(db, `SELECT ${local("c.created_at_ms")} AS d, COUNT(*) AS n FROM tasks t JOIN tool_calls c ON c.task_id = t.id WHERE ${inWs("t.workspace_id")} AND t.updated_at_ms >= ? AND c.tool = 'task.ask' AND c.created_at_ms >= ? GROUP BY d`, ...ids, since, since);
  const load = Array.from({ length: 168 }, () => 0);
  for (const row of all<{ wd: number; h: number; n: number }>(db, `SELECT CAST(strftime('%w', (a.started_at_ms + ${off}) / 1000, 'unixepoch') AS INTEGER) AS wd, CAST(strftime('%H', (a.started_at_ms + ${off}) / 1000, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n
    FROM tasks t JOIN attempts a ON a.task_id = t.id WHERE ${inWs("t.workspace_id")} AND t.updated_at_ms >= ? AND a.started_at_ms >= ? GROUP BY wd, h`, ...ids, since, since)) {
    load[((row.wd + 6) % 7) * 24 + row.h] = row.n;
  }
  const done = series(finished.filter((row) => row.state === "done"), (row) => row.n);
  const failed = series(finished.filter((row) => row.state === "failed"), (row) => row.n);
  const asked = series([...approvals, ...questions], (row) => row.n);
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  const spent = (db.prepare(`SELECT COUNT(*) AS attempts, COALESCE(SUM(${COST}), 0) AS micro, COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens, COALESCE(SUM(${RAN}), 0) AS ms ${ATTEMPTS}`).get(...ids, since, since)) as { attempts: number; micro: number; tokens: number; ms: number };

  /** The things one dimension splits attempts into, as many as are in the top of either measure, with a per-day series of each. */
  const ranked = (key: string, label: (key: string) => string): InsightRank[] => {
    const rows = all<{ k: string; d: string; n: number; ms: number; micro: number; tokens: number }>(db, `SELECT ${key} AS k, ${local("a.created_at_ms")} AS d, COUNT(*) AS n, SUM(${RAN}) AS ms, COALESCE(SUM(${COST}), 0) AS micro, COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS tokens ${ATTEMPTS} GROUP BY k, d`, ...ids, since, since);
    const keys = new Set<string>();
    for (const measure of ["ms", "micro"] as const) {
      const totals = new Map<string, number>();
      for (const row of rows) totals.set(row.k, (totals.get(row.k) ?? 0) + row[measure]);
      for (const [k] of [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP)) keys.add(k);
    }
    return [...keys].map((k): InsightRank => {
      const mine = rows.filter((row) => row.k === k);
      return { key: k, label: label(k), attempts: sum(mine.map((row) => row.n)), ms: sum(mine.map((row) => row.ms)), microUsd: sum(mine.map((row) => row.micro)), tokens: sum(mine.map((row) => row.tokens)), msPerDay: series(mine, (row) => row.ms), microPerDay: series(mine, (row) => row.micro) };
    });
  };
  const playTitle = (play: string): string => {
    if (play === "") return "";
    for (const id of ids) { const title = activeManifest(gov, id).plays[play]?.title; if (title) return title; }
    return play;
  };

  const tools = all<{ tool: string; d: string; n: number; bad: number; ms: number }>(db, `SELECT c.tool, ${local("c.created_at_ms")} AS d, COUNT(*) AS n, SUM(c.outcome IN ('failed','rejected')) AS bad, COALESCE(SUM(CASE WHEN c.finished_at_ms IS NOT NULL THEN c.finished_at_ms - c.created_at_ms END), 0) AS ms
    FROM tasks t JOIN tool_calls c ON c.task_id = t.id WHERE ${inWs("t.workspace_id")} AND t.updated_at_ms >= ? AND c.created_at_ms >= ? GROUP BY c.tool, d`, ...ids, since, since);
  const byTool = [...new Set(tools.map((row) => row.tool))].map((tool): InsightTool => {
    const mine = tools.filter((row) => row.tool === tool);
    return { tool, calls: sum(mine.map((row) => row.n)), failed: sum(mine.map((row) => row.bad)), ms: sum(mine.map((row) => row.ms)), perDay: series(mine, (row) => row.n) };
  }).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)).slice(0, TOP);

  const percentiles = (sql: string, label: (key: string) => string, ...values: unknown[]): InsightPercentiles[] =>
    all<{ g: string; n: number; p50: number; p90: number }>(db, `${PERCENTILES(sql)} ORDER BY n DESC, g LIMIT 12`, ...values).map((row) => ({ key: row.g, label: label(row.g), n: row.n, p50: row.p50, p90: row.p90 }));
  const waits = new Map(all<{ g: string; n: number; p50: number; p90: number }>(db, PERCENTILES(`SELECT ${local("a.created_at_ms")} AS g, a.started_at_ms - a.created_at_ms AS v ${ATTEMPTS} AND a.started_at_ms IS NOT NULL`), ...ids, since, since).map((row) => [row.g, row]));

  const buckets = new Map<FailureBucket, InsightFailure & { tasks: InsightFailure["tasks"][number][] }>();
  for (const row of all<{ bucket: FailureBucket; total: number; id: string; root_id: string; title: string; goal_title: string; workspace_id: string; at: number }>(db, `SELECT bucket, total, id, root_id, title, goal_title, workspace_id, at FROM (
      SELECT x.*, COUNT(*) OVER (PARTITION BY bucket) AS total, ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY at DESC, id) AS rn FROM (
        SELECT t.id, t.root_id, t.title, r.title AS goal_title, t.workspace_id, t.finished_at_ms AS at, ${BUCKET} AS bucket FROM tasks t JOIN tasks r ON r.id = t.root_id
        LEFT JOIN attempts la ON la.id = (SELECT id FROM attempts WHERE task_id = t.id ORDER BY rowid DESC LIMIT 1)
        WHERE ${inWs("t.workspace_id")} AND t.state = 'failed' AND t.finished_at_ms >= ? AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.state = 'failed')) x) WHERE rn <= 5 ORDER BY total DESC, at DESC`, ...ids, since)) {
    const bucket = buckets.get(row.bucket) ?? { bucket: row.bucket, count: row.total, tasks: [] };
    bucket.tasks.push({ id: row.id, rootId: row.root_id, title: row.title, goalTitle: row.goal_title, workspaceSlug: names.get(row.workspace_id)?.slug ?? "", at: row.at });
    buckets.set(row.bucket, bucket);
  }

  const repeats = all<{ id: string; title: string; play: string | null; workspace_id: string; n: number; micro: number; at: number }>(db, `SELECT id, title, play, workspace_id, COUNT(*) AS n, SUM(micro) AS micro, MAX(created_at_ms) AS at FROM (
      SELECT t.*, (SELECT COALESCE(SUM(${COST}), 0) FROM usage u JOIN tasks x ON x.id = u.task_id WHERE x.root_id = t.id) AS micro FROM tasks t WHERE ${inWs("t.workspace_id")} AND t.parent_id IS NULL AND t.created_at_ms >= ?)
    GROUP BY workspace_id, COALESCE(play, ''), COALESCE(inputs_json, ''), CASE WHEN play IS NULL THEN goal ELSE '' END HAVING n > 1 ORDER BY n DESC, at DESC LIMIT 6`, ...ids, since);

  return {
    now, days: list,
    totals: { goals: sum(started.map((row) => row.n)), done: sum(done), failed: sum(failed), stopped: sum(finished.filter((row) => row.state === "stopped").map((row) => row.n)), asked: sum(asked), attempts: spent.attempts, microUsd: spent.micro, tokens: spent.tokens, runMs: spent.ms },
    calendar: series(started, (row) => row.n), load,
    outcomes: list.map((_, index) => ({ done: done[index] ?? 0, failed: failed[index] ?? 0, asked: asked[index] ?? 0 })),
    byWorkspace: ranked("t.workspace_id", (key) => names.get(key)?.name ?? key), byAgent: ranked("a.agent", (key) => key), byPlay: ranked("COALESCE(r.play, '')", playTitle), byTool,
    playDurations: percentiles(`SELECT COALESCE(play, '') AS g, finished_at_ms - created_at_ms AS v FROM tasks WHERE ${inWs("workspace_id")} AND parent_id IS NULL AND state = 'done' AND finished_at_ms >= ?`, playTitle, ...ids, since),
    agentDurations: percentiles(`SELECT a.agent AS g, a.finished_at_ms - a.started_at_ms AS v ${ATTEMPTS} AND a.state = 'succeeded' AND a.started_at_ms IS NOT NULL AND a.finished_at_ms IS NOT NULL`, (key) => key, ...ids, since, since),
    queueWait: list.map((day) => { const row = waits.get(day); return { n: row?.n ?? 0, p50: row?.p50 ?? 0, p90: row?.p90 ?? 0 }; }),
    failures: [...buckets.values()],
    repeats: repeats.map((row) => ({ label: row.play === null ? row.title : playTitle(row.play), play: row.play, count: row.n, microUsd: row.micro, lastTaskId: row.id, workspaceSlug: names.get(row.workspace_id)?.slug ?? "", lastAt: row.at })),
  };
}

export function registerInsights({ gov }: Governor): void {
  gov.registry.query("insights", (ctx, input): Insights => {
    const { user } = ctx;
    if (!user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    if (input.workspaceId !== undefined && !accessOf(gov, user.id, input.workspaceId)) throw new BrainError("NOT_FOUND", "Workspace not found");
    const mine = new Map<string, { name: string; slug: string }>();
    if (user.instanceAdmin) for (const row of gov.db.prepare("SELECT id, slug, name FROM workspaces WHERE status='active'").all() as Array<{ id: string; slug: string; name: string }>) mine.set(row.id, row);
    for (const workspace of visibleWorkspaces(gov, user.id)) if (workspace.status === "active") mine.set(workspace.id, workspace);
    const ids = [...mine.keys()].filter((id) => input.workspaceId === undefined || id === input.workspaceId).sort();
    const now = ctx.now();
    const key = `${ids.join(",")}|${input.days}|${input.tzOffsetMinutes}|${Math.floor(now / 60_000)}`;
    const known = cache.get(key);
    if (known) return known;
    const answer = ids.length === 0 ? compute(gov, ["-"], mine, input.days, input.tzOffsetMinutes, now) : compute(gov, ids, mine, input.days, input.tzOffsetMinutes, now);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, answer);
    return answer;
  });
}
