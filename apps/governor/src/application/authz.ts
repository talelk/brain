import type { ActorContext } from "@brain/contracts";
import { SESSION_ADMITTED, commandDef, roleScopes } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import type { Store } from "./store";
import { actorOf, agentBinding, resolveSessionCredential, type BrainAuth, type VerifiedSession } from "../modules/identity/index";

export interface ResolvedActor {
  readonly actor: ActorContext;
  readonly principalId: string;
  readonly sessionDigest: string;
  readonly humanSession: VerifiedSession | null;
}

/**
 * What a machine principal may do: the `agent-session` role of the matrix, in its own workspace only, and never more than the person it acts
 * for may do there now (the matrix's intersected delegated capability). A principal whose owner lost access to the workspace holds nothing.
 */
function agentScopes(store: Store, binding: NonNullable<ReturnType<typeof agentBinding>>, workspaceId: string | undefined): string[] {
  if (workspaceId !== binding.workspaceId) return [];
  const owner = new Set(scopesForPrincipal(store, binding.actingFor, binding.organizationId, workspaceId));
  if (!owner.has("workspace:read")) return [];
  return roleScopes("agent-session").filter((scope) => owner.has(scope)).sort();
}

export function scopesForPrincipal(store: Store, principalId: string, organizationId: string, workspaceId?: string): string[] {
  const bound = agentBinding(store, principalId);
  if (bound) return agentScopes(store, bound, workspaceId);
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
  // A machine principal has no membership of its own: it reaches its one workspace while the person it acts for still can.
  const bound = agentBinding(store, principalId);
  if (bound) return bound.organizationId === organizationId && bound.workspaceId === workspaceId && hasWorkspaceMembership(store, bound.actingFor, organizationId, workspaceId);
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
  // A session credential: valid only while the attempt it was minted for still holds its fence (ADR 0032).
  const session = token ? resolveSessionCredential(store, digest) : undefined;
  let principalId: string;
  let organizationId: string;
  let sessionDigest: string;
  let humanSession: VerifiedSession | null = null;
  if (session) {
    principalId = session.binding.principalId; organizationId = session.binding.organizationId; sessionDigest = digest;
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
  if (!principal || principal.disabled_at_ms !== null || principal.kind !== (humanSession ? "human" : "agent")) throw new BrainDomainError("UNAUTHENTICATED", "principal disabled or credential class mismatch");
  const org = store.control.prepare("SELECT revocation_generation FROM organizations WHERE id=?").get(organizationId) as { revocation_generation: number } | undefined;
  if (!org) throw new BrainDomainError("UNAUTHENTICATED", "organization missing");
  if (session) {
    const { binding } = session;
    return { principalId, sessionDigest, humanSession, actor: actorOf(binding, scopesForPrincipal(store, principalId, organizationId, binding.workspaceId), "machine-credential", { attemptId: session.attemptId, runId: session.runId, authGeneration: org.revocation_generation }) };
  }
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

/**
 * A session credential (a running attempt's machine principal, ADR 0032) runs only the commands behind its governed Brain tools (ADR 0042),
 * whatever its role's scopes would admit. The Governor's own dispatches for a member (service credential) are not sessions.
 */
export function assertSessionAdmits(actor: ActorContext, commandType: string): void {
  if (actor.authMethod !== "machine-credential" || actor.attemptId === undefined || SESSION_ADMITTED.has(commandType)) return;
  throw new BrainDomainError("FORBIDDEN", `a session credential cannot run ${commandType}: it admits only the commands behind its Brain tools`);
}

export function requireWorkspaceRead(store: Store, actor: ActorContext, workspaceId: string): void {
  const ws = store.control.prepare("SELECT organization_id, status FROM workspaces WHERE id=?").get(workspaceId) as
    | { organization_id: string; status: string } | undefined;
  if (!ws || ws.organization_id !== actor.organizationId) throw new BrainDomainError("NOT_FOUND", "workspace not found");
  if (!hasWorkspaceMembership(store, actor.actorId, actor.organizationId, workspaceId)) {
    throw new BrainDomainError("NOT_FOUND", "workspace not found");
  }
}
