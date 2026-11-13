import { readFileSync, statfsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "../../application/store";
import { qualityBreakdownFor } from "../stream/quality-breakdown";
import { readProbes } from "./probes";
import { replicaConfig, replicaLag } from "./replica";

/**
 * Prometheus text exposition of what Brain knows about its missions and its own health (Phase 4). One scrape reads stored records
 * only: no model, no network. Labels are bounded (workspace, state, probe): a mission id is never a label, a mission's trace id is in
 * its events instead. `deploy/monitoring/brain-alerts.yml` alerts on exactly these names, and a test keeps the two in step.
 */
const HISTOGRAM_BUCKETS = [10, 30, 60, 120, 300, 600, 1800, 3600] as const;
const SEVERITY: Record<string, number> = { healthy: 0, degraded: 1, unavailable: 2 };

class Exposition {
  // Prometheus wants every line of a metric together, so samples are grouped under the metric that declared them.
  private readonly groups = new Map<string, { type: string; help: string; samples: string[] }>();
  declare(name: string, type: "gauge" | "counter" | "histogram", help: string): void {
    if (!this.groups.has(name)) this.groups.set(name, { type, help, samples: [] });
  }
  sample(name: string, labels: Record<string, string>, value: number): void {
    const group = this.groups.get(name) ?? this.groups.get(name.replace(/_(bucket|sum|count)$/u, ""));
    if (!group) throw new Error(`metric ${name} was not declared`);
    const pairs = Object.entries(labels).map(([key, raw]) => `${key}="${raw.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`);
    group.samples.push(`${name}${pairs.length ? `{${pairs.join(",")}}` : ""} ${Number.isFinite(value) ? value : 0}`);
  }
  text(): string {
    const lines: string[] = [];
    for (const [name, group] of this.groups) if (group.samples.length > 0) lines.push(`# HELP ${name} ${group.help}`, `# TYPE ${name} ${group.type}`, ...group.samples);
    return `${lines.join("\n")}\n`;
  }
}

/** The metrics token, read from the owner-only file `BRAIN_METRICS_TOKEN_FILE` names; `undefined` means the endpoint does not exist. */
export function metricsToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env["BRAIN_METRICS_TOKEN_FILE"];
  if (!file) return undefined;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token.length >= 16 ? token : undefined;
  } catch { return undefined; }
}

export function metricsAuthorized(header: string | null | undefined, token: string): boolean {
  const presented = /^Bearer (.+)$/u.exec(header ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(presented); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function renderMetrics(store: Store, env: NodeJS.ProcessEnv = process.env): string {
  const out = new Exposition();
  const now = store.now();
  out.declare("brain_up", "gauge", "1 while the Governor answers.");
  out.sample("brain_up", {}, 1);

  const workspaces = store.control.prepare("SELECT id, organization_id, slug FROM workspaces WHERE status='active' ORDER BY id").all() as Array<{ id: string; organization_id: string; slug: string }>;
  out.declare("brain_missions", "gauge", "Missions by state.");
  out.declare("brain_missions_achieved_total", "counter", "Missions closed as achieved.");
  out.declare("brain_work_items", "gauge", "Tasks by state.");
  out.declare("brain_parked_tasks", "gauge", "Tasks parked after repeated failure that no one has resolved: parked work waiting for a person.");
  out.declare("brain_tasks_done_total", "counter", "Tasks that reached Done.");
  out.declare("brain_tasks_parked_total", "counter", "Tasks that ever parked.");
  out.declare("brain_mission_tokens_total", "counter", "Model tokens settled for mission attempts.");
  out.declare("brain_mission_spend_micro_usd_total", "counter", "Model spend settled for mission attempts, in millionths of a dollar.");
  out.declare("brain_attempt_duration_seconds", "histogram", "Time from an attempt reserving its budget to settling it.");
  const durations: number[] = [];
  for (const workspace of workspaces) {
    const db = store.workspaceDb(workspace.id, workspace.organization_id);
    const w = { workspace: workspace.slug };
    for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM missions GROUP BY state").all() as Array<{ state: string; n: number }>) out.sample("brain_missions", { ...w, state: row.state }, row.n);
    out.sample("brain_missions_achieved_total", w, (db.prepare("SELECT COUNT(*) AS n FROM missions WHERE state='closed' AND outcome='achieved'").get() as { n: number }).n);
    for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM work_items GROUP BY state").all() as Array<{ state: string; n: number }>) out.sample("brain_work_items", { ...w, state: row.state }, row.n);
    out.sample("brain_parked_tasks", w, (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE parked=1 AND state NOT IN ('done','abandoned')").get() as { n: number }).n);
    out.sample("brain_tasks_done_total", w, (db.prepare("SELECT COUNT(DISTINCT aggregate_id) AS n FROM events WHERE event_type='workItem.transitioned' AND json_extract(payload_json,'$.state')='done'").get() as { n: number }).n);
    out.sample("brain_tasks_parked_total", w, (db.prepare("SELECT COUNT(DISTINCT aggregate_id) AS n FROM events WHERE event_type='workItem.parked'").get() as { n: number }).n);
    const spend = db.prepare("SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cached_input_tokens),0) AS c, COALESCE(SUM(settled_micro_usd),0) AS usd FROM mission_spend WHERE settled_at_ms IS NOT NULL").get() as { i: number; o: number; c: number; usd: number };
    out.sample("brain_mission_tokens_total", { ...w, kind: "input" }, spend.i);
    out.sample("brain_mission_tokens_total", { ...w, kind: "output" }, spend.o);
    out.sample("brain_mission_tokens_total", { ...w, kind: "cached_input" }, spend.c);
    out.sample("brain_mission_spend_micro_usd_total", w, spend.usd);
    for (const row of db.prepare("SELECT (settled_at_ms - created_at_ms) AS ms FROM mission_spend WHERE settled_at_ms IS NOT NULL ORDER BY settled_at_ms DESC LIMIT 5000").all() as Array<{ ms: number }>) durations.push(Math.max(0, row.ms) / 1000);
  }
  for (const bound of HISTOGRAM_BUCKETS) out.sample("brain_attempt_duration_seconds_bucket", { le: String(bound) }, durations.filter((d) => d <= bound).length);
  out.sample("brain_attempt_duration_seconds_bucket", { le: "+Inf" }, durations.length);
  out.sample("brain_attempt_duration_seconds_sum", {}, durations.reduce((sum, d) => sum + d, 0));
  out.sample("brain_attempt_duration_seconds_count", {}, durations.length);

  out.declare("brain_attempts_total", "counter", "Run attempts by state.");
  for (const row of store.control.prepare("SELECT state, COUNT(*) AS n FROM job_attempts GROUP BY state").all() as Array<{ state: string; n: number }>) out.sample("brain_attempts_total", { state: row.state }, row.n);
  out.declare("brain_jobs", "gauge", "Jobs by state.");
  for (const row of store.control.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all() as Array<{ state: string; n: number }>) out.sample("brain_jobs", { state: row.state }, row.n);
  const queue = store.control.prepare("SELECT COUNT(*) AS n, MIN(ready_at_ms) AS oldest FROM jobs WHERE state='queued'").get() as { n: number; oldest: number | null };
  out.declare("brain_queue_depth", "gauge", "Jobs waiting for a runner.");
  out.sample("brain_queue_depth", {}, queue.n);
  out.declare("brain_queue_oldest_age_seconds", "gauge", "Age of the oldest queued job; 0 when nothing waits.");
  out.sample("brain_queue_oldest_age_seconds", {}, queue.oldest === null ? 0 : Math.max(0, Math.round((now - queue.oldest) / 1000)));
  out.declare("brain_approvals_pending", "gauge", "Approvals waiting for a person.");
  out.sample("brain_approvals_pending", {}, (store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE state='pending'").get() as { n: number }).n);

  const fleet = store.control.prepare("SELECT COUNT(*) AS runners, COALESCE(SUM(slots_reserved),0) AS used, COALESCE(SUM(slot_capacity),0) AS total FROM runners WHERE admin_state='enabled' AND deregistered_at_ms IS NULL AND last_heartbeat_ms>?").get(now - 45_000) as { runners: number; used: number; total: number };
  out.declare("brain_runners_online", "gauge", "Enabled runners that sent a heartbeat in the last 45 seconds.");
  out.sample("brain_runners_online", {}, fleet.runners);
  out.declare("brain_runner_slots", "gauge", "Runner slots on online runners, used and total.");
  out.sample("brain_runner_slots", { state: "used" }, fleet.used);
  out.sample("brain_runner_slots", { state: "total" }, fleet.total);

  // Quality: the rates the alerts use, from the same read model as the Quality page (parked work stays in the denominator).
  out.declare("brain_stall_rate", "gauge", "Tasks parked in the last 30 days divided by tasks created or changed in that window, per workspace.");
  out.declare("brain_verified_unaided_rate", "gauge", "Tasks the Governor verified alone divided by tasks done plus parked and never done, last 30 days.");
  const organizations = [...new Set(workspaces.map((workspace) => workspace.organization_id))];
  for (const organizationId of organizations) {
    for (const row of qualityBreakdownFor(store, organizationId).workspaces) {
      if (row.rates.stall !== undefined) out.sample("brain_stall_rate", { workspace: row.name, practice: row.practice }, row.rates.stall);
      if (row.rates.verifiedUnaided !== undefined) out.sample("brain_verified_unaided_rate", { workspace: row.name, practice: row.practice }, row.rates.verifiedUnaided);
    }
  }

  out.declare("brain_probe_severity", "gauge", "Health check result: 0 healthy, 1 degraded, 2 unavailable. Disabled checks are not listed.");
  for (const probe of readProbes(store)) if (probe.status in SEVERITY) out.sample("brain_probe_severity", { probe: probe.id }, SEVERITY[probe.status]!);

  const replica = replicaLag(replicaConfig(env), now);
  out.declare("brain_replica_configured", "gauge", "1 when a database replica is configured.");
  out.sample("brain_replica_configured", {}, replica.status === "disabled" ? 0 : 1);
  if (replica.lagSeconds !== null) {
    out.declare("brain_replica_lag_seconds", "gauge", "Age of the newest database snapshot that reached the second host (the local snapshot when no shipper is configured).");
    out.sample("brain_replica_lag_seconds", {}, replica.lagSeconds);
  }

  try {
    const stat = statfsSync(store.dataDir);
    out.declare("brain_disk_free_bytes", "gauge", "Free bytes on the data volume.");
    out.sample("brain_disk_free_bytes", {}, Number(stat.bavail) * Number(stat.bsize));
    out.declare("brain_disk_total_bytes", "gauge", "Size of the data volume in bytes.");
    out.sample("brain_disk_total_bytes", {}, Number(stat.blocks) * Number(stat.bsize));
  } catch { /* an unreadable volume is reported by the disk probe */ }

  const stamp = env["BRAIN_BACKUP_STAMP_FILE"];
  if (stamp) {
    try {
      const seconds = Number(readFileSync(stamp, "utf8").trim());
      if (Number.isFinite(seconds) && seconds > 0) {
        out.declare("brain_backup_age_seconds", "gauge", "Seconds since the last successful nightly backup.");
        out.sample("brain_backup_age_seconds", {}, Math.max(0, Math.round(now / 1000 - seconds)));
      }
    } catch { /* no stamp yet: the alert rule treats a missing series as no recent backup */ }
  }
  return out.text();
}
