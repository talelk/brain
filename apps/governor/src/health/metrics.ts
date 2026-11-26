import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import type { Context } from "hono";
import type { Gov } from "../dispatch";
import { listRunners } from "../attempts/runners";
import { waitKinds } from "../tasks/queue";
import { utcDay } from "../tasks/store";
import { COST } from "../trust/usage";

/** `GET /metrics` (docs/architecture.md section 9): what the Governor is doing, in Prometheus text, for the VictoriaMetrics beside it. */
const CACHE_MS = 5_000;
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
/** A schedule that has not started this long after its time is overdue. */
const OVERDUE_MS = 5 * 60_000;
const STARTED = Date.now();

interface Series { readonly buckets: number[]; sum: number; count: number }
/** Requests by route class and status class; process-wide, like the process. */
const requests = new Map<string, Series>();
const lag = monitorEventLoopDelay({ resolution: 20 });
let measuring = false;

/** The part of the address that says what kind of request it was: never an id. */
function routeClass(path: string): string {
  if (path === "/metrics" || path.startsWith("/health/")) return path.slice(1).split("/")[0] as string;
  return /^\/(v1\/(?:command|query|events|artifacts)|runner|model|hooks|api\/auth)(?:\/|$)/u.exec(path)?.[1] ?? "web";
}

/** Counts one answered request. */
export function observe(path: string, status: number, seconds: number): void {
  const key = `${routeClass(path)}\n${Math.floor(status / 100)}xx`;
  let series = requests.get(key);
  if (!series) requests.set(key, (series = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
  const own = series;
  BUCKETS.forEach((bound, index) => { if (seconds <= bound) own.buckets[index] = (own.buckets[index] ?? 0) + 1; });
  own.sum += seconds;
  own.count += 1;
}

const escaped = (value: string): string => value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
const labels = (pairs: Record<string, string>): string => `{${Object.entries(pairs).map(([name, value]) => `${name}="${escaped(value)}"`).join(",")}}`;
const sizeOf = (path: string): number => { try { return statSync(path).size; } catch { return 0; } };
const one = (gov: Gov, sql: string, ...values: unknown[]): number => (gov.db.prepare(sql).get(...values) as { n: number | null }).n ?? 0;

/** Lines of the text format; a metric's HELP and TYPE are written once, before its first sample. */
class Page {
  private readonly lines: string[] = [];
  private readonly named = new Set<string>();
  head(name: string, help: string, type: string): void {
    if (this.named.has(name)) return;
    this.named.add(name);
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  }
  gauge(name: string, help: string, value: number, pairs: Record<string, string> = {}): void {
    this.head(name, help, "gauge");
    this.lines.push(`${name}${Object.keys(pairs).length ? labels(pairs) : ""} ${value}`);
  }
  raw(line: string): void { this.lines.push(line); }
  text(): string { return `${this.lines.join("\n")}\n`; }
}

interface Build { readonly version: string; readonly commit: string }

function collect(gov: Gov, build: Build, now: number): string {
  const page = new Page();
  const { db } = gov;
  const day = utcDay(now);
  const startOfDay = Date.parse(`${day}T00:00:00Z`);

  page.gauge("brain_build_info", "Which build runs: always 1.", 1, { ...build, node: process.version });
  page.gauge("brain_uptime_seconds", "Seconds since the Governor process started.", Math.round((Date.now() - STARTED) / 1000));
  page.gauge("brain_process_resident_memory_bytes", "Resident set size of the Governor process.", process.memoryUsage().rss);
  page.gauge("brain_event_loop_lag_seconds", "Event loop delay since the last scrape: the 99th percentile and the longest.", Number.isFinite(lag.percentile(99)) ? lag.percentile(99) / 1e9 : 0, { quantile: "0.99" });
  page.gauge("brain_event_loop_lag_seconds", "", Number.isFinite(lag.max) ? lag.max / 1e9 : 0, { quantile: "1" });
  lag.reset();

  const workspaces = db.prepare("SELECT id, slug FROM workspaces WHERE status='active'").all() as Array<{ id: string; slug: string }>;
  const slug = new Map(workspaces.map((workspace) => [workspace.id, workspace.slug]));
  const named = (id: string): string => slug.get(id) ?? "archived";
  page.gauge("brain_workspaces", "Active workspaces.", workspaces.length);

  for (const row of db.prepare("SELECT workspace_id AS w, state, COUNT(*) AS n FROM tasks GROUP BY workspace_id, state").all() as Array<{ w: string; state: string; n: number }>) {
    page.gauge("brain_tasks", "Tasks now, by workspace and state.", row.n, { workspace: named(row.w), state: row.state });
  }
  for (const [result, column, where] of [["started", "created_at_ms", ""], ["done", "finished_at_ms", "AND state='done'"], ["failed", "finished_at_ms", "AND state='failed'"]] as const) {
    page.gauge("brain_goals_today", "Goals (root tasks) started, done or failed since 00:00 UTC.", one(gov, `SELECT COUNT(*) AS n FROM tasks WHERE parent_id IS NULL AND ${column} >= ? ${where}`, startOfDay), { result });
  }
  for (const row of db.prepare("SELECT kind, state, COUNT(*) AS n FROM attempts WHERE created_at_ms >= ? GROUP BY kind, state").all(startOfDay) as Array<{ kind: string; state: string; n: number }>) {
    page.gauge("brain_attempts_today", "Attempts made since 00:00 UTC, by kind and state.", row.n, { kind: row.kind, state: row.state });
  }
  for (const row of db.prepare(`SELECT workspace_id AS w, COALESCE(SUM(u.input_tokens),0) AS input, COALESCE(SUM(u.output_tokens),0) AS output, COALESCE(SUM(u.cached_input_tokens),0) AS cached, COALESCE(SUM(${COST}),0) AS micro FROM usage u WHERE u.day=? GROUP BY workspace_id`).all(day) as Array<{ w: string; input: number; output: number; cached: number; micro: number }>) {
    const workspace = named(row.w);
    page.gauge("brain_tokens_today", "Model tokens used today (UTC), by workspace and direction.", row.input, { workspace, direction: "input" });
    page.gauge("brain_tokens_today", "", row.output, { workspace, direction: "output" });
    page.gauge("brain_tokens_today", "", row.cached, { workspace, direction: "cached_input" });
    page.gauge("brain_micro_usd_today", "Model cost today (UTC) in millionths of a dollar, by workspace.", row.micro, { workspace });
  }
  page.gauge("brain_approvals_pending", "Approvals waiting for a person.", one(gov, "SELECT COUNT(*) AS n FROM approvals WHERE state='pending'"));

  for (const [kind, n] of waitKinds(gov)) page.gauge("brain_tasks_waiting", "Tasks that wait to start, by why (docs/model.md, the queue).", n, { wait: kind });
  const oldest = (db.prepare("SELECT MIN(created_at_ms) AS at FROM attempts WHERE state='queued'").get() as { at: number | null }).at;
  page.gauge("brain_oldest_queued_seconds", "Age of the longest-queued attempt; 0 when none is queued.", oldest === null ? 0 : Math.max(0, Math.round((now - oldest) / 1000)));
  page.gauge("brain_schedules_overdue", "Scheduled Plays whose time passed more than five minutes ago and that have not started.", one(gov, "SELECT COUNT(*) AS n FROM triggers WHERE kind='schedule' AND next_run_at_ms IS NOT NULL AND next_run_at_ms < ?", now - OVERDUE_MS));

  const runners = listRunners(gov);
  const online = runners.filter((runner) => runner.online);
  page.gauge("brain_runners", "Enrolled runners, and how many are online.", runners.length, { state: "enrolled" });
  page.gauge("brain_runners", "", online.length, { state: "online" });
  page.gauge("brain_runner_slots", "Slots of the online runners.", online.reduce((sum, runner) => sum + runner.slots, 0));
  page.gauge("brain_runner_free_slots", "Free slots of the online runners.", online.reduce((sum, runner) => sum + runner.freeSlots, 0));

  const file = join(gov.dataDir, "brain.db");
  page.gauge("brain_sqlite_bytes", "Size of the SQLite file and of its write-ahead log.", sizeOf(file), { file: "db" });
  page.gauge("brain_sqlite_bytes", "", sizeOf(`${file}-wal`), { file: "wal" });
  page.gauge("brain_audit_events", "Length of the audit chain.", one(gov, "SELECT MAX(seq) AS n FROM events"));

  page.head("brain_http_request_duration_seconds", "Time to answer a request, by route class and status class.", "histogram");
  for (const [key, series] of [...requests].sort(([a], [b]) => a.localeCompare(b))) {
    const [route, status] = key.split("\n") as [string, string];
    BUCKETS.forEach((bound, index) => { page.raw(`brain_http_request_duration_seconds_bucket${labels({ route, status, le: String(bound) })} ${series.buckets[index]}`); });
    page.raw(`brain_http_request_duration_seconds_bucket${labels({ route, status, le: "+Inf" })} ${series.count}`);
    page.raw(`brain_http_request_duration_seconds_sum${labels({ route, status })} ${series.sum}`);
    page.raw(`brain_http_request_duration_seconds_count${labels({ route, status })} ${series.count}`);
  }
  return page.text();
}

const cached = new WeakMap<Gov, { at: number; text: string }>();

/** The route's answer. It does not exist (404) without BRAIN_METRICS_TOKEN, nor for a request that came through a proxy: a scraper reaches the Governor directly. */
export function metricsResponse(gov: Gov, c: Context, build: Build): Response {
  const token = process.env["BRAIN_METRICS_TOKEN"];
  if (!token || c.req.header("x-forwarded-for") !== undefined || c.req.header("x-real-ip") !== undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "There is nothing at this address" } }, 404);
  }
  const given = Buffer.from(/^Bearer (.+)$/u.exec(c.req.header("authorization") ?? "")?.[1] ?? "");
  const wanted = Buffer.from(token);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return c.json({ error: { code: "UNAUTHENTICATED", message: "A metrics token is required" } }, 401);
  if (!measuring) { lag.enable(); measuring = true; }
  const now = gov.clock.nowMs();
  let hit = cached.get(gov);
  if (!hit || now - hit.at >= CACHE_MS) cached.set(gov, (hit = { at: now, text: collect(gov, build, now) }));
  return new Response(hit.text, { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
}
