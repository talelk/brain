import type { Store } from "../../application/store";

// Ends of a secret credential (ADR 0065). Plain functions over the store so the places that end an attempt, move a fence, stop a workspace or
// quarantine a runner can call them beside the session-credential revocations they already make. Validation also rechecks the attempt, so these
// make the end visible in the record and never the only guard.

/** The attempt ended, lost its lease or its fence moved. Idempotent. */
export function revokeAttemptSecrets(s: Store, attemptId: string, reason: string): void {
  s.control.prepare("UPDATE secret_credentials SET revoked_at_ms=?, revoked_reason=? WHERE attempt_id=? AND revoked_at_ms IS NULL").run(s.now(), reason, attemptId);
}

/** Stop all sessions (ADR 0047): every lease of the workspace, whichever attempt holds it. */
export function revokeWorkspaceSecrets(s: Store, workspaceId: string, reason: string): void {
  s.control.prepare("UPDATE secret_credentials SET revoked_at_ms=?, revoked_reason=? WHERE workspace_id=? AND revoked_at_ms IS NULL").run(s.now(), reason, workspaceId);
}

/** A runner is quarantined, rotated or deregistered: every lease held by its attempts. */
export function revokeRunnerSecrets(s: Store, runnerId: string, reason: string): void {
  s.control.prepare("UPDATE secret_credentials SET revoked_at_ms=?, revoked_reason=? WHERE revoked_at_ms IS NULL AND attempt_id IN (SELECT id FROM job_attempts WHERE runner_id=?)").run(s.now(), reason, runnerId);
}
