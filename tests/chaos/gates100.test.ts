import { describe, expect, it } from "vitest";
import { goldenDocs, setupWorld, stepUp } from "../helpers";
import { Brain } from "../../apps/governor/src/application/brain";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { approvalSubjectDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";

const GATE_WORKFLOW = `apiVersion: brain.keyrus/v1
kind: Workflow
metadata:
  id: gate-workflow
  version: 1.0.0
spec:
  inputSchemaRef: schemas/echo-input.json
  outputSchemaRef: schemas/check.json
  jobs:
    approve:
      kind: gate
      needs: []
      input:
        subject:
          source: literal
          value:
            operation: fixture.gate
      outputSchemaRef: schemas/check.json
      approvalPolicy:
        id: fixture-policy
        digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      proposalFrom:
        source: literal
        value:
          operation: fixture.gate
      expiresAfterSeconds: 3600
    echo:
      kind: dispatch
      needs:
      - approve
      input:
        message:
          source: input
          pointer: /message
      outputSchemaRef: schemas/echo-output.json
      timeoutSeconds: 30
      uses:
        type: tool
        release:
          id: fixture.echo
          digest: sha256:a3fe6a4caae9923fc7b88b98a9bb83234540741512decc87707dd2e97e03d6f0
      runsOn:
        group: fixture-tools
        all:
        - os:linux
        resources:
          cpuMillicores: 500
          memoryMb: 256
          diskMb: 256
          slots: 1
        isolation: ephemeral-container
      effectClass: read
  outputs:
    passed:
      source: job
      jobId: echo
      pointer: /message
  failFast: true
  deadlineSeconds: 120
`;

describe("G03 brain durability: 100 suspended gates", () => {
  it("holds 100 waits, survives restart, wakes exactly once each (E022/E023/E024)", async () => {
    const w = setupWorld();
    const docs = [...goldenDocs(), { path: "config/gate-workflow.yaml", text: GATE_WORKFLOW }];
    const { digest } = w.brain.stageRelease(w.owner, docs, "sha256:d0d19b05579b117b2e650ab6c512106e263f38cc75b29d79a1112325cfe2085f");
    w.brain.activateRelease(w.owner, digest);
    const approver = await w.grantApprover("gate-approver");

    const runIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const { receipt } = w.brain.executeCommand(w.owner, {
        contractVersion: "brain.command/v1", commandId: `gate-cmd-${i}`, commandType: "workflow.dispatch",
        workspaceId: w.workspaceId, idempotencyKey: `gate-${i}`,
        payload: { workflow: { id: "gate-workflow", digest }, input: { message: "Brain fixture" } },
      }, `corr-${i}`);
      runIds.push((receipt as { resourceId?: string }).resourceId ?? "");
    }
    expect(runIds.every(Boolean)).toBe(true);
    const pending = w.brain.store.control.prepare("SELECT COUNT(*) AS c FROM approval_requests WHERE state='pending'").get() as { c: number };
    expect(pending.c).toBe(100);
    const jobsBefore = w.brain.store.control.prepare("SELECT COUNT(*) AS c FROM jobs").get() as { c: number };
    expect(jobsBefore.c).toBe(0);

    // Restart: durable suspended state survives, nothing executes.
    w.brain.close();
    const brain2 = new Brain({ dataDir: w.dir, allowTestActor: true });
    const actor2 = {
      kind: "human" as const, actorId: approver.actor.actorId, organizationId: w.org, workspaceId: w.workspaceId,
      scopes: scopesForPrincipal(brain2.store, approver.actor.actorId, w.org, w.workspaceId),
      authMethod: "session" as const, authGeneration: 1,
    };
    const approvals = brain2.store.control.prepare("SELECT id, subject_digest FROM approval_requests WHERE state='pending' ORDER BY created_at_ms").all() as Array<{ id: string; subject_digest: string }>;
    expect(approvals.length).toBe(100);
    const world2 = { ...w, brain: brain2 };
    let firstApproval = "";
    let firstDigest = "";
    for (const [idx, ap] of approvals.entries()) {
      const subjDigest = ap.subject_digest;
      const subject = brain2.store.control.prepare("SELECT subject_json FROM approval_requests WHERE id=?").get(ap.id) as { subject_json: string };
      expect(approvalSubjectDigest(JSON.parse(subject.subject_json) as JsonValue)).toBe(subjDigest);
      const evidenceId = await stepUp(world2 as never, { actor: actor2 as never, token: approver.token, totp: approver.totp } as never, ap.id, subjDigest);
      const decided = brain2.decideApproval({ ...approver.identity, actor: actor2 }, ap.id, {
        contractVersion: "brain.approval-decision/v1", idempotencyKey: `gate-dec-${idx}`, decision: "approve",
        subjectDigest: subjDigest, expectedVersion: 1, note: "ok", stepUpEvidenceId: evidenceId,
      });
      expect(decided.state).toBe("approved");
      if (idx === 0) { firstApproval = ap.id; firstDigest = subjDigest; }
    }
    // Duplicate decision with the same key replays; duplicate wake is a no-op.
    const sessionDigest = brain2.store.tokenDigest("session", approver.token);
    const replay = brain2.decisionStatus(actor2 as never, firstApproval, "gate-dec-0") as unknown as { status: string };
    expect(replay.status).toBe("confirmed");
    void firstDigest; void sessionDigest;
    brain2.workflows.wakeGate(w.org, w.workspaceId, firstApproval, true);
    const jobsAfter = brain2.store.control.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state='queued'").get() as { c: number };
    expect(jobsAfter.c).toBe(100);
    const distinctKeys = brain2.store.control.prepare("SELECT COUNT(DISTINCT execution_key) AS c FROM jobs").get() as { c: number };
    expect(distinctKeys.c).toBe(100);
    brain2.close();
  }, 180_000);
});
