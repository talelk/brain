import { describe, expect, it } from "vitest";
import { approvalSubjectDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";
import { setupWorld, stepUp, DIGEST_A } from "../helpers";

type World = ReturnType<typeof setupWorld>;

function seedRunner(w: World, runnerId: string) {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(runnerId, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(runnerId, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}

interface Offer { attemptId: string; leaseId: string; jobFence: number; jobId: string }
function runningAttempt(w: World, key: string, runnerId: string) {
  const digest = w.brain.activeRelease(w.org)!.digest;
  w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch",
    workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
  }, key);
  const runner = seedRunner(w, runnerId);
  const offer = w.brain.claim(runner, `req-${key}`) as unknown as Offer;
  w.brain.ackAttempt(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  return { runner, offer };
}

async function approve(w: World, key: string): Promise<{ approvalId: string; digest: string }> {
  const approver = await w.grantApprover(`apr-${key}`);
  const subject = {
    organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish",
    tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
    target: { targetId: "t-permit", environmentId: "prod", preconditionDigest: DIGEST_A },
    artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
    effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce: `n-${key}`,
  };
  const req = w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "approval.request",
    workspaceId: w.workspaceId, idempotencyKey: key, payload: { subject },
  }, key);
  const approvalId = (req.receipt as { resourceId?: string }).resourceId ?? "";
  const digest = approvalSubjectDigest(subject as unknown as JsonValue);
  const evidenceId = await stepUp(w, approver, approvalId, digest);
  w.brain.decideApproval(approver.identity, approvalId, {
    contractVersion: "brain.approval-decision/v1", idempotencyKey: `${key}-dec`, decision: "approve",
    subjectDigest: digest, expectedVersion: 1, note: "ok", stepUpEvidenceId: evidenceId,
  });
  return { approvalId, digest };
}

describe("effect permits (T14)", () => {
  it("a permit is bound to its attempt and invocation; replay is exact and current-only", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "perm-a", "runner-pa");
    const approved = await approve(w, "perm-apr");
    const issued = w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "perm-inv-1", subjectDigest: approved.digest, approvalId: approved.approvalId, resourceKeys: ["target:perm"] }) as unknown as { permitId: string; token: string };
    expect(w.brain.validatePermit(issued.token, "perm-inv-1")).toBe(true);
    expect(w.brain.validatePermit(issued.token, "perm-inv-2")).toBe(false);
    expect(w.brain.validatePermit("forged", "perm-inv-1")).toBe(false);
    // Exact replay for the same attempt returns the same permit.
    const replay = w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "perm-inv-1", subjectDigest: approved.digest, approvalId: approved.approvalId, resourceKeys: ["target:perm"] }) as unknown as { permitId: string; token: string };
    expect(replay.permitId).toBe(issued.permitId);
    expect(replay.token).toBe(issued.token);
    // The same invocation from another attempt is forbidden, even with approval.
    const b = runningAttempt(w, "perm-b", "runner-pb");
    expect(() => w.brain.issuePermit(b.runner, b.offer.attemptId, { invocationId: "perm-inv-1", subjectDigest: approved.digest, approvalId: approved.approvalId, resourceKeys: [] })).toThrow(/different attempt/);
    // Fencing the first attempt (newer claim on its job is impossible while
    // running; expiry to outcome_unknown) makes its token non-current.
    w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(Date.now() - 1, a.offer.attemptId);
    w.brain.expireLeases();
    expect(() => w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "perm-inv-9", subjectDigest: approved.digest, approvalId: approved.approvalId, resourceKeys: [] })).toThrow();
    w.brain.close();
  });
});
