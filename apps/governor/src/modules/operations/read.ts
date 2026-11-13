import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";
import { readProbes } from "./probes";
import { smtpTarget } from "./smtp";
import { activeRelease, assertCurrentManifestShape, releaseRecord, uiFoundationFromRelease } from "../configuration/index";

export interface MemoryProbe {
  status: "healthy" | "unavailable" | "disabled";
  detail: string;
  checkedAt: string;
}

/** platform.health: the memory service's real reachability, not a constant. */
export function platformHealth(store: Store, probe: MemoryProbe): JsonValue {
  const pending = store.control.prepare("SELECT COUNT(*) AS c FROM outbox_deliveries WHERE state IN ('pending','processing')").get() as { c: number };
  const services = [
    { id: "governor", status: "healthy", checkedAt: store.nowIso(), detail: "control.db reachable" },
    { id: "memory-local", status: probe.status, checkedAt: probe.checkedAt || store.nowIso(), detail: probe.detail },
  ];
  // Runners that are online and able to take work: how many of their slots are taken right now.
  const fleet = store.control.prepare("SELECT COUNT(*) AS runners, COALESCE(SUM(slots_reserved),0) AS used, COALESCE(SUM(slot_capacity),0) AS total FROM runners WHERE admin_state='enabled' AND last_heartbeat_ms>?").get(store.now() - 45_000) as { runners: number; used: number; total: number };
  if (fleet.runners > 0) services.push({ id: "runners", status: "healthy", checkedAt: store.nowIso(), detail: `${fleet.used} of ${fleet.total} slots in use on ${fleet.runners} online ${fleet.runners === 1 ? "runner" : "runners"}` });
  services.push(...engineServices(store));
  const status = services.some((svc) => svc.status === "unavailable" || svc.status === "degraded") ? "degraded" : "healthy";
  return { status, services, pendingOutbox: pending.c, oldestOutboxAgeMs: 0, schemaVersion: "1" } as unknown as JsonValue;
}

/** The WorkspaceSummary the bridge screen renders, derived from the live rows. */
export interface WorkspaceSummaryView {
  workspaceId: string;
  displayName: string;
  status: string;
  description: string;
  ownerId?: string;
  tags: string[];
  version: number;
  health: string;
  observedAt: string;
  activeJobs: number;
  pendingApprovals: number;
  blockedJobs: number;
  dailyMicroUsd: number;
}

export function workspaceSummary(store: Store, organizationId: string, workspaceId: string): WorkspaceSummaryView {
  const wsRow = store.control.prepare("SELECT * FROM workspaces WHERE id=? AND organization_id=?").get(workspaceId, organizationId) as Record<string, unknown> | undefined;
  const counts = store.control.prepare(`SELECT
    SUM(CASE WHEN state IN ('queued','leased','running','verifying') THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN state='blocked' THEN 1 ELSE 0 END) AS blocked
    FROM jobs WHERE organization_id=? AND workspace_id=?`).get(organizationId, workspaceId) as { active: number | null; blocked: number | null };
  const pending = store.control.prepare("SELECT COUNT(*) AS c FROM approval_requests WHERE organization_id=? AND workspace_id=? AND state='pending'").get(organizationId, workspaceId) as { c: number };
  // Work a person has to decide on counts as blocked too: a parked task stops its mission as surely as a blocked job does.
  let parkedWork = 0;
  try {
    parkedWork = (store.workspaceDb(workspaceId, organizationId).prepare("SELECT COUNT(*) AS n FROM work_items w JOIN missions m ON m.id=w.mission_id WHERE w.state='blocked' AND m.state='active'").get() as { n: number }).n;
  } catch { /* a workspace that cannot be read keeps its job counts */ }
  const blocked = (counts.blocked ?? 0) + parkedWork;
  return {
    workspaceId, displayName: String(wsRow?.slug ?? workspaceId), status: String(wsRow?.status ?? "active"),
    description: String(wsRow?.["description"] ?? ""), ...(wsRow?.["owner_id"] ? { ownerId: String(wsRow["owner_id"]) } : {}), tags: JSON.parse(String(wsRow?.["tags_json"] ?? "[]")) as string[], version: Number(wsRow?.["version"] ?? 1),
    health: blocked > 0 ? "degraded" : "healthy", observedAt: store.nowIso(),
    activeJobs: counts.active ?? 0, pendingApprovals: pending.c, blockedJobs: blocked, dailyMicroUsd: 0,
  };
}

/** workspace.context: the workspace, its active release, and the command surface. */
export function workspaceContext(store: Store, actor: ActorContext, workspaceId: string): JsonValue {
  const wsRow = store.control.prepare("SELECT id, slug, status, version, description, owner_id, tags_json FROM workspaces WHERE id=?").get(workspaceId) as Record<string, unknown>;
  const rel = activeRelease(store, actor.organizationId);
  if (!rel) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "No active configuration release — stage and activate one in Settings to use this workspace.");
  assertCurrentManifestShape(rel);
  const relRow = releaseRecord(store, actor.organizationId, rel.digest)!;
  const summary = workspaceSummary(store, actor.organizationId, workspaceId);
  const m = (JSON.parse(rel.manifest) as { manifest?: Record<string, unknown> }).manifest ?? {};
  return {
    workspace: { ...summary, workspaceId, displayName: String(wsRow["slug"]), status: String(wsRow["status"]), version: Number(wsRow["version"]) },
    release: {
      releaseId: `rel-${rel.digest.slice(7, 23)}`, sourceRevision: relRow.sourceRevision,
      configDigest: rel.digest, compilerDigest: relRow.compilerDigest,
      irArtifact: m["irArtifact"] as JsonValue,
      assets: m["assets"] as JsonValue,
      primitiveVersions: m["primitiveVersions"] as JsonValue,
    },
    allowedCommands: [...new Set(actor.scopes)] as unknown as JsonValue,
    features: { web: "enabled", memory: "degraded", mastra: "enabled", tencentdb: process.env["BRAIN_TENCENTDB_URL"] ? "enabled" : "blocked" },
    ui: uiFoundationFromRelease(rel) as unknown as JsonValue,
  } as unknown as JsonValue;
}

/** live.status: what the Live console needs to land on, right now. */
export function liveStatus(store: Store, actor: ActorContext, workspaceId: string): JsonValue {
  const ws = store.workspaceDb(workspaceId, actor.organizationId);
  const activeSessions = (ws.prepare("SELECT COUNT(*) AS c FROM sessions WHERE state IN ('starting','running','waiting','stopping')").get() as { c: number }).c;
  const activeRuns = (store.control.prepare("SELECT COUNT(*) AS c FROM jobs WHERE organization_id=? AND workspace_id=? AND state IN ('queued','offered','running','verifying')").get(actor.organizationId, workspaceId) as { c: number }).c;
  const pendingApprovals = (store.control.prepare("SELECT COUNT(*) AS c FROM approval_requests WHERE organization_id=? AND workspace_id=? AND state='pending'").get(actor.organizationId, workspaceId) as { c: number }).c;
  const unknownJobs = (store.control.prepare("SELECT COUNT(*) AS c FROM jobs WHERE organization_id=? AND workspace_id=? AND state IN ('outcome_unknown','blocked','failed')").get(actor.organizationId, workspaceId) as { c: number }).c;
  return {
    workspaceId,
    activeSessions,
    activeRuns,
    needsAttention: pendingApprovals > 0 || unknownJobs > 0,
    pendingApprovals,
    unknownJobs,
    observedAt: store.nowIso(),
  } as unknown as JsonValue;
}

/**
 * What Health says about the layers below the application: the model endpoint, the launcher (as the runners report it), free disk and,
 * only while a workspace uses one, the hosted model (ADR 0023). A hosted model that is down says checks and second attempts wait.
 */
function engineServices(store: Store): Array<{ id: string; status: string; checkedAt: string; detail: string }> {
  const out: Array<{ id: string; status: string; checkedAt: string; detail: string }> = [];
  const probes = readProbes(store);
  for (const id of ["model", "disk", "replica"]) {
    const probe = probes.find((entry) => entry.id === id);
    if (probe) out.push({ id, status: probe.status, checkedAt: probe.checkedAt, detail: probe.detail });
  }
  // Email is optional and off by default; when it is on, Health says how the last delivery went (a test email from Settings checks it on demand).
  const email = probes.find((entry) => entry.id === "email");
  if (!smtpTarget()) out.push({ id: "email", status: "disabled", checkedAt: store.nowIso(), detail: "Email is off. Set BRAIN_NOTIFY_SMTP_URL and BRAIN_NOTIFY_FROM on the server to turn it on, then send a test email from Settings." });
  else out.push({ id: "email", status: email?.status ?? "healthy", checkedAt: email?.checkedAt ?? store.nowIso(), detail: email?.detail ?? "Email is configured; no email has been sent yet. Send a test email from Settings." });
  const hosted = probes.filter((entry) => entry.id.startsWith("hosted:"));
  if (hosted.length > 0) {
    const down = hosted.filter((entry) => entry.status === "unavailable");
    out.push({ id: "hosted-model", status: down.length > 0 ? "unavailable" : "healthy", checkedAt: hosted[0]!.checkedAt,
      detail: down.length > 0 ? `${down.length} of ${hosted.length} hosted models are down: checks and second attempts for those workspaces wait until they are back.` : "Every hosted model answers." });
  }
  // The launcher is judged from the runners that use one: a runner that cannot reach it reports itself degraded or unhealthy.
  const online = store.control.prepare("SELECT health FROM runners WHERE admin_state='enabled' AND deregistered_at_ms IS NULL AND last_heartbeat_ms>?").all(store.now() - 45_000) as Array<{ health: string }>;
  if (online.length > 0) {
    const healthy = online.filter((runner) => runner.health === "healthy").length;
    out.push({ id: "launcher", status: healthy === online.length ? "healthy" : healthy === 0 ? "unavailable" : "degraded", checkedAt: store.nowIso(),
      detail: healthy === online.length ? "Every runner reaches its sandbox launcher." : `${online.length - healthy} of ${online.length} runners report a problem (sandbox launcher or Docker); sandboxed tools may fail until it is restarted.` });
  }
  return out;
}
