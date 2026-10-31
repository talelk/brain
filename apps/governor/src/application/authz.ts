import { randomBytes } from "node:crypto";
import type { ActorContext } from "@brain/contracts";
import { commandDef, roleScopes } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import type { Store } from "./store";
import type { BrainAuth, VerifiedSession } from "../modules/identity/index";

export interface ResolvedActor {
  readonly actor: ActorContext;
  readonly principalId: string;
  readonly sessionDigest: string;
  readonly humanSession: VerifiedSession | null;
}

interface SessionRow {
  principal_id: string; organization_id: string; expires_at_ms: number; revoked_at_ms: number | null;
}

export function issueMachineSession(store: Store, principalId: string, organizationId: string, ttlMs = 3600_000): string {
  const principal = store.control.prepare("SELECT kind, disabled_at_ms FROM principals WHERE id=? AND organization_id=?").get(principalId, organizationId) as { kind: string; disabled_at_ms: number | null } | undefined;
  if (!principal || principal.disabled_at_ms !== null || !["agent", "workflow", "kiosk"].includes(principal.kind)) throw new BrainDomainError("FORBIDDEN", "machine credentials require an enabled machine principal");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 3600_000) throw new BrainDomainError("INVALID_ARGUMENT", "machine session lifetime exceeds one hour");
  const token = randomBytes(32).toString("base64url");
  const digest = store.tokenDigest("machine-session", token);
  store.control.prepare("INSERT INTO machine_sessions(token_digest, principal_id, organization_id, expires_at_ms, created_at_ms) VALUES (?,?,?,?,?)")
    .run(digest, principalId, organizationId, store.now() + ttlMs, store.now());
  return token;
}

export function scopesForPrincipal(store: Store, principalId: string, organizationId: string, workspaceId?: string): string[] {
  const scopes = new Set<string>();
  const orgRows = store.control.prepare(
    "SELECT role FROM organization_authorizations WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL",
  ).all(organizationId, principalId) as Array<{ role: string }>;
  for (const r of orgRows) for (const s of roleScopes(r.role)) scopes.add(s);
  if (workspaceId) {
    const wsRows = store.control.prepare(
      "SELECT role FROM workspace_memberships WHERE workspace_id=? AND organization_id=? AND principal_id=? AND revoked_at_ms IS NULL",
    ).all(workspaceId, organizationId, principalId) as Array<{ role: string }>;
    for (const r of wsRows) for (const s of roleScopes(r.role)) scopes.add(s);
  }
  return [...scopes].sort();
}

export function hasWorkspaceMembership(store: Store, principalId: string, organizationId: string, workspaceId: string): boolean {
  const row = store.control.prepare(
    "SELECT 1 AS ok FROM workspace_memberships WHERE workspace_id=? AND organization_id=? AND principal_id=? AND revoked_at_ms IS NULL LIMIT 1",
  ).get(workspaceId, organizationId, principalId);
  return row !== undefined;
}

export async function resolveActor(store: Store, auth: BrainAuth, headers: Headers, workspaceId?: string): Promise<ResolvedActor> {
  // This development hook is never a strong human session and cannot step up.
  const test = store.allowTestActor ? headers.get("x-brain-test-actor") : null;
  if (test) {
    const [principalId, organizationId] = test.split(":");
    const p = store.control.prepare("SELECT kind, disabled_at_ms FROM principals WHERE id=? AND organization_id=?").get(principalId, organizationId) as { kind: ActorContext["kind"]; disabled_at_ms: number | null } | undefined;
    if (!p || p.disabled_at_ms !== null || !principalId || !organizationId) throw new BrainDomainError("UNAUTHENTICATED", "unknown test principal");
    return { principalId, sessionDigest: "test", humanSession: null, actor: { kind: p.kind, actorId: principalId, organizationId, ...(workspaceId ? { workspaceId } : {}), scopes: scopesForPrincipal(store, principalId, organizationId, workspaceId), authMethod: "session", authGeneration: 1 } };
  }
  const authorization = headers.get("authorization") ?? "";
  const token = /^Bearer /iu.test(authorization) ? authorization.slice(7).trim() : "";
  if (authorization && !token) throw new BrainDomainError("UNAUTHENTICATED", "invalid credential scheme");
  const digest = token ? store.tokenDigest("machine-session", token) : "";
  const machine = token ? store.control.prepare("SELECT principal_id,organization_id,expires_at_ms,revoked_at_ms FROM machine_sessions WHERE token_digest=?").get(digest) as SessionRow | undefined : undefined;
  let principalId: string;
  let organizationId: string;
  let sessionDigest: string;
  let humanSession: VerifiedSession | null = null;
  if (machine) {
    if (machine.revoked_at_ms !== null || machine.expires_at_ms <= store.now()) throw new BrainDomainError("UNAUTHENTICATED", "machine credential revoked or expired");
    principalId = machine.principal_id; organizationId = machine.organization_id; sessionDigest = digest;
  } else {
    // Invalid explicit bearer credentials must never fall back to an ambient cookie.
    const credentials = new Headers(headers);
    if (token) credentials.delete("cookie");
    humanSession = await auth.readSession(credentials);
    if (!humanSession) throw new BrainDomainError("UNAUTHENTICATED", "human session missing, revoked or expired");
    const rows = store.control.prepare("SELECT p.id, p.organization_id, o.auth_organization_id FROM principals p JOIN organizations o ON o.id=p.organization_id WHERE p.kind='human' AND p.auth_subject_id=? AND p.disabled_at_ms IS NULL").all(humanSession.userId) as Array<{ id: string; organization_id: string; auth_organization_id: string }>;
    const requested = headers.get("x-brain-organization-id");
    const workspace = workspaceId ? store.control.prepare("SELECT organization_id FROM workspaces WHERE id=?").get(workspaceId) as { organization_id: string } | undefined : undefined;
    const candidates = rows.filter((r) => (!requested || r.organization_id === requested) && (!workspaceId || workspace?.organization_id === r.organization_id));
    const selected = candidates.find((r) => r.auth_organization_id === humanSession!.activeOrganizationId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!selected || !auth.hasMembership(humanSession.userId, selected.auth_organization_id)) throw new BrainDomainError("FORBIDDEN", "current organization membership required");
    principalId = selected.id; organizationId = selected.organization_id;
    sessionDigest = store.tokenDigest("auth-session", humanSession.sessionId);
  }
  const principal = store.control.prepare("SELECT kind, disabled_at_ms FROM principals WHERE id=? AND organization_id=?").get(principalId, organizationId) as { kind: ActorContext["kind"]; disabled_at_ms: number | null } | undefined;
  if (!principal || principal.disabled_at_ms !== null || (humanSession ? principal.kind !== "human" : !["agent", "workflow", "kiosk"].includes(principal.kind))) throw new BrainDomainError("UNAUTHENTICATED", "principal disabled or credential class mismatch");
  const org = store.control.prepare("SELECT revocation_generation FROM organizations WHERE id=?").get(organizationId) as { revocation_generation: number } | undefined;
  if (!org) throw new BrainDomainError("UNAUTHENTICATED", "organization missing");
  return { principalId, sessionDigest, humanSession, actor: { kind: principal.kind, actorId: principalId, organizationId, ...(workspaceId ? { workspaceId } : {}), scopes: scopesForPrincipal(store, principalId, organizationId, workspaceId), authMethod: humanSession ? "session" : "machine-credential", authGeneration: org.revocation_generation } };
}

export function authorizeCommand(actor: ActorContext, commandType: string): void {
  const def = commandDef(commandType);
  if (!def) throw new BrainDomainError("INVALID_CONTRACT", `unknown command ${commandType}`);
  if (!def.actors.includes(actor.kind)) {
    throw new BrainDomainError("FORBIDDEN", `actor kind ${actor.kind} cannot run ${commandType}`);
  }
  if (!actor.scopes.includes(def.scope)) {
    throw new BrainDomainError("FORBIDDEN", `missing scope ${def.scope} for ${commandType}`);
  }
}

export function requireWorkspaceRead(store: Store, actor: ActorContext, workspaceId: string): void {
  const ws = store.control.prepare("SELECT organization_id, status FROM workspaces WHERE id=?").get(workspaceId) as
    | { organization_id: string; status: string } | undefined;
  if (!ws || ws.organization_id !== actor.organizationId) throw new BrainDomainError("NOT_FOUND", "workspace not found");
  if (!hasWorkspaceMembership(store, actor.actorId, actor.organizationId, workspaceId)) {
    throw new BrainDomainError("NOT_FOUND", "workspace not found");
  }
}
