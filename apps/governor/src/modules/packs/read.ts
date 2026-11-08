import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { domainDigest } from "@brain/contracts";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { sumIntervalMs, type SlaInterval } from "./sla";

type WorkspaceDb = ReturnType<Store["workspaceDb"]>;

/** Pack view mappers: contract views derived from stored rows only. */
function artifactRef(ws: WorkspaceDb, digest: string, fallbackId: string): Record<string, unknown> | undefined {
  const row = ws.prepare("SELECT id, bytes, media_type, classification FROM artifacts WHERE digest=? ORDER BY created_at_ms LIMIT 1").get(digest) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return { artifactId: String(row["id"] ?? fallbackId), digest, bytes: Number(row["bytes"]), mediaType: String(row["media_type"]), classification: String(row["classification"]) };
}

function ticketView(workspaceId: string, r: Record<string, unknown>, detail: boolean, ws: WorkspaceDb): Record<string, unknown> {
  const observed = Number(r["observed_at_ms"]);
  const created = Number(r["created_at_ms"] ?? 0) || observed;
  const states = ["open", "pending", "resolved", "closed"];
  const base: Record<string, unknown> = {
    id: String(r["id"]), workspaceId, version: Number(r["version"] ?? 1), updatedAt: iso(observed),
    title: String(r["title"]), state: states.includes(String(r["state"])) ? String(r["state"]) : "open",
    priority: String(r["priority"] ?? "normal"), sourceVersion: String(r["source_version"]),
    // Evidence is ready only when a reviewed draft exists for this ticket.
    evidenceReady: !!ws.prepare("SELECT 1 FROM support_drafts WHERE ticket_id=? AND approval_id IS NOT NULL LIMIT 1").get(String(r["id"])),
    createdAt: iso(created),
  };
  if (detail) {
    const body = artifactRef(ws, String(r["body_digest"]), `ticket-body-${String(r["id"])}`);
    base["body"] = body ?? { artifactId: `ticket-body-${String(r["id"])}`, digest: String(r["body_digest"]), bytes: 0, mediaType: "text/plain", classification: "internal" };
    const draft = ws.prepare("SELECT content_digest, approval_id FROM support_drafts WHERE ticket_id=? ORDER BY version DESC LIMIT 1").get(String(r["id"])) as Record<string, unknown> | undefined;
    if (draft) {
      const ref = artifactRef(ws, String(draft["content_digest"]), `draft-${String(r["id"])}`);
      if (ref) base["draft"] = ref;
      if (draft["approval_id"]) base["approvalId"] = String(draft["approval_id"]);
    }
  }
  return base;
}

function incidentView(workspaceId: string, r: Record<string, unknown>, detail: boolean, ws: WorkspaceDb): Record<string, unknown> {
  const opened = Number(r["opened_at_ms"]);
  const latest = ws.prepare("SELECT MAX(observed_at_ms) AS observed, MAX(expires_at_ms) AS expires FROM observations WHERE incident_id=?").get(String(r["id"])) as { observed: number | null; expires: number | null };
  const observedAt = latest.observed ?? opened;
  const expiresAt = latest.expires ?? observedAt;
  const resolved = r["resolved_at_ms"] == null ? null : Number(r["resolved_at_ms"]);
  const title = String(r["title"] ?? "") || `${String(r["severity"])} incident: ${String(r["target_key"])}`;
  const base: Record<string, unknown> = {
    id: String(r["id"]), workspaceId, version: Number(r["version"]), updatedAt: iso(resolved ?? observedAt),
    title, state: String(r["state"]), severity: String(r["severity"]), targetKey: String(r["target_key"]),
    observedAt: iso(observedAt), expiresAt: iso(expiresAt), createdAt: iso(opened),
  };
  if (detail) {
    const obs = ws.prepare("SELECT observation_digest FROM observations WHERE incident_id=? ORDER BY observed_at_ms LIMIT 100").all(String(r["id"])) as Array<{ observation_digest: string }>;
    base["observations"] = obs.map((o) => artifactRef(ws, o.observation_digest, `observation-${o.observation_digest.slice(7, 19)}`)).filter(Boolean);
  }
  return base;
}


const LIST_TABLES: Record<string, string> = { "tickets.list": "tickets", "incidents.list": "incidents" };
const GET_TABLES: Record<string, string> = { "ticket.get": "tickets", "incident.get": "incidents" };

/**
 * Pack list reads: tickets and incidents from the workspace,
 * members from control-side grants, audit from the event log.
 */
export function listPack(store: Store, actor: ActorContext, queryType: string, workspaceId: string | undefined): JsonValue {
  if (!workspaceId) return { items: [] } as unknown as JsonValue;
  if (queryType === "members.list") {
    const rows = store.control.prepare("SELECT principal_id, role, version, granted_at_ms, revoked_at_ms FROM workspace_memberships WHERE workspace_id=?").all(workspaceId) as Array<Record<string, unknown>>;
    const byPrincipal = new Map<string, { roles: string[]; version: number; createdAtMs: number; revoked: boolean }>();
    for (const r of rows) {
      const pid = String(r["principal_id"]);
      const cur = byPrincipal.get(pid) ?? { roles: [], version: 0, createdAtMs: Number(r["granted_at_ms"]), revoked: true };
      if (r["revoked_at_ms"] == null) { cur.roles.push(String(r["role"])); cur.revoked = false; }
      cur.version = Math.max(cur.version, Number(r["version"]));
      cur.createdAtMs = Math.min(cur.createdAtMs, Number(r["granted_at_ms"]));
      byPrincipal.set(pid, cur);
    }
    const items = [...byPrincipal.entries()].map(([principalId, g]) => ({
      id: `grant-${workspaceId}-${principalId}`, workspaceId, principalId,
      roles: g.roles, version: g.version, revoked: g.revoked, createdAt: iso(g.createdAtMs),
    }));
    return { items } as unknown as JsonValue;
  }
  if (queryType === "audit.list") {
    const rows = store.control.prepare("SELECT cursor, event_id, event_type, aggregate_id, payload_json, payload_digest, created_at_ms FROM events WHERE organization_id=? AND workspace_id=? ORDER BY cursor DESC LIMIT 50").all(actor.organizationId, workspaceId) as Array<Record<string, unknown>>;
    return { items: rows.map((r) => {
      let actorId = "system";
      try {
        const payload = JSON.parse(String(r["payload_json"])) as Record<string, unknown>;
        actorId = String(payload["actorId"] ?? payload["actorRef"] ?? payload["requestedBy"] ?? "system");
      } catch { /* payload is digest-bound; actor stays system */ }
      return { id: String(r["event_id"]), cursor: Number(r["cursor"]), actorId, action: String(r["event_type"]), resourceId: String(r["aggregate_id"]), occurredAt: iso(Number(r["created_at_ms"])), payloadDigest: String(r["payload_digest"]) };
    }) } as unknown as JsonValue;
  }
  const table = LIST_TABLES[queryType];
  if (!table) return { items: [] } as unknown as JsonValue;
  const ws = store.workspaceDb(workspaceId, actor.organizationId);
  const rows = ws.prepare(`SELECT * FROM ${table} LIMIT 50`).all() as Array<Record<string, unknown>>;
  const items = rows.map((r) => {
    switch (queryType) {
      case "tickets.list": return ticketView(workspaceId, r, false, ws);
      case "incidents.list": return incidentView(workspaceId, r, false, ws);
      default: return r;
    }
  });
  return { items } as unknown as JsonValue;
}

/** Pack detail reads: one ticket or incident, or an evidence bundle by digest. */
export function getPack(store: Store, actor: ActorContext, queryType: string, workspaceId: string | undefined, resourceId: string): JsonValue {
  if (queryType === "evidence.get") {
    // resourceId is a bundle digest or bundle id; search caller workspaces.
    const candidates = workspaceId ? [workspaceId] : (store.control.prepare("SELECT workspace_id FROM workspace_memberships WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL").all(actor.organizationId, actor.actorId) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
    for (const wsId of candidates) {
      const ws = store.workspaceDb(wsId, actor.organizationId);
      const row = ws.prepare("SELECT manifest_json FROM evidence_bundles WHERE digest=? OR bundle_id=?").get(resourceId, resourceId) as { manifest_json: string } | undefined;
      if (row) {
        const verdict = ws.prepare("SELECT manifest_json FROM verification_verdicts WHERE bundle_digest=? ORDER BY created_at_ms DESC LIMIT 1").get(resourceId) as { manifest_json: string } | undefined;
        return { bundle: JSON.parse(row.manifest_json) as JsonValue, ...(verdict ? { verdict: JSON.parse(verdict.manifest_json) as JsonValue } : {}) } as unknown as JsonValue;
      }
    }
    throw new BrainDomainError("NOT_FOUND", "evidence not found");
  }
  if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
  requireWorkspaceRead(store, actor, workspaceId);
  const ws = store.workspaceDb(workspaceId, actor.organizationId);
  const table = GET_TABLES[queryType];
  if (!table) throw new BrainDomainError("NOT_FOUND", "resource not found");
  const row = ws.prepare(`SELECT * FROM ${table} WHERE id=?`).get(resourceId) as Record<string, unknown> | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "resource not found");
  const view = queryType === "ticket.get" ? ticketView(workspaceId, row, true, ws)
    : queryType === "incident.get" ? incidentView(workspaceId, row, true, ws)
      : row;
  return view as unknown as JsonValue;
}

/** sla.summary: interval ownership over the period, summed once via the SLA module. */
export function slaSummary(
  store: Store,
  actor: ActorContext,
  workspaceId: string,
  periodStart: number,
  periodEnd: number,
): JsonValue {
  const ws = store.workspaceDb(workspaceId, actor.organizationId);
  const now = store.now();
  const rawIntervals = (ws.prepare("SELECT responsibility, started_at_ms, ended_at_ms, calendar_digest FROM sla_intervals").all() as Array<Record<string, unknown>>)
    .filter((i) => Number(i["started_at_ms"]) < periodEnd && Number(i["ended_at_ms"] ?? periodEnd) > periodStart);
  const intervals = rawIntervals.map((i): SlaInterval => ({ responsibility: String(i["responsibility"]), startedAtMs: Number(i["started_at_ms"]), endedAtMs: i["ended_at_ms"] == null ? null : Number(i["ended_at_ms"]) }));
  const starts = intervals.map((i) => i.startedAtMs);
  const ends = intervals.map((i) => i.endedAtMs ?? now);
  return {
    workspaceId,
    calendarDigest: rawIntervals[0] ? String(rawIntervals[0]["calendar_digest"]) : domainDigest("brain:sla-calendar:v1", { intervals: 0 }),
    periodStart: iso(starts.length ? Math.min(...starts) : periodStart || now),
    periodEnd: iso(ends.length ? Math.max(...ends) : periodEnd),
    sampleCount: intervals.length,
    // No SLA target thresholds are declared in configuration yet, so
    // met-counts stay 0 rather than claiming attainment.
    responseMet: 0, resolutionMet: 0,
    keyrusMs: sumIntervalMs(intervals, "keyrus", now), clientWaitMs: sumIntervalMs(intervals, "client", now), hubWaitMs: sumIntervalMs(intervals, "hub", now),
    incompleteRecords: intervals.filter((i) => i.endedAtMs == null).length,
    sourceWatermark: ends.length ? Math.max(...ends) : 0,
  } as unknown as JsonValue;
}
