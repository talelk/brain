import { approvalSubjectDigest, domainDigest } from "@brain/contracts";
import type { ActionSubject, ActorContext, HumanApprovalDecision, JsonValue } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import type { Command, CommandHandlers } from "../../application/command-funnel";
import { hasWorkspaceMembership, scopesForPrincipal, type ResolvedActor } from "../../application/authz";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { assertExpectedVersion, assertTransition, transitionState } from "../../domain/states";
import { assertHumanIdentity, type BrainAuth } from "../identity/index";

export interface GovernanceCommandPorts {
  readonly auth: BrainAuth;
  /** Resumes the workflow gate waiting on a decided approval. */
  wakeGate(organizationId: string, workspaceId: string, approvalId: string, approved: boolean): void;
}

/**
 * Admits a human approval decision posted to its dedicated route: verifies the
 * human session, scopes the actor to the approval's workspace and validates the
 * decision body. The command id derives from the actor and idempotency key, so
 * a retry finds its own command intent (ADR 0002).
 */
export function admitApprovalDecision(store: Store, auth: BrainAuth, identity: ResolvedActor, approvalId: string, body: HumanApprovalDecision): { actor: ActorContext; cmd: Command } {
  assertHumanIdentity(store, auth, identity);
  const actorIn = identity.actor;
  const wsRow = store.control.prepare("SELECT workspace_id FROM approval_requests WHERE id=? AND organization_id=?").get(approvalId, actorIn.organizationId) as { workspace_id: string } | undefined;
  if (!wsRow) throw new BrainDomainError("NOT_FOUND", "approval not found");
  const actor: ActorContext = { ...actorIn, workspaceId: wsRow.workspace_id, scopes: scopesForPrincipal(store, actorIn.actorId, actorIn.organizationId, wsRow.workspace_id) };
  if (!actor.scopes.includes("approval:decide")) throw new BrainDomainError("FORBIDDEN", "missing approval:decide scope");
  const check = validate("HumanApprovalDecision", body);
  if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", check.errors.join("; "));
  const commandId = `dec-human-${domainDigest("brain:approval-decision-command:v1", { organizationId: actor.organizationId, actorId: actor.actorId, idempotencyKey: body.idempotencyKey }).slice(-32)}`;
  const cmd = {
    contractVersion: "brain.command/v1", commandId, commandType: "approval.decision", idempotencyKey: body.idempotencyKey,
    payload: { approvalId, decision: body as unknown as JsonValue },
  } as unknown as Command;
  return { actor, cmd };
}

/** Governance commands: exact approval requests, revocation and human decisions (control.db). */
export function governanceCommands(store: Store, ports: GovernanceCommandPorts): CommandHandlers {
  const s = store;
  return {
    "approval.request": {
      kind: "control",
      handle: ({ actor, cmd, workspaceId }) => {
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        const subject = cmd.payload["subject"] as unknown as ActionSubject;
        if (subject.organizationId !== actor.organizationId || subject.workspaceId !== workspaceId) throw new BrainDomainError("FORBIDDEN", "subject scope mismatch");
        const digest = approvalSubjectDigest(subject as unknown as JsonValue);
        // E083: one live request per exact subject signature — a repeated
        // request for the identical subject returns the existing approval
        // instead of minting a duplicate reviewers must re-triage.
        const existing = s.control.prepare("SELECT id FROM approval_requests WHERE organization_id=? AND workspace_id=? AND subject_digest=? AND state='pending' ORDER BY created_at_ms ASC LIMIT 1")
          .get(actor.organizationId, workspaceId, digest) as { id: string } | undefined;
        if (existing) return { resourceId: existing.id };
        const id = s.id("apr");
        s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms) VALUES (?,?,?,?,?,?,'pending',?,?)`)
          .run(id, actor.organizationId, workspaceId, actor.actorId, digest, JSON.stringify(subject), Date.parse(subject.expiresAt) || (s.now() + 3600_000), s.now());
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "approval", aggregateId: id, eventType: "approval.requested", payload: { approvalId: id, subjectDigest: digest } });
        return { resourceId: id };
      },
    },
    "approval.revoke": {
      kind: "control",
      handle: ({ actor, cmd }) => {
        const approvalId = String(cmd.payload["approvalId"]);
        const row = s.control.prepare("SELECT state FROM approval_requests WHERE id=? AND organization_id=?").get(approvalId, actor.organizationId);
        if (!row) throw new BrainDomainError("NOT_FOUND", "approval not found");
        transitionState(s.control, "approval", approvalId, "revoked", { bumpVersion: true });
        s.control.prepare("UPDATE effect_permits SET state='revoked' WHERE approval_id=? AND state='issued'").run(approvalId);
        return { resourceId: approvalId };
      },
    },
    "approval.decision": {
      kind: "control",
      handle: ({ actor, cmd, identity }) => {
        if (!identity) throw new BrainDomainError("UNAUTHENTICATED", "approval decisions require a verified human session");
        const approvalId = String(cmd.payload["approvalId"]);
        const body = cmd.payload["decision"] as unknown as HumanApprovalDecision;
        const row = s.control.prepare("SELECT subject_digest, subject_json, state, version, expires_at_ms, workspace_id, requested_by FROM approval_requests WHERE id=? AND organization_id=?")
          .get(approvalId, actor.organizationId) as { subject_digest: string; subject_json: string; state: string; version: number; expires_at_ms: number; workspace_id: string; requested_by: string } | undefined;
        if (!row) throw new BrainDomainError("NOT_FOUND", "approval not found");
        if (!hasWorkspaceMembership(s, actor.actorId, actor.organizationId, row.workspace_id)) throw new BrainDomainError("NOT_FOUND", "approval not found");
        assertExpectedVersion(row.version, body.expectedVersion);
        if (row.subject_digest !== body.subjectDigest) throw new BrainDomainError("CONFLICT", "approval subject changed; refresh required");
        if (row.state === "pending" && row.expires_at_ms <= s.now()) {
          transitionState(s.control, "approval", approvalId, "expired", { bumpVersion: true });
          throw new BrainDomainError("APPROVAL_EXPIRED", "approval expired");
        }
        const newState = body.decision === "approve" ? "approved" : "rejected";
        assertTransition("approval", row.state, newState);
        // Separation of duties: author cannot approve own high-risk request.
        if (body.decision === "approve" && row.requested_by === actor.actorId) {
          throw new BrainDomainError("FORBIDDEN", "separation of duties: requester cannot approve own action");
        }
        if (body.decision === "approve") {
          if (!body.stepUpEvidenceId) throw new BrainDomainError("APPROVAL_REQUIRED", "fresh step-up evidence required to approve");
          const ev = s.control.prepare("SELECT e.actor_id,e.auth_session_digest,e.subject_digest,e.expires_at_ms,e.decision_id,e.revoked_at_ms,e.auth_session_id,e.auth_user_id,e.factor_digest,e.auth_generation,e.method,c.approval_id FROM step_up_evidence e JOIN step_up_challenges c ON c.id=e.challenge_id WHERE e.id=?").get(body.stepUpEvidenceId) as
            | { actor_id: string; auth_session_digest: string; subject_digest: string; expires_at_ms: number; decision_id: string | null; revoked_at_ms: number | null; auth_session_id: string; auth_user_id: string; factor_digest: string | null; auth_generation: number; method: string; approval_id: string } | undefined;
          if (!ev || ev.approval_id !== approvalId || (ports.auth.requireTwoFactor && ev.method !== "totp") || ev.revoked_at_ms || ev.expires_at_ms <= s.now() || ev.actor_id !== actor.actorId || ev.auth_session_digest !== identity.sessionDigest || ev.subject_digest !== body.subjectDigest || ev.decision_id || ev.auth_generation !== actor.authGeneration || !ports.auth.isSessionCurrent(ev.auth_user_id, ev.auth_session_id, s.now(), ev.factor_digest)) {
            throw new BrainDomainError("FORBIDDEN", "step-up evidence invalid, expired, or already used");
          }
        }
        // The decision's own id is the command id.
        const decisionId = cmd.commandId;
        s.control.prepare("INSERT INTO approval_decisions(id, approval_id, expected_version, actor_id, auth_evidence_ref, subject_digest, decision, note, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(decisionId, approvalId, body.expectedVersion, actor.actorId, body.stepUpEvidenceId ?? "session", body.subjectDigest, body.decision, body.note, s.now());
        if (body.stepUpEvidenceId) s.control.prepare("UPDATE step_up_evidence SET decision_id=? WHERE id=?").run(decisionId, body.stepUpEvidenceId);
        transitionState(s.control, "approval", approvalId, newState, { bumpVersion: true, and: { version: body.expectedVersion } });
        s.emit(s.control, { organizationId: actor.organizationId, workspaceId: row.workspace_id, aggregateType: "approval", aggregateId: approvalId, eventType: body.decision === "approve" ? "approval.approved" : "approval.rejected", payload: { approvalId, decisionId } });
        return {
          resourceId: approvalId,
          receiptExtra: { decisionId, state: newState, subjectDigest: body.subjectDigest },
          afterCommit: () => ports.wakeGate(actor.organizationId, row.workspace_id, approvalId, newState === "approved"),
        };
      },
    },
  };
}
