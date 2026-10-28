import { describe, expect, it } from "vitest";
import { approvalSubjectDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";
import { setupWorld, stepUp, DIGEST_A } from "../helpers";

type World = ReturnType<typeof setupWorld>;

function subject(w: World, nonce: string) {
  return {
    organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish",
    tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
    target: { targetId: "t-sec", environmentId: "prod", preconditionDigest: DIGEST_A },
    artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
    effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce,
  };
}

async function request(w: World, key: string, nonce: string): Promise<{ approvalId: string; digest: string; subj: ReturnType<typeof subject> }> {
  const subj = subject(w, nonce);
  const req = w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "approval.request",
    workspaceId: w.workspaceId, idempotencyKey: key, payload: { subject: subj },
  }, key);
  return { approvalId: (req.receipt as { resourceId?: string }).resourceId ?? "", digest: approvalSubjectDigest(subj as unknown as JsonValue), subj };
}

const decision = (key: string, digest: string, evidenceId?: string) => ({
  contractVersion: "brain.approval-decision/v1" as const, idempotencyKey: key, decision: "approve" as const,
  subjectDigest: digest, expectedVersion: 1, note: "sec", ...(evidenceId ? { stepUpEvidenceId: evidenceId } : {}),
});

describe("approval security (T13)", () => {
  it("separation of duties: the requester can never approve their own action", async () => {
    const w = setupWorld();
    const { approvalId, digest } = await request(w, "self-1", "self-n1");
    // Owner requested it and also holds approver authority via grantApprover on another principal only;
    // make the owner an approver too, then prove self-approval still fails.
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'owner-1', 'approver', 1, 'owner-1', ?)")
      .run(w.workspaceId, w.org, Date.now());
    const identity = await w.brain.resolveActor(new Headers({ authorization: `Bearer ${w.ownerToken}` }), w.workspaceId);
    expect(() => w.brain.decideApproval(identity, approvalId, decision("self-dec", digest, "ev-any"))).toThrow(/separation of duties/);
    w.brain.close();
  });

  it("approve without fresh step-up evidence is refused; evidence is single-use and expiring", async () => {
    const w = setupWorld();
    const approver = await w.grantApprover("sec-approver");
    const first = await request(w, "su-1", "su-n1");
    expect(() => w.brain.decideApproval(approver.identity, first.approvalId, decision("su-dec-0", first.digest))).toThrow(/step-up/);
    const evidenceId = await stepUp(w, approver, first.approvalId, first.digest);
    w.brain.decideApproval(approver.identity, first.approvalId, decision("su-dec-1", first.digest, evidenceId));
    const second = await request(w, "su-2", "su-n2");
    expect(() => w.brain.decideApproval(approver.identity, second.approvalId, decision("su-dec-2", second.digest, evidenceId))).toThrow(/step-up/);
    const expiredEvidence = await stepUp(w, approver, second.approvalId, second.digest);
    w.brain.store.control.prepare("UPDATE step_up_evidence SET expires_at_ms=? WHERE id=?").run(Date.now() - 1, expiredEvidence);
    expect(() => w.brain.decideApproval(approver.identity, second.approvalId, decision("su-dec-3", second.digest, expiredEvidence))).toThrow(/step-up/);
    w.brain.close();
  });

  it("decision-status answers only the exact idempotency key of the deciding actor", async () => {
    const w = setupWorld();
    const approver = await w.grantApprover("status-approver");
    const { approvalId, digest } = await request(w, "st-1", "st-n1");
    const evidenceId = await stepUp(w, approver, approvalId, digest);
    w.brain.decideApproval(approver.identity, approvalId, decision("st-dec", digest, evidenceId));
    const status = w.brain.decisionStatus(approver.actor, approvalId, "st-dec") as unknown as { status: string };
    expect(status.status).toBe("confirmed");
    const other = w.brain.decisionStatus(approver.actor, approvalId, "st-other") as unknown as { status: string };
    expect(other.status).not.toBe("confirmed");
    const stranger = w.brain.decisionStatus(w.owner, approvalId, "st-dec") as unknown as { status: string };
    expect(stranger.status).not.toBe("confirmed");
    w.brain.close();
  });
});
