import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";
import { activeRelease, assertCurrentManifestShape, uiFoundationFromRelease } from "../configuration/read";

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
  const status = services.some((svc) => svc.status === "unavailable") ? "degraded" : "healthy";
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
  const blocked = counts.blocked ?? 0;
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
  const relRow = store.control.prepare("SELECT source_revision, compiler_digest FROM config_releases WHERE digest=? AND organization_id=?").get(rel.digest, actor.organizationId) as { source_revision: string; compiler_digest: string };
  const summary = workspaceSummary(store, actor.organizationId, workspaceId);
  const m = (JSON.parse(rel.manifest) as { manifest?: Record<string, unknown> }).manifest ?? {};
  return {
    workspace: { ...summary, workspaceId, displayName: String(wsRow["slug"]), status: String(wsRow["status"]), version: Number(wsRow["version"]) },
    release: {
      releaseId: `rel-${rel.digest.slice(7, 23)}`, sourceRevision: relRow.source_revision,
      configDigest: rel.digest, compilerDigest: relRow.compiler_digest,
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
    // Default-landing rule: active sessions/runs open the Live console.
    defaultRoute: activeSessions > 0 || activeRuns > 0 ? "live" : "today",
    observedAt: store.nowIso(),
  } as unknown as JsonValue;
}
