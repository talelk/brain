import type { StepUpChallenge, StepUpEvidence } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";
import { resolveActor, requireWorkspaceRead, scopesForPrincipal, type ResolvedActor } from "../../application/authz";
import { assertHumanIdentity, type BrainAuth } from "../identity/index";

export class StepUpService {
  constructor(private readonly store: Store, private readonly auth: BrainAuth) {}
  createChallenge(identity: ResolvedActor, approvalId: string, subjectDigest: string): StepUpChallenge {
    assertHumanIdentity(this.store, this.auth, identity, this.auth.requireTwoFactor);
    const { actor, sessionDigest, humanSession } = identity;
    const s = this.store;
    const row = s.control.prepare("SELECT subject_digest,workspace_id,state,expires_at_ms FROM approval_requests WHERE id=? AND organization_id=?").get(approvalId, actor.organizationId) as { subject_digest: string; workspace_id: string; state: string; expires_at_ms: number } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "approval not found");
    requireWorkspaceRead(s, actor, row.workspace_id);
    if (row.subject_digest !== subjectDigest) throw new BrainDomainError("CONFLICT", "subject digest mismatch");
    if (row.state !== "pending" || row.expires_at_ms <= s.now()) throw new BrainDomainError("APPROVAL_EXPIRED", "approval is not pending and current");
    if (!scopesForPrincipal(s, actor.actorId, actor.organizationId, row.workspace_id).includes("approval:decide")) throw new BrainDomainError("FORBIDDEN", "approver scope required");
    const pending = s.control.prepare("SELECT COUNT(*) AS n FROM step_up_challenges WHERE actor_id=? AND auth_session_digest=? AND expires_at_ms>? AND verified_at_ms IS NULL").get(actor.actorId, sessionDigest, s.now()) as { n: number };
    if (pending.n >= 5) throw new BrainDomainError("RATE_LIMITED", "too many pending step-up challenges");
    const id = s.id("stepup"); const expires = Math.min(s.now() + 300_000, row.expires_at_ms);
    s.control.prepare("INSERT INTO step_up_challenges(id,actor_id,auth_session_digest,approval_id,subject_digest,expires_at_ms,factor_digest,auth_generation) VALUES (?,?,?,?,?,?,?,?)").run(id, actor.actorId, sessionDigest, approvalId, subjectDigest, expires, humanSession!.factorDigest, actor.authGeneration);
    return { challengeId: id, approvalId, subjectDigest, expiresAt: iso(expires), method: this.auth.requireTwoFactor ? "totp" : "session" };
  }

  async verify(identity: ResolvedActor, challengeId: string, code: string, headers: Headers): Promise<StepUpEvidence> {
    assertHumanIdentity(this.store, this.auth, identity, this.auth.requireTwoFactor);
    const { actor, sessionDigest, humanSession } = identity;
    const s = this.store;
    const ch = s.inTx(s.control, () => {
      const row = s.control.prepare("SELECT * FROM step_up_challenges WHERE id=?").get(challengeId) as { actor_id: string; auth_session_digest: string; approval_id: string; subject_digest: string; expires_at_ms: number; attempts: number; verified_at_ms: number | null; factor_digest: string | null; auth_generation: number } | undefined;
      if (!row) throw new BrainDomainError("NOT_FOUND", "challenge not found");
      if (row.actor_id !== actor.actorId || row.auth_session_digest !== sessionDigest || row.factor_digest !== humanSession!.factorDigest || row.auth_generation !== actor.authGeneration) throw new BrainDomainError("FORBIDDEN", "challenge binding changed");
      if (row.expires_at_ms <= s.now()) throw new BrainDomainError("APPROVAL_EXPIRED", "step-up challenge expired");
      if (row.verified_at_ms !== null) throw new BrainDomainError("CONFLICT", "challenge already verified");
      if (row.attempts >= 5) throw new BrainDomainError("RATE_LIMITED", "step-up attempts exhausted");
      s.control.prepare("UPDATE step_up_challenges SET attempts=attempts+1 WHERE id=?").run(challengeId);
      return row;
    });
    const credentialIdentity = await resolveActor(this.store, this.auth, headers);
    if (credentialIdentity.sessionDigest !== sessionDigest || credentialIdentity.actor.actorId !== actor.actorId || credentialIdentity.actor.organizationId !== actor.organizationId) throw new BrainDomainError("FORBIDDEN", "step-up credential binding mismatch");
    const method = this.auth.requireTwoFactor || code ? "totp" : "session";
    if (method === "totp" && !await this.auth.verifyTotp(headers, code)) throw new BrainDomainError("FORBIDDEN", "TOTP verification failed");
    return s.inTx(s.control, () => {
      assertHumanIdentity(this.store, this.auth, identity, this.auth.requireTwoFactor);
      const approval = s.control.prepare("SELECT workspace_id FROM approval_requests WHERE id=? AND organization_id=? AND state='pending' AND subject_digest=? AND expires_at_ms>?").get(ch.approval_id, actor.organizationId, ch.subject_digest, s.now()) as { workspace_id: string } | undefined;
      if (!approval) throw new BrainDomainError("APPROVAL_EXPIRED", "approval changed during step-up");
      requireWorkspaceRead(s, actor, approval.workspace_id);
      const verified = s.control.prepare("UPDATE step_up_challenges SET verified_at_ms=? WHERE id=? AND verified_at_ms IS NULL AND expires_at_ms>?").run(s.now(), challengeId, s.now());
      if (verified.changes !== 1) throw new BrainDomainError("CONFLICT", "challenge expired or already verified");
      const evidenceId = s.id("stepup-proof");
      s.control.prepare("INSERT INTO step_up_evidence(id,challenge_id,actor_id,auth_session_digest,subject_digest,method,expires_at_ms,auth_session_id,auth_user_id,factor_digest,auth_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(evidenceId, challengeId, actor.actorId, sessionDigest, ch.subject_digest, method, Math.min(ch.expires_at_ms, s.now()+300_000), humanSession!.sessionId, humanSession!.userId, humanSession!.factorDigest, actor.authGeneration);
      return { evidenceId, subjectDigest: ch.subject_digest, expiresAt: iso(Math.min(ch.expires_at_ms,s.now()+300000)), method };
    });
  }

}
