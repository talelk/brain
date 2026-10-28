import type { Store } from "../../application/store";
import { scopesForPrincipal } from "../../application/authz";
import type { BrainAuth } from "../identity/index";

// Re-evaluate the immutable decision against current authority inside the same
// control transaction that consumes it. An approved row is not a permanent grant.
export function approvalCurrentlyUsable(s: Store, auth: BrainAuth, input: { approvalId: string; organizationId: string; workspaceId: string; subjectDigest: string }): boolean {
  const row = s.control.prepare(`SELECT d.actor_id,e.auth_session_id,e.auth_user_id,e.factor_digest,e.auth_session_digest,o.auth_organization_id
    FROM approval_requests a
    JOIN approval_decisions d ON d.approval_id=a.id AND d.decision='approve' AND d.expected_version=a.version-1 AND d.subject_digest=a.subject_digest
    JOIN step_up_evidence e ON e.id=d.auth_evidence_ref AND e.decision_id=d.id AND e.actor_id=d.actor_id AND e.subject_digest=a.subject_digest
    JOIN principals p ON p.id=d.actor_id AND p.organization_id=a.organization_id AND p.kind='human' AND p.auth_subject_id=e.auth_user_id AND p.disabled_at_ms IS NULL
    JOIN organizations o ON o.id=a.organization_id AND o.revocation_generation=e.auth_generation
    JOIN workspaces w ON w.id=a.workspace_id AND w.organization_id=a.organization_id AND w.status='active'
    WHERE a.id=? AND a.organization_id=? AND a.workspace_id=? AND a.subject_digest=? AND a.state='approved' AND a.expires_at_ms>?
      AND a.requested_by<>d.actor_id AND e.revoked_at_ms IS NULL AND e.expires_at_ms>?`).get(input.approvalId,input.organizationId,input.workspaceId,input.subjectDigest,s.now(),s.now()) as
      { actor_id: string; auth_session_id: string; auth_user_id: string; factor_digest: string; auth_session_digest: string; auth_organization_id: string } | undefined;
  return !!row
    && row.auth_session_digest === s.tokenDigest("auth-session",row.auth_session_id)
    && auth.hasMembership(row.auth_user_id,row.auth_organization_id)
    && auth.isSessionCurrent(row.auth_user_id,row.auth_session_id,s.now(),row.factor_digest)
    && scopesForPrincipal(s,row.actor_id,input.organizationId,input.workspaceId).includes("approval:decide");
}
