import { statfsSync } from "node:fs";
import type { Store } from "../../application/store";
import { modelEndpoint } from "./local-runtime";
import { backupStatus, restoreTestStatus } from "./backup-status";
import { replicaLag, type ReplicaConfig } from "./replica";

/**
 * Periodic checks Health reports and alerts on: the model endpoint, the hosted model of each workspace that switched it on, and free
 * disk. Each check stores its latest result in `service_probes`; a check that turns bad is alerted once (not on every pass) and
 * alerts again only after it recovered.
 */
export type ProbeStatus = "healthy" | "degraded" | "unavailable" | "disabled";
export interface ProbeRow { id: string; status: ProbeStatus; detail: string; checkedAt: string }

const GIB = 1024 ** 3;
/** Free space below which Health warns, and below which it is critical. Fractions and bytes: whichever is worse decides. */
export const DISK_WARN = { freeBytes: 5 * GIB, freeFraction: 0.15 };
export const DISK_CRITICAL = { freeBytes: 1 * GIB, freeFraction: 0.05 };

/** Pure: the disk status for a free/total reading. */
export function diskStatus(freeBytes: number, totalBytes: number): { status: ProbeStatus; detail: string } {
  const fraction = totalBytes > 0 ? freeBytes / totalBytes : 1;
  const words = `${(freeBytes / GIB).toFixed(1)} GiB free (${Math.round(fraction * 100)}% of ${(totalBytes / GIB).toFixed(0)} GiB)`;
  if (freeBytes < DISK_CRITICAL.freeBytes || fraction < DISK_CRITICAL.freeFraction) return { status: "unavailable", detail: `Disk is almost full: ${words}. Backups and new work will fail soon; free space now.` };
  if (freeBytes < DISK_WARN.freeBytes || fraction < DISK_WARN.freeFraction) return { status: "degraded", detail: `Disk is filling up: ${words}. Free space before it runs out.` };
  return { status: "healthy", detail: `Disk has ${words}.` };
}

export function recordProbe(s: Store, id: string, status: ProbeStatus, detail: string): void {
  s.control.prepare(`INSERT INTO service_probes(id,status,detail,checked_at_ms) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,detail=excluded.detail,checked_at_ms=excluded.checked_at_ms`).run(id, status, detail.slice(0, 500), s.now());
}

export function readProbes(s: Store): ProbeRow[] {
  return (s.control.prepare("SELECT id,status,detail,checked_at_ms FROM service_probes ORDER BY id").all() as Array<{ id: string; status: ProbeStatus; detail: string; checked_at_ms: number }>)
    .map((row) => ({ id: row.id, status: row.status, detail: row.detail, checkedAt: new Date(row.checked_at_ms).toISOString() }));
}

/** Free disk under the data directory, recorded as the `disk` probe. */
export function checkDisk(s: Store, read: (path: string) => { bavail: number | bigint; blocks: number | bigint; bsize: number | bigint } = statfsSync): void {
  try {
    const stat = read(s.dataDir);
    const free = Number(stat.bavail) * Number(stat.bsize);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const result = diskStatus(free, total);
    recordProbe(s, "disk", result.status, result.detail);
  } catch { recordProbe(s, "disk", "degraded", "Free disk could not be read."); }
}

/** How far behind the second host's copy of the databases is (ADR 0027), recorded as the `replica` probe; `disabled` when no replica is configured. */
export function checkReplica(s: Store, config: ReplicaConfig | undefined): void {
  const lag = replicaLag(config, s.now());
  recordProbe(s, "replica", lag.status, lag.detail);
}

/** The last backup and the last restore test, as the host job recorded them (ADR 0039), recorded as the `backup` and `restore-test` probes. */
export function checkBackups(s: Store, env: NodeJS.ProcessEnv = process.env): void {
  const backup = backupStatus(s.now(), env);
  recordProbe(s, "backup", backup.status, backup.detail);
  const restore = restoreTestStatus(s.now(), env);
  recordProbe(s, "restore-test", restore.status, restore.detail);
}

async function reach(url: string, apiKey: string | undefined, fetchImpl: typeof fetch): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetchImpl(`${url.replace(/\/$/u, "")}/models`, { redirect: "error", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(5000) });
    return response.ok ? { ok: true, detail: "reachable" } : { ok: false, detail: `answered HTTP ${response.status}` };
  } catch { return { ok: false, detail: "did not answer" }; }
}

/** The self-hosted model endpoint, recorded as the `model` probe. Workers, planning and checks all depend on it. */
export async function checkModelEndpoint(s: Store, fetchImpl: typeof fetch = fetch): Promise<void> {
  const endpoint = modelEndpoint(s);
  if (!endpoint) { recordProbe(s, "model", "disabled", "No model endpoint is configured on the Governor."); return; }
  const result = await reach(endpoint.url, endpoint.apiKey, fetchImpl);
  recordProbe(s, "model", result.ok ? "healthy" : "unavailable", result.ok ? "The model endpoint answers." : `The model endpoint ${result.detail}: tasks cannot be planned, worked or checked until it is back.`);
}

/** The hosted model of every workspace that switched it on (ADR 0023): one `hosted:<workspace>` probe each; a workspace that switched it off loses its probe. */
export async function checkHostedModels(s: Store, fetchImpl: typeof fetch = fetch): Promise<void> {
  const enabled = s.control.prepare("SELECT workspace_id, vendor, base_url FROM workspace_hosted_model WHERE enabled=1").all() as Array<{ workspace_id: string; vendor: string; base_url: string }>;
  const ids = new Set(enabled.map((row) => `hosted:${row.workspace_id}`));
  for (const row of s.control.prepare("SELECT id FROM service_probes WHERE id LIKE 'hosted:%'").all() as Array<{ id: string }>) {
    if (!ids.has(row.id)) s.control.prepare("DELETE FROM service_probes WHERE id=?").run(row.id);
  }
  for (const row of enabled) {
    const result = await reach(row.base_url, process.env["BRAIN_HOSTED_MODEL_API_KEY"], fetchImpl);
    recordProbe(s, `hosted:${row.workspace_id}`, result.ok ? "healthy" : "unavailable",
      result.ok ? `The hosted model (${row.vendor}) answers.` : `The hosted model (${row.vendor}) ${result.detail}: checks and second attempts for this workspace wait until it is back.`);
  }
}

/**
 * Alerts the owner of each active workspace once when a check turns degraded or unavailable (an in-app notification, pushed on the
 * owner's channels). Returns how many notifications were written. A check that recovered re-arms.
 */
export function alertBadProbes(s: Store): Array<{ organizationId: string; workspaceId: string; ownerId: string; id: string; title: string; detail: string }> {
  const out: Array<{ organizationId: string; workspaceId: string; ownerId: string; id: string; title: string; detail: string }> = [];
  for (const probe of s.control.prepare("SELECT id,status,detail,alerted_status FROM service_probes").all() as Array<{ id: string; status: ProbeStatus; detail: string; alerted_status: string }>) {
    const bad = probe.status === "degraded" || probe.status === "unavailable";
    if (!bad) { if (probe.alerted_status !== "healthy") s.control.prepare("UPDATE service_probes SET alerted_status='healthy' WHERE id=?").run(probe.id); continue; }
    // Alert again only when it got worse (degraded to unavailable) or after it recovered.
    if (probe.alerted_status === probe.status || (probe.alerted_status === "unavailable" && probe.status === "degraded")) continue;
    const workspaces = (probe.id.startsWith("hosted:")
      ? s.control.prepare("SELECT id, organization_id, owner_id FROM workspaces WHERE id=? AND status='active' AND owner_id IS NOT NULL").all(probe.id.slice(7))
      : s.control.prepare("SELECT id, organization_id, owner_id FROM workspaces WHERE status='active' AND owner_id IS NOT NULL").all()) as Array<{ id: string; organization_id: string; owner_id: string }>;
    const title = probe.id === "disk" ? "Disk is filling up" : probe.id === "model" ? "The model endpoint is down" : probe.id === "replica" ? "The database replica is behind"
      : probe.id === "backup" ? "The last backup is stale" : probe.id === "restore-test" ? "The last restore test needs attention" : "The hosted model is down";
    for (const workspace of workspaces) {
      const db = s.workspaceDb(workspace.id, workspace.organization_id);
      db.prepare("INSERT INTO attention_notifications(principal_id,item_id,mission_id,title,pushed,sent_at_ms) VALUES (?,?,NULL,?,0,?) ON CONFLICT(principal_id,item_id) DO UPDATE SET title=excluded.title,sent_at_ms=excluded.sent_at_ms,pushed=0")
        .run(workspace.owner_id, `platform:${probe.id}`, `${title}: ${probe.detail}`.slice(0, 256), s.now());
      out.push({ organizationId: workspace.organization_id, workspaceId: workspace.id, ownerId: workspace.owner_id, id: probe.id, title, detail: probe.detail });
    }
    s.control.prepare("UPDATE service_probes SET alerted_status=? WHERE id=?").run(probe.status, probe.id);
  }
  return out;
}
