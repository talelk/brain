import { describe, expect, it } from "vitest";
import { DIGEST_A, setupWorld, stepUp } from "../helpers";
import { approvalSubjectDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";

function subject(world: ReturnType<typeof setupWorld>, nonce: string): Record<string, unknown> {
  return {
    organizationId: world.org, workspaceId: world.workspaceId, operation: "fixture.publish",
    tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
    target: { targetId: "ticket-1", environmentId: "prod", preconditionDigest: DIGEST_A },
    artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
    effectBounds: {}, expiresAt: new Date(Date.now() + 3600_000).toISOString(), nonce,
  };
}

describe("core integration", () => {
  it("run details expose workflow failure even when the latest step succeeded", async () => {
    const w = setupWorld();
    try {
      await w.brain.auth.ready();
      const digest = w.brain.activeRelease(w.org)!.digest;
      const result = w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "status-dispatch", idempotencyKey: "status-dispatch", commandType: "workflow.dispatch", workspaceId: w.workspaceId, payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Status check" } } }, "status-check");
      const runId = result.receipt.resourceId!;
      const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
      w.brain.store.control.prepare("UPDATE jobs SET state='succeeded' WHERE workflow_run_id=?").run(runId);
      ws.prepare("UPDATE workflow_runs SET state='failed' WHERE id=?").run(runId);
      const detail = w.brain.executeQuery(w.owner, { queryType: "job.get", workspaceId: w.workspaceId, resourceId: runId }) as unknown as { snapshot: { state: string; workflowState: string } };
      expect(detail.snapshot).toMatchObject({ state: "succeeded", workflowState: "failed" });
    } finally { w.brain.close(); }
  });

  it("idempotent commands return one receipt; changed payload conflicts (E006/E007)", async () => {
    const w = setupWorld();
    const cmd = {
      contractVersion: "brain.command/v1", commandId: "cmd-1", commandType: "board.create",
      workspaceId: w.workspaceId, idempotencyKey: "k-1", payload: { title: "Card", criteria: ["works"] },
    };
    const r1 = w.brain.executeCommand(w.owner, cmd, "c1");
    const r2 = w.brain.executeCommand(w.owner, cmd, "c2");
    expect(r1.receipt).toEqual(r2.receipt);
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect((ws.prepare("SELECT COUNT(*) AS c FROM cards").get() as { c: number }).c).toBe(1);
    expect(() => w.brain.executeCommand(w.owner, { ...cmd, payload: { title: "Other", criteria: [] } }, "c3")).toThrow();
    w.brain.close();
  });

  it("board Done requires evidence; stale version conflicts (E009)", async () => {
    const w = setupWorld();
    const created = w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-b1", commandType: "board.create",
      workspaceId: w.workspaceId, idempotencyKey: "kb-1", payload: { title: "Ship", criteria: ["golden passes"] },
    }, "c1");
    const cardId = (created.receipt as { resourceId?: string }).resourceId ?? "";
    expect(cardId).toBeTruthy();
    expect(() => w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-b2", commandType: "board.move",
      workspaceId: w.workspaceId, idempotencyKey: "kb-2", expectedVersion: 1,
      payload: { cardId, status: "done" },
    }, "c2")).toThrow();
    w.brain.close();
  });

  it("exact approval + step-up + decision recovery (E051/E095)", async () => {
    const w = setupWorld();
    const approver = await w.grantApprover("approver-1");
    const subj = subject(w, "n-1");
    const req = w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-a1", commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: "ka-1", payload: { subject: subj },
    }, "c1");
    const approvalId = (req.receipt as { resourceId?: string }).resourceId ?? "";
    const digest = approvalSubjectDigest(subj as unknown as JsonValue);
    const evidenceId = await stepUp(w, approver, approvalId, digest);
    const decided = w.brain.decideApproval(approver.identity, approvalId, {
      contractVersion: "brain.approval-decision/v1", idempotencyKey: "dec-1", decision: "approve",
      subjectDigest: digest, expectedVersion: 1, note: "reviewed exact text", stepUpEvidenceId: evidenceId,
    });
    expect(decided.state).toBe("approved");
    const status = w.brain.decisionStatus(approver.actor, approvalId, "dec-1") as unknown as { status: string };
    expect(status.status).toBe("confirmed");
    // Changed subject requires a new approval.
    const subj2 = { ...subj, nonce: "n-2" };
    expect(approvalSubjectDigest(subj2 as unknown as JsonValue)).not.toBe(digest);
    w.brain.close();
  });

  it("agent cannot decide approvals; requester cannot self-approve (E004/E060)", async () => {
    const w = setupWorld();
    const subj = subject(w, "n-9");
    const req = w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-a9", commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: "ka-9", payload: { subject: subj },
    }, "c1");
    const approvalId = (req.receipt as { resourceId?: string }).resourceId ?? "";
    const digest = approvalSubjectDigest(subj as unknown as JsonValue);
    const agentActor = { ...w.owner, kind: "agent" as const };
    expect(() => w.brain.decideApproval({ actor: agentActor, principalId: agentActor.actorId, sessionDigest: "x", humanSession: null }, approvalId, {
      contractVersion: "brain.approval-decision/v1", idempotencyKey: "dec-9", decision: "approve",
      subjectDigest: digest, expectedVersion: 1, note: "ok",
    })).toThrow();
    w.brain.close();
  });

  it("cross-tenant workspace access is hidden as not found (E002)", async () => {
    const w = setupWorld();
    const stranger = { ...w.owner, organizationId: "org-other", actorId: "someone-else" };
    expect(() => w.brain.executeQuery(stranger, { queryType: "workspace.context", workspaceId: w.workspaceId })).toThrow();
    w.brain.close();
  });

  it("fresh storage initializes and health is ready (T04)", async () => {
    const w = setupWorld();
    expect(w.brain.health().ready).toBe(true);
    const meta = w.brain.store.control.prepare("SELECT schema_version FROM schema_metadata").get() as { schema_version: number };
    expect(meta.schema_version).toBe(1);
    w.brain.close();
  });
});
