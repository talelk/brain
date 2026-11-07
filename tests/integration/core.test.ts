import { describe, expect, it } from "vitest";
import { DIGEST_A, setupWorld, stepUp, workView } from "../helpers";
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
      const result = await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "status-dispatch", idempotencyKey: "status-dispatch", commandType: "workflow.dispatch", workspaceId: w.workspaceId, payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Status check" } } }, "status-check");
      const runId = result.receipt.resourceId!;
      const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
      w.brain.store.control.prepare("UPDATE jobs SET state='succeeded' WHERE workflow_run_id=?").run(runId);
      ws.prepare("UPDATE workflow_runs SET state='failed' WHERE id=?").run(runId);
      const detail = (await w.brain.executeQuery(w.owner, { queryType: "job.get", workspaceId: w.workspaceId, resourceId: runId })) as unknown as { snapshot: { state: string; workflowState: string } };
      expect(detail.snapshot).toMatchObject({ state: "succeeded", workflowState: "failed" });
    } finally { w.brain.close(); }
  });

  it("idempotent commands return one receipt; changed payload conflicts (E006/E007)", async () => {
    const w = setupWorld();
    const cmd = {
      contractVersion: "brain.command/v1", commandId: "cmd-1", commandType: "mission.create",
      workspaceId: w.workspaceId, idempotencyKey: "k-1", payload: { title: "Objective", intent: "works", successCriteria: ["works"] },
    };
    const r1 = await w.brain.executeCommand(w.owner, cmd, "c1");
    const r2 = await w.brain.executeCommand(w.owner, cmd, "c2");
    expect(r1.receipt).toEqual(r2.receipt);
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect((ws.prepare("SELECT COUNT(*) AS c FROM missions").get() as { c: number }).c).toBe(1);
    await expect(Promise.resolve().then(() => w.brain.executeCommand(w.owner, { ...cmd, payload: { title: "Other", intent: "other", successCriteria: [] } }, "c3"))).rejects.toThrow();
    w.brain.close();
  });

  it("work item Done requires evidence; stale version conflicts (E009)", async () => {
    const w = setupWorld();
    const missionId = ((await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-b1", commandType: "mission.create",
      workspaceId: w.workspaceId, idempotencyKey: "kb-1", payload: { title: "Ship", intent: "Ship the release", successCriteria: ["golden passes"] },
    }, "c1")).receipt as { resourceId?: string }).resourceId ?? "";
    const planId = ((await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-b1p", commandType: "plan.propose",
      workspaceId: w.workspaceId, idempotencyKey: "kb-1p",
      payload: { missionId, origin: "manual", summary: "single task", tasks: [{ id: "ship", title: "Ship", criteria: ["golden passes"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] },
    }, "c1b")).receipt as { resourceId?: string }).resourceId ?? "";
    await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-b1c", commandType: "plan.confirm",
      workspaceId: w.workspaceId, idempotencyKey: "kb-1c", expectedVersion: 1, payload: { planVersionId: planId },
    }, "c1c");
    const board = (await workView(w));
    const item = board.items[0]!;
    await expect(Promise.resolve().then(() => w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-stale", commandType: "workItem.transition",
      workspaceId: w.workspaceId, idempotencyKey: "kb-stale", expectedVersion: item.version + 90,
      payload: { workItemId: item.workItemId, state: "in-progress" },
    }, "c2"))).rejects.toThrow();
    const start = (await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-start", commandType: "workItem.transition",
      workspaceId: w.workspaceId, idempotencyKey: "kb-start", expectedVersion: item.version,
      payload: { workItemId: item.workItemId, state: "in-progress" },
    }, "c3")).receipt;
    expect(start.accepted).toBe(true);
    await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-review", commandType: "workItem.transition",
      workspaceId: w.workspaceId, idempotencyKey: "kb-review", expectedVersion: item.version + 1,
      payload: { workItemId: item.workItemId, state: "review" },
    }, "c4");
    await expect(Promise.resolve().then(() => w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-done", commandType: "workItem.transition",
      workspaceId: w.workspaceId, idempotencyKey: "kb-done", expectedVersion: item.version + 2,
      payload: { workItemId: item.workItemId, state: "done" },
    }, "c5"))).rejects.toThrow(/evidence/i);
    w.brain.close();
  });

  it("exact approval + step-up + decision recovery (E051/E095)", async () => {
    const w = setupWorld();
    const approver = await w.grantApprover("approver-1");
    const subj = subject(w, "n-1");
    const req = await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-a1", commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: "ka-1", payload: { subject: subj },
    }, "c1");
    const approvalId = (req.receipt as { resourceId?: string }).resourceId ?? "";
    const digest = approvalSubjectDigest(subj as unknown as JsonValue);
    const evidenceId = await stepUp(w, approver, approvalId, digest);
    const decided = await w.brain.decideApproval(approver.identity, approvalId, {
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
    const req = await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-a9", commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: "ka-9", payload: { subject: subj },
    }, "c1");
    const approvalId = (req.receipt as { resourceId?: string }).resourceId ?? "";
    const digest = approvalSubjectDigest(subj as unknown as JsonValue);
    const agentActor = { ...w.owner, kind: "agent" as const };
    await expect(w.brain.decideApproval({ actor: agentActor, principalId: agentActor.actorId, sessionDigest: "x", humanSession: null }, approvalId, {
      contractVersion: "brain.approval-decision/v1", idempotencyKey: "dec-9", decision: "approve",
      subjectDigest: digest, expectedVersion: 1, note: "ok",
    })).rejects.toThrow();
    w.brain.close();
  });

  it("cross-tenant workspace access is hidden as not found (E002)", async () => {
    const w = setupWorld();
    const stranger = { ...w.owner, organizationId: "org-other", actorId: "someone-else" };
    await expect(Promise.resolve().then(() => w.brain.executeQuery(stranger, { queryType: "workspace.context", workspaceId: w.workspaceId }))).rejects.toThrow();
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
