import { randomBytes } from "node:crypto";
import type { ActorContext } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";

/**
 * Machine principals of sessions (ADR 0032). A mission team member's work runs as its own principal (actor kind agent), stable per
 * (mission, member) and recorded as acting for the mission owner. A running attempt holds a short-lived credential for it; the
 * credential is valid only while that attempt does. A principal has no membership of its own: what it may do is the `agent-session`
 * role of the authorization matrix, within its one workspace and mission, bounded by what the owner may do.
 */

export interface AgentBinding {
  readonly principalId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly missionId: string;
  /** The team member this principal works as; null for the mission's own dispatching principal (work no member was named for). */
  readonly memberId: string | null;
  readonly actingFor: string;
}

/** What a credential may live for at most; the attempt's own liveness ends it sooner. */
const CREDENTIAL_TTL_MS = 3600_000;

export const agentPrincipalId = (missionId: string, memberId: string | null): string => (memberId ? `agent:${missionId}:${memberId}` : `agent:${missionId}`);

/** Creates (once) the machine principal of a team member of a mission, and keeps the person it acts for current. */
export function ensureAgentPrincipal(store: Store, input: { organizationId: string; workspaceId: string; missionId: string; memberId: string | null; actingFor: string }): AgentBinding {
  const principalId = agentPrincipalId(input.missionId, input.memberId);
  store.inTx(store.control, () => {
    store.control.prepare("INSERT OR IGNORE INTO principals(id, organization_id, kind, auth_subject_id) VALUES (?,?,'agent',?)").run(principalId, input.organizationId, principalId);
    store.control.prepare("INSERT OR IGNORE INTO agent_principals(principal_id, organization_id, workspace_id, mission_id, member_id, acting_for, created_at_ms) VALUES (?,?,?,?,?,?,?)")
      .run(principalId, input.organizationId, input.workspaceId, input.missionId, input.memberId, input.actingFor, store.now());
    // Ownership can move: the principal always acts for whoever owns the mission now.
    store.control.prepare("UPDATE agent_principals SET acting_for=? WHERE principal_id=? AND acting_for<>?").run(input.actingFor, principalId, input.actingFor);
  });
  return { principalId, ...input };
}

export function agentBinding(store: Store, principalId: string): AgentBinding | undefined {
  const row = store.control.prepare("SELECT principal_id, organization_id, workspace_id, mission_id, member_id, acting_for FROM agent_principals WHERE principal_id=?").get(principalId) as
    | { principal_id: string; organization_id: string; workspace_id: string; mission_id: string; member_id: string | null; acting_for: string } | undefined;
  return row && { principalId: row.principal_id, organizationId: row.organization_id, workspaceId: row.workspace_id, missionId: row.mission_id, memberId: row.member_id, actingFor: row.acting_for };
}

/** The actor of work the Governor starts for a team member (auto-start, coordinator wakes): the member's principal, not the mission owner. */
export function dispatchActor(store: Store, input: { organizationId: string; workspaceId: string; missionId: string; memberId: string | null; actingFor: string }): ActorContext {
  const binding = ensureAgentPrincipal(store, input);
  return actorOf(binding, ["workspace:read", "mission:write", "workflow:dispatch"], "service-credential");
}

export function actorOf(binding: AgentBinding, scopes: readonly string[], authMethod: ActorContext["authMethod"], extra: { attemptId?: string; runId?: string; authGeneration?: number } = {}): ActorContext {
  return {
    kind: "agent", actorId: binding.principalId, organizationId: binding.organizationId, workspaceId: binding.workspaceId, scopes: [...scopes], authMethod, authGeneration: extra.authGeneration ?? 1,
    delegatedBy: binding.actingFor, missionId: binding.missionId, ...(binding.memberId ? { memberId: binding.memberId } : {}), ...(extra.attemptId ? { attemptId: extra.attemptId } : {}), ...(extra.runId ? { runId: extra.runId } : {}),
  };
}

/** Mints the credential of one running attempt, replacing any it held before. The token is shown once; only its digest is kept. */
export function issueSessionCredential(store: Store, input: { principalId: string; organizationId: string; attemptId: string; jobFence: number }): { credential: string; expiresAtMs: number } {
  const credential = randomBytes(32).toString("base64url");
  const expiresAtMs = store.now() + CREDENTIAL_TTL_MS;
  store.inTx(store.control, () => {
    revokeSessionCredentials(store, input.attemptId);
    store.control.prepare("INSERT INTO machine_sessions(token_digest, principal_id, organization_id, expires_at_ms, created_at_ms, attempt_id, job_fence) VALUES (?,?,?,?,?,?,?)")
      .run(store.tokenDigest("machine-session", credential), input.principalId, input.organizationId, expiresAtMs, store.now(), input.attemptId, input.jobFence);
  });
  return { credential, expiresAtMs };
}

/** Ends every credential of the attempt. Idempotent; resolution rechecks the attempt anyway, this makes the end visible in the record. */
export function revokeSessionCredentials(store: Store, attemptId: string): void {
  store.control.prepare("UPDATE machine_sessions SET revoked_at_ms=? WHERE attempt_id=? AND revoked_at_ms IS NULL").run(store.now(), attemptId);
}

interface CredentialRow { principal_id: string; organization_id: string; expires_at_ms: number; revoked_at_ms: number | null; attempt_id: string | null; job_fence: number | null }

/**
 * The principal a session credential speaks for. A credential is valid only while its attempt is still running under the fence
 * it was minted for, on the runner epoch that holds the lease; the moment any of that stops being true the credential is revoked.
 */
export function resolveSessionCredential(store: Store, digest: string): { binding: AgentBinding; attemptId: string; runId: string } | undefined {
  const row = store.control.prepare("SELECT principal_id, organization_id, expires_at_ms, revoked_at_ms, attempt_id, job_fence FROM machine_sessions WHERE token_digest=?").get(digest) as CredentialRow | undefined;
  if (!row) return undefined;
  const revoked = (): never => { throw new BrainDomainError("UNAUTHENTICATED", "session credential revoked: its attempt ended or its fence moved"); };
  if (row.revoked_at_ms !== null || row.expires_at_ms <= store.now() || row.attempt_id === null || row.job_fence === null) return revoked();
  const live = store.control.prepare(`SELECT a.state AS attempt_state, a.job_fence AS attempt_fence, a.lease_expires_at_ms AS lease, a.runner_epoch AS epoch, j.state AS job_state, j.job_fence AS job_fence,
    j.workflow_run_id AS run_id, r.session_epoch AS session_epoch, r.admin_state AS admin_state
    FROM job_attempts a JOIN jobs j ON j.id=a.job_id JOIN runners r ON r.id=a.runner_id WHERE a.id=?`).get(row.attempt_id) as
    | { attempt_state: string; attempt_fence: number; lease: number; epoch: number; job_state: string; job_fence: number; run_id: string; session_epoch: number; admin_state: string } | undefined;
  const holds = live && live.attempt_state === "running" && live.job_state === "running" && live.attempt_fence === row.job_fence && live.job_fence === row.job_fence
    && live.lease > store.now() && live.epoch === live.session_epoch && !["quarantined", "disabled"].includes(live.admin_state);
  if (!holds) {
    revokeSessionCredentials(store, row.attempt_id);
    return revoked();
  }
  const binding = agentBinding(store, row.principal_id);
  if (!binding || binding.organizationId !== row.organization_id) return revoked();
  return { binding, attemptId: row.attempt_id, runId: live.run_id };
}
