import { randomBytes } from "node:crypto";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";

/** Past an attempt's deadline its gateway token lives this long (the last model call finishing), and never beyond the cap. */
const GATEWAY_GRACE_MS = 30_000;
export const GATEWAY_TOKEN_CAP_MS = 3600_000;

export interface GatewayGrant { readonly organizationId: string; readonly workspaceId: string; readonly attemptId: string; readonly jobId: string; readonly runId: string }

/**
 * The credential of one running attempt for the model gateway (ADR 0072), the same binding as an attempt's other credentials: minted for the
 * attempt and the fence it holds, shown once (only its digest is kept), alive only while that attempt runs under that fence, and gone at its
 * deadline plus a small grace. Asking again replaces the earlier token.
 */
export function issueGatewayToken(s: Store, input: { organizationId: string; workspaceId: string; attemptId: string; jobFence: number; deadlineMs: number | null }): { token: string; expiresAtMs: number } {
  const now = s.now();
  const expiresAtMs = Math.min(now + GATEWAY_TOKEN_CAP_MS, input.deadlineMs === null ? Number.POSITIVE_INFINITY : input.deadlineMs + GATEWAY_GRACE_MS);
  if (expiresAtMs <= now) throw new BrainDomainError("FORBIDDEN", "the attempt passed its deadline");
  const token = `bgw_${randomBytes(32).toString("base64url")}`;
  s.inTx(s.control, () => {
    revokeGatewayTokens(s, input.attemptId);
    s.control.prepare("INSERT INTO model_gateway_tokens(token_digest, organization_id, workspace_id, attempt_id, job_fence, created_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?,?)")
      .run(s.tokenDigest("model-gateway", token), input.organizationId, input.workspaceId, input.attemptId, input.jobFence, now, expiresAtMs);
  });
  return { token, expiresAtMs };
}

/** Ends every gateway token of the attempt. Idempotent; resolution rechecks the attempt anyway, this makes the end visible in the record. */
export function revokeGatewayTokens(s: Store, attemptId: string): void {
  s.control.prepare("UPDATE model_gateway_tokens SET revoked_at_ms=? WHERE attempt_id=? AND revoked_at_ms IS NULL").run(s.now(), attemptId);
}

/** Stop all sessions (ADR 0047): every gateway token of the workspace. */
export function revokeWorkspaceGatewayTokens(s: Store, workspaceId: string): void {
  s.control.prepare("UPDATE model_gateway_tokens SET revoked_at_ms=? WHERE workspace_id=? AND revoked_at_ms IS NULL").run(s.now(), workspaceId);
}

/**
 * The attempt a gateway token speaks for. It holds only while its attempt is running under the fence it was minted for, on the runner
 * epoch that holds the lease, with the runner neither quarantined nor disabled and the workspace active; the moment any of that stops being
 * true the token is revoked and refused.
 */
export function resolveGatewayToken(s: Store, token: string): GatewayGrant {
  const refuse = (why: string): never => { throw new BrainDomainError("UNAUTHENTICATED", `the model gateway token is refused: ${why}`); };
  const row = s.control.prepare("SELECT organization_id, workspace_id, attempt_id, job_fence, expires_at_ms, revoked_at_ms FROM model_gateway_tokens WHERE token_digest=?").get(s.tokenDigest("model-gateway", token)) as
    { organization_id: string; workspace_id: string; attempt_id: string; job_fence: number; expires_at_ms: number; revoked_at_ms: number | null } | undefined;
  if (!row) return refuse("unknown token");
  if (row.revoked_at_ms !== null) return refuse("it was revoked: its attempt ended or its fence moved");
  if (row.expires_at_ms <= s.now()) { revokeGatewayTokens(s, row.attempt_id); return refuse("it expired"); }
  const live = s.control.prepare(`SELECT a.state AS attempt_state, a.job_fence AS attempt_fence, a.lease_expires_at_ms AS lease, a.runner_epoch AS epoch, a.job_id AS job_id, j.state AS job_state, j.job_fence AS job_fence,
    j.workflow_run_id AS run_id, r.session_epoch AS session_epoch, r.admin_state AS admin_state
    FROM job_attempts a JOIN jobs j ON j.id=a.job_id JOIN runners r ON r.id=a.runner_id WHERE a.id=?`).get(row.attempt_id) as
    | { attempt_state: string; attempt_fence: number; lease: number; epoch: number; job_id: string; job_state: string; job_fence: number; run_id: string; session_epoch: number; admin_state: string } | undefined;
  const holds = live && live.attempt_state === "running" && live.job_state === "running" && live.attempt_fence === row.job_fence && live.job_fence === row.job_fence
    && live.lease > s.now() && live.epoch === live.session_epoch && !["quarantined", "disabled"].includes(live.admin_state);
  if (!holds) { revokeGatewayTokens(s, row.attempt_id); return refuse("its attempt is no longer running under its fence"); }
  const ws = s.control.prepare("SELECT status FROM workspaces WHERE id=? AND organization_id=?").get(row.workspace_id, row.organization_id) as { status: string } | undefined;
  if (ws?.status !== "active") return refuse("the workspace is not active");
  return { organizationId: row.organization_id, workspaceId: row.workspace_id, attemptId: row.attempt_id, jobId: live.job_id, runId: live.run_id };
}
