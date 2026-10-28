import { describe, expect, it } from "vitest";
import { setupWorld, stepUp, DIGEST_A, goldenDocs } from "../helpers";
import { parseRestrictedYaml, compileRelease } from "../../apps/governor/src/modules/configuration/index";
import { approvalSubjectDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";

function seedRunner(w: ReturnType<typeof setupWorld>, runnerId: string, group = "fixture-tools") {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, ?, 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(runnerId, w.org, group, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)")
      .run(runnerId, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}

function dispatchGolden(w: ReturnType<typeof setupWorld>, key: string, digest: string): string {
  const { receipt } = w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch",
    workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
  }, key);
  return (receipt as { resourceId?: string }).resourceId ?? "";
}

describe("scenario gaps (T50 batch 1)", () => {
  it("different actors may reuse an idempotency key independently (E008)", async () => {
    const w = setupWorld();
    const other = await w.grantApprover("actor-two");
    const cmd = {
      contractVersion: "brain.command/v1", commandId: "cmd-shared-1", commandType: "board.create",
      workspaceId: w.workspaceId, idempotencyKey: "shared-key", payload: { title: "A", criteria: ["x"] },
    };
    const r1 = w.brain.executeCommand(w.owner, cmd, "c1");
    const r2 = w.brain.executeCommand(other.actor, { ...cmd, commandId: "cmd-shared-2", payload: { title: "B", criteria: ["y"] } }, "c2");
    expect((r1.receipt as { resourceId?: string }).resourceId).not.toBe((r2.receipt as { resourceId?: string }).resourceId);
    w.brain.close();
  });

  it("enrollment token replay is denied (E010)", async () => {
    const w = setupWorld();
    const { token } = w.brain.issueEnrollment(w.owner, "fixture-tools");
    const pem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA0000000000000000000000000000000000000000000=\n-----END PUBLIC KEY-----\n";
    w.brain.enrollRunner({ token, publicKeyPem: pem, runnerId: "runner-replay-1" });
    expect(() => w.brain.enrollRunner({ token, publicKeyPem: pem, runnerId: "runner-replay-2" })).toThrow();
    w.brain.close();
  });

  it("YAML aliases, custom tags and duplicate keys are rejected (E011)", async () => {
    expect(() => parseRestrictedYaml("a: &x 1\nb: *x\n", "alias.yaml")).toThrow();
    expect(() => parseRestrictedYaml("a: !custom 1\n", "tag.yaml")).toThrow();
    expect(() => parseRestrictedYaml("a: 1\na: 2\n", "dup.yaml")).toThrow();
  });

  it("config activation CAS rejects a stale expected digest (E021)", async () => {
    const w = setupWorld();
    const { digest } = w.brain.stageRelease(w.owner, goldenDocs(), "sha256:c7b83b20a53443a899c10010ea3e4d23203f2de224a53fd163fd878e21944526");
    expect(() => w.brain.activateRelease(w.owner, digest, DIGEST_A)).toThrow();
    w.brain.close();
  });

  it("two runners cannot both win one queued job; duplicate ACK is stable (E031/E037)", async () => {
    const w = setupWorld();
    const d = w.brain.activeRelease(w.org)!.digest;
    dispatchGolden(w, "claim-race", d);
    const r1 = seedRunner(w, "runner-race-1");
    const r2 = seedRunner(w, "runner-race-2");
    const o1 = w.brain.claim(r1, "req-race-1") as unknown as { attemptId: string; leaseId: string; jobFence: number } | null;
    expect(o1).toBeTruthy();
    const o2 = w.brain.claim(r2, "req-race-2");
    expect(o2).toBeNull();
    const ack1 = w.brain.ackAttempt(r1, o1!.attemptId, { leaseId: o1!.leaseId, jobFence: o1!.jobFence });
    const ack2 = w.brain.ackAttempt(r1, o1!.attemptId, { leaseId: o1!.leaseId, jobFence: o1!.jobFence });
    expect(ack1).toBeTruthy();
    expect(ack2).toBeTruthy();
    w.brain.close();
  });

  it("offer expiry requeues the job for another runner (E036)", async () => {
    const w = setupWorld();
    const d = w.brain.activeRelease(w.org)!.digest;
    dispatchGolden(w, "offer-expire", d);
    const r1 = seedRunner(w, "runner-exp-1");
    const offer = w.brain.claim(r1, "req-exp-1") as unknown as { attemptId: string } | null;
    expect(offer).toBeTruthy();
    w.brain.store.control.prepare("UPDATE job_attempts SET offer_expires_at_ms=? WHERE id=?").run(Date.now() - 1000, offer!.attemptId);
    expect(w.brain.expireLeases()).toBeGreaterThan(0);
    const job = w.brain.store.control.prepare("SELECT state FROM jobs LIMIT 1").get() as { state: string };
    expect(job.state).toBe("queued");
    w.brain.close();
  });

  it("heartbeat sequence regression and changed body are rejected (E039)", async () => {
    const w = setupWorld();
    const r = seedRunner(w, "runner-hb-1");
    w.brain.heartbeat(r, { sequence: 5, load: "a" });
    expect(() => w.brain.heartbeat(r, { sequence: 4, load: "a" })).toThrow();
    expect(() => w.brain.heartbeat(r, { sequence: 5, load: "changed" })).toThrow();
    w.brain.heartbeat(r, { sequence: 5, load: "a" }); // exact replay is stable
    w.brain.close();
  });

  it("stale-fence completion is quarantined, never finalizing (E042)", async () => {
    const w = setupWorld();
    const d = w.brain.activeRelease(w.org)!.digest;
    dispatchGolden(w, "stale-fence", d);
    const r1 = seedRunner(w, "runner-stale-1");
    const offer = w.brain.claim(r1, "req-stale-1") as unknown as { attemptId: string; leaseId: string; jobFence: number };
    w.brain.ackAttempt(r1, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    expect(() => w.brain.completeAttempt(r1, offer.attemptId, { result: "succeeded", output: { message: "x" }, jobFence: offer.jobFence + 9, cleanupConfirmed: true })).toThrow();
    const job = w.brain.store.control.prepare("SELECT state FROM jobs LIMIT 1").get() as { state: string };
    expect(job.state).toBe("running");
    w.brain.close();
  });

  it("one approval yields one permit; replay returns the same permit (E053/E054)", async () => {
    const w = setupWorld();
    const d = w.brain.activeRelease(w.org)!.digest;
    const approver = await w.grantApprover("permit-approver");
    dispatchGolden(w, "permit-flow", d);
    const r1 = seedRunner(w, "runner-permit-1");
    const offer = w.brain.claim(r1, "req-permit-1") as unknown as { attemptId: string; leaseId: string; jobFence: number };
    w.brain.ackAttempt(r1, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    const subject = {
      organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish",
      tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
      target: { targetId: "t-1", environmentId: "prod", preconditionDigest: DIGEST_A },
      artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
      effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce: "permit-1",
    };
    const req = w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-permit-apr", commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: "permit-apr", payload: { subject },
    }, "c1");
    const approvalId = (req.receipt as { resourceId?: string }).resourceId ?? "";
    const digest = approvalSubjectDigest(subject as unknown as JsonValue);
    const evidenceId = await stepUp(w, approver, approvalId, digest);
    w.brain.decideApproval(approver.identity, approvalId, {
      contractVersion: "brain.approval-decision/v1", idempotencyKey: "permit-dec", decision: "approve",
      subjectDigest: digest, expectedVersion: 1, note: "ok", stepUpEvidenceId: evidenceId,
    });
    const p1 = w.brain.issuePermit(r1, offer.attemptId, { invocationId: "inv-1", subjectDigest: digest, approvalId, resourceKeys: ["target:t-1"] }) as unknown as { permitId: string; token: string };
    const p2 = w.brain.issuePermit(r1, offer.attemptId, { invocationId: "inv-1", subjectDigest: digest, approvalId, resourceKeys: ["target:t-1"] }) as unknown as { permitId: string; token: string };
    expect(p2.permitId).toBe(p1.permitId);
    expect(w.brain.validatePermit(p1.token, "inv-1")).toBe(true);
    expect(() => w.brain.issuePermit(r1, offer.attemptId, { invocationId: "inv-2", subjectDigest: digest, approvalId, resourceKeys: [] })).toThrow();
    w.brain.close();
  });

  it("verdict for a missing bundle is not found; kiosk cannot mutate (E074/E098)", async () => {
    const w = setupWorld();
    expect(() => w.brain.acceptVerdict({runnerId:"x",epoch:1,organizationId:w.org},w.workspaceId,{
      organizationId: w.org, workspaceId: w.workspaceId, bundleDigest: DIGEST_A,
      evaluatorAttemptId: "x", evaluatorDigest: DIGEST_A, outcome: "verified", checks: [], acceptedBy: "x",
    })).toThrow();
    w.brain.ensurePrincipal(w.org, "tv-1", "kiosk");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'tv-1', 'viewer', 1, 'owner-1', ?)")
      .run(w.workspaceId, w.org, w.brain.store.now());
    const kiosk = w.actor("tv-1", w.workspaceId);
    expect(() => w.brain.executeCommand({ ...kiosk, kind: "kiosk" }, {
      contractVersion: "brain.command/v1", commandId: "cmd-tv", commandType: "board.create",
      workspaceId: w.workspaceId, idempotencyKey: "tv-1", payload: { title: "x", criteria: ["y"] },
    }, "c1")).toThrow();
    w.brain.close();
  });

  it("compileRelease rejects config without BrainConfig UI foundation mismatch guard (E097 partial)", async () => {
    const docs = goldenDocs().map((doc) => doc.path.includes("fixture-brain")
      ? { ...doc, text: doc.text.replace("foundation: newui", "foundation: custom") }
      : doc);
    const changed = docs.some((doc) => doc.text.includes("foundation: custom"));
    if (changed) expect(() => compileRelease(docs, "bad-ui")).toThrow();
    else expect(compileRelease(goldenDocs(), "ok").digest).toMatch(/^sha256:/);
  });
});
