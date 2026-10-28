import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { domainDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";
import { approvalSubjectDigest } from "@brain/contracts";
import { setupWorld, stepUp, DIGEST_A, goldenDocs } from "../helpers";
import { attestDomain, bundleForAttempt } from "../support/evidence";

type World = ReturnType<typeof setupWorld>;

function seedRunner(w: World, runnerId: string, group = "fixture-tools", caps = { cpu: 4000, mem: 8192, disk: 20480, slots: 1 }) {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, ?, 'k', 'enabled', 'healthy', ?, 1, ?, ?, ?, ?, ?)`).run(runnerId, w.org, group, DIGEST_A, s.now(), caps.cpu, caps.mem, caps.disk, caps.slots);
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)")
      .run(runnerId, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}

function dispatchGolden(w: World, key: string): string {
  const digest = w.brain.activeRelease(w.org)!.digest;
  const { receipt } = w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch",
    workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
  }, key);
  return (receipt as { resourceId?: string }).resourceId ?? "";
}

interface Offer { attemptId: string; leaseId: string; jobFence: number; jobId: string; workspaceId: string }
function runningAttempt(w: World, key: string, runnerId: string): { runner: ReturnType<typeof seedRunner>; offer: Offer } {
  dispatchGolden(w, key);
  const runner = seedRunner(w, runnerId);
  const offer = w.brain.claim(runner, `req-${key}`) as unknown as Offer;
  expect(offer).toBeTruthy();
  w.brain.ackAttempt(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  return { runner, offer };
}

function baseSubject(w: World, nonce: string, extra: Record<string, unknown> = {}) {
  return {
    organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish",
    tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
    target: { targetId: "t-1", environmentId: "prod", preconditionDigest: DIGEST_A },
    artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
    effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce,
    ...extra,
  };
}

async function approveSubject(w: World, subject: Record<string, unknown>, key: string, approverName = `apr-${key}`): Promise<{ approvalId: string; digest: string }> {
  const approver = await w.grantApprover(approverName);
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

function jobState(w: World, jobId: string): string {
  return (w.brain.store.control.prepare("SELECT state FROM jobs WHERE id=?").get(jobId) as { state: string }).state;
}

describe("scenario gaps (T50 batch 2: runs, scheduler, permits)", () => {
  it.each(["session", "native-membership", "factor", "workspace-role", "principal"])("rejects stale reviewer %s before consuming approval or creating fences", async (changed) => {
    const w=setupWorld();
    try {
      const attempt=runningAttempt(w,`stale-${changed}`,`runner-${changed}`);
      const approval=await approveSubject(w,baseSubject(w,`stale-${changed}`),`approve-stale-${changed}`);
      const reviewer=w.brain.store.control.prepare("SELECT d.actor_id,e.auth_session_id,e.auth_user_id FROM approval_decisions d JOIN step_up_evidence e ON e.id=d.auth_evidence_ref WHERE d.approval_id=?").get(approval.approvalId) as {actor_id:string;auth_session_id:string;auth_user_id:string};
      const db=w.brain.store.control;
      if(changed==="session")db.prepare('DELETE FROM "session" WHERE id=?').run(reviewer.auth_session_id);
      if(changed==="native-membership")db.prepare('DELETE FROM "member" WHERE userId=?').run(reviewer.auth_user_id);
      if(changed==="factor")db.prepare('UPDATE "user" SET twoFactorEnabled=0 WHERE id=?').run(reviewer.auth_user_id);
      if(changed==="workspace-role")db.prepare("UPDATE workspace_memberships SET revoked_at_ms=? WHERE principal_id=? AND role='approver'").run(Date.now(),reviewer.actor_id);
      if(changed==="principal")db.prepare("UPDATE principals SET disabled_at_ms=? WHERE id=?").run(Date.now(),reviewer.actor_id);
      expect(()=>w.brain.issuePermit(attempt.runner,attempt.offer.attemptId,{invocationId:`inv-${changed}`,approvalId:approval.approvalId,subjectDigest:approval.digest,resourceKeys:["target:stale"]})).toThrow(/reviewer authority/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM approval_consumptions").get()).toEqual({n:0});
      expect(db.prepare("SELECT COUNT(*) AS n FROM resource_leases").get()).toEqual({n:0});
      expect(db.prepare("SELECT COUNT(*) AS n FROM effect_permits").get()).toEqual({n:0});
    }finally{w.brain.close();}
  });

  it("rechecks current reviewer and runner epoch on online validation and permit replay", async () => {
    const w=setupWorld();
    try{
      const attempt=runningAttempt(w,"validate-current","runner-current");
      const approval=await approveSubject(w,baseSubject(w,"validate-current"),"approve-validate-current");
      const request={invocationId:"inv-current",approvalId:approval.approvalId,subjectDigest:approval.digest,resourceKeys:["target:current"]};
      const permit=w.brain.issuePermit(attempt.runner,attempt.offer.attemptId,request) as {token:string};
      expect(w.brain.validatePermit(permit.token,request.invocationId)).toBe(true);
      w.brain.store.control.prepare("UPDATE runners SET session_epoch=session_epoch+1 WHERE id=?").run(attempt.runner.runnerId);
      expect(w.brain.validatePermit(permit.token,request.invocationId)).toBe(false);
      expect(()=>w.brain.issuePermit(attempt.runner,attempt.offer.attemptId,request)).toThrow(/fenced/);
      w.brain.store.control.prepare("UPDATE runners SET session_epoch=session_epoch-1 WHERE id=?").run(attempt.runner.runnerId);
      const reviewer=w.brain.store.control.prepare("SELECT e.auth_user_id FROM approval_decisions d JOIN step_up_evidence e ON e.id=d.auth_evidence_ref WHERE d.approval_id=?").get(approval.approvalId) as {auth_user_id:string};
      w.brain.store.control.prepare('UPDATE "user" SET twoFactorEnabled=0 WHERE id=?').run(reviewer.auth_user_id);
      expect(w.brain.validatePermit(permit.token,request.invocationId)).toBe(false);
      expect(()=>w.brain.issuePermit(attempt.runner,attempt.offer.attemptId,request)).toThrow(/no longer current/);
      expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_consumptions").get()).toEqual({n:1});
    }finally{w.brain.close();}
  });

  it("suspended/running run keeps its pinned config digest after a new activation (E026)", async () => {
    const w = setupWorld();
    const runId = dispatchGolden(w, "pin-run");
    const pinned = w.brain.activeRelease(w.org)!.digest;
    const changed = goldenDocs().map((d) => d.path.includes("fixture-workflow") ? { ...d, text: `${d.text}\n# v2\n` } : d);
    const { digest: next } = w.brain.stageRelease(w.owner, changed, "sha256:c64a4543ce76fcbcade5797b53bedc08e6d81e9e031a72380c03a07cb788efce");
    w.brain.activateRelease(w.owner, next);
    expect(w.brain.activeRelease(w.org)!.digest).toBe(next);
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const row = ws.prepare("SELECT config_digest FROM workflow_runs WHERE id=?").get(runId) as { config_digest: string };
    expect(row.config_digest).toBe(pinned);
    const job = w.brain.store.control.prepare("SELECT config_digest FROM jobs WHERE workflow_run_id=?").get(runId) as { config_digest: string };
    expect(job.config_digest).toBe(pinned);
    w.brain.close();
  });

  it("cancel tombstones the run; replayed dispatch cannot resurrect it (E028)", async () => {
    const w = setupWorld();
    const runId = dispatchGolden(w, "cancel-run");
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-cancel-run-x", commandType: "workflow.cancel",
      workspaceId: w.workspaceId, idempotencyKey: "cancel-run-x", payload: { runId, reason: "stop" },
    }, "cx");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect((ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state).toBe("cancelled");
    const jobsBefore = (w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workflow_run_id=?").get(runId) as { n: number }).n;
    const replayRun = dispatchGolden(w, "cancel-run");
    expect(replayRun).toBe(runId);
    expect((w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workflow_run_id=?").get(runId) as { n: number }).n).toBe(jobsBefore);
    expect((ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state).toBe("cancelled");
    w.brain.close();
  });

  it("past-deadline jobs are never claimed; failed runs stay failed (E029)", async () => {
    const w = setupWorld();
    dispatchGolden(w, "deadline-run");
    w.brain.store.control.prepare("UPDATE jobs SET deadline_ms=?").run(Date.now() - 1000);
    const r = seedRunner(w, "runner-dl");
    expect(w.brain.claim(r, "req-dl")).toBeNull();
    const w2 = setupWorld();
    const { runner, offer } = runningAttempt(w2, "fail-run", "runner-fail");
    w2.brain.completeAttempt(runner, offer.attemptId, { result: "failed", output: {}, jobFence: offer.jobFence, cleanupConfirmed: true });
    expect(jobState(w2, offer.jobId)).toBe("failed");
    const ws = w2.brain.store.workspaceDb(w2.workspaceId, w2.org);
    const run = ws.prepare("SELECT state FROM workflow_runs LIMIT 1").get() as { state: string };
    expect(run.state).toBe("failed");
    w.brain.close(); w2.brain.close();
  });

  it("atomic reservations prevent oversubscription of one runner (E032)", async () => {
    const w = setupWorld();
    dispatchGolden(w, "cap-1");
    dispatchGolden(w, "cap-2");
    const r = seedRunner(w, "runner-cap", "fixture-tools", { cpu: 4000, mem: 8192, disk: 20480, slots: 1 });
    expect(w.brain.claim(r, "req-cap-1")).toBeTruthy();
    expect(w.brain.claim(r, "req-cap-2")).toBeNull();
    const reserved = w.brain.store.control.prepare("SELECT slots_reserved FROM runners WHERE id=?").get("runner-cap") as { slots_reserved: number };
    expect(reserved.slots_reserved).toBe(1);
    w.brain.close();
  });

  it("new hello epoch fences the old runner session; privileged claims stay unverified (E038/E033)", async () => {
    const w = setupWorld();
    const { token } = w.brain.issueEnrollment(w.owner, "fixture-tools");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const { credential } = w.brain.enrollRunner({ token, publicKeyPem: pem, runnerId: "runner-epoch" });
    const hello = (bootNonce: string) => {
      const chal = w.brain.runnerChallenge("runner-epoch", credential);
      const body: Record<string, unknown> = {
        contractVersion: "brain.runner/v1", runnerId: "runner-epoch", bootNonce, configDigest: DIGEST_A,
        capacity: { cpuMillicores: 4000, memoryMb: 8192, diskMb: 20480, slots: 1 },
        capabilities: [{ capability: "os:linux", verified: true, source: "runner-probe" }, { capability: "privileged:root", verified: true, source: "hello" }],
      };
      const helloDigest = domainDigest("brain:runner-hello:v1", body as unknown as JsonValue);
      const signed = JSON.stringify({ challengeId: chal.challengeId, nonce: chal.nonce, runnerId: "runner-epoch", bootNonce, helloDigest });
      const signatureBase64url = sign(null, Buffer.from(signed, "utf8"), privateKey).toString("base64url");
      return w.brain.runnerHello({ ...body, proof: { challengeId: chal.challengeId, signatureBase64url } });
    };
    const s1 = hello("boot-1");
    expect(s1.epoch).toBe(1);
    const s2 = hello("boot-2");
    expect(s2.epoch).toBe(2);
    expect(() => w.brain.authRunner(new Headers({ authorization: `Bearer ${s1.sessionToken}` }))).toThrow();
    expect(() => w.brain.heartbeat({ runnerId: "runner-epoch", epoch: 1 }, { sequence: 1 })).toThrow();
    // E033: self-asserted privileged capability from the same hellos is unverified.
    const cap = w.brain.store.control.prepare("SELECT verified FROM runner_capabilities WHERE runner_id=? AND capability='privileged:root'").get("runner-epoch") as { verified: number };
    expect(cap.verified).toBe(0);
    const grp = w.brain.store.control.prepare("SELECT group_id FROM runners WHERE id=?").get("runner-epoch") as { group_id: string };
    expect(grp.group_id).toBe("fixture-tools");
    w.brain.close();
  });

  it("zero-capacity runner admits nothing (E040)", async () => {
    const w = setupWorld();
    dispatchGolden(w, "zero-cap");
    const r = seedRunner(w, "runner-zero", "fixture-tools", { cpu: 500, mem: 1024, disk: 512, slots: 1 });
    // Observed free capacity is zero: every dimension fully reserved.
    w.brain.store.control.prepare("UPDATE runners SET cpu_reserved=cpu_capacity, memory_reserved=memory_capacity, disk_reserved=disk_capacity, slots_reserved=slot_capacity WHERE id=?").run("runner-zero");
    expect(w.brain.claim(r, "req-zero")).toBeNull();
    w.brain.close();
  });

  it("disconnect beyond lease becomes outcome_unknown, never blind-requeued (E041)", async () => {
    const w = setupWorld();
    const { offer } = runningAttempt(w, "lost-runner", "runner-lost");
    w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(Date.now() - 1000, offer.attemptId);
    expect(w.brain.expireLeases()).toBeGreaterThan(0);
    expect(jobState(w, offer.jobId)).toBe("outcome_unknown");
    const r2 = seedRunner(w, "runner-other");
    expect(w.brain.claim(r2, "req-other")).toBeNull();
    w.brain.close();
  });

  it("resource fence counter strictly increases across lease deletion (E043)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "fence-1", "runner-f1");
    const s1 = await approveSubject(w, baseSubject(w, "fence-n1"), "fence-apr-1");
    w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "fence-inv-1", subjectDigest: s1.digest, approvalId: s1.approvalId, resourceKeys: ["target:fence"] });
    const fence1 = (w.brain.store.control.prepare("SELECT counter FROM resource_fences WHERE resource_key='target:fence'").get() as { counter: number }).counter;
    w.brain.store.control.prepare("DELETE FROM resource_leases WHERE resource_key='target:fence'").run();
    const b = runningAttempt(w, "fence-2", "runner-f2");
    const s2 = await approveSubject(w, baseSubject(w, "fence-n2"), "fence-apr-2");
    w.brain.issuePermit(b.runner, b.offer.attemptId, { invocationId: "fence-inv-2", subjectDigest: s2.digest, approvalId: s2.approvalId, resourceKeys: ["target:fence"] });
    const fence2 = (w.brain.store.control.prepare("SELECT counter FROM resource_fences WHERE resource_key='target:fence'").get() as { counter: number }).counter;
    expect(fence1).toBe(1);
    expect(fence2).toBe(2);
    w.brain.close();
  });

  it("unresolved guard survives lease expiry and blocks competing effects (E044)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "guard-1", "runner-g1");
    const s1 = await approveSubject(w, baseSubject(w, "guard-n1"), "guard-apr-1");
    w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "guard-inv-1", subjectDigest: s1.digest, approvalId: s1.approvalId, resourceKeys: ["target:guarded"] });
    w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(Date.now() - 1000, a.offer.attemptId);
    w.brain.expireLeases();
    expect(jobState(w, a.offer.jobId)).toBe("outcome_unknown");
    const b = runningAttempt(w, "guard-2", "runner-g2");
    const s2 = await approveSubject(w, baseSubject(w, "guard-n2"), "guard-apr-2");
    expect(() => w.brain.issuePermit(b.runner, b.offer.attemptId, { invocationId: "guard-inv-2", subjectDigest: s2.digest, approvalId: s2.approvalId, resourceKeys: ["target:guarded"] })).toThrow(/guarded/);
    w.brain.close();
  });

  it("draining runner takes no new claims but finishes owned work (E045)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "drain-1", "runner-drain");
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-drain", commandType: "runner.drain",
      idempotencyKey: "drain-1", payload: { runnerId: "runner-drain", reason: "maintenance" },
    }, "cd");
    dispatchGolden(w, "drain-2");
    expect(w.brain.claim(a.runner, "req-drain-2")).toBeNull();
    const done = w.brain.completeAttempt(a.runner, a.offer.attemptId, { result: "succeeded", output: { message: "x" }, jobFence: a.offer.jobFence, cleanupConfirmed: true }) as unknown as { jobState: string };
    expect(done.jobState).toBe("verifying");
    w.brain.close();
  });

  it("quarantine mid-job revokes permit validity and blocks new permits (E046)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "quar-1", "runner-quar");
    const s1 = await approveSubject(w, baseSubject(w, "quar-n1"), "quar-apr");
    const p = w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "quar-inv", subjectDigest: s1.digest, approvalId: s1.approvalId, resourceKeys: [] }) as unknown as { token: string };
    expect(w.brain.validatePermit(p.token, "quar-inv")).toBe(true);
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-quar", commandType: "runner.quarantine",
      idempotencyKey: "quar-1", payload: { runnerId: "runner-quar", reason: "compromised" },
    }, "cq");
    expect(w.brain.validatePermit(p.token, "quar-inv")).toBe(false);
    expect(() => w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "quar-inv-2", subjectDigest: s1.digest, approvalId: s1.approvalId, resourceKeys: [] })).toThrow();
    w.brain.close();
  });
});

function insertJob(w: World, input: { id: string; workspaceId: string; priority: number; group?: string; cpu?: number; mem?: number; createdOffsetMs?: number }): void {
  const s = w.brain.store;
  const placement = {
    group: input.group ?? "fixture-tools",
    all: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"],
    isolation: "ephemeral-container",
    resources: { cpuMillicores: input.cpu ?? 500, memoryMb: input.mem ?? 256, diskMb: 256, slots: 1 },
  };
  const now = s.now() + (input.createdOffsetMs ?? 0);
  s.control.exec("CREATE TABLE IF NOT EXISTS job_payloads(job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL) STRICT");
  const relDigest = w.brain.activeRelease(w.org)!.digest;
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, priority, created_at_ms, ready_at_ms, deadline_ms)
    VALUES (?,?,?,?,?, 'echo', 'queued', ?, ?, ?, 'read', 'WAITING_FOR_RUNNER', ?, ?, ?, ?)`)
    .run(input.id, w.org, input.workspaceId, `key-${input.id}`, `run-${input.id}`, relDigest, JSON.stringify(placement), DIGEST_A, input.priority, now, now, now + 3600000);
  s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(input.id, "dispatch", "{}");
}

describe("scenario gaps (T50 batch 2b: fairness, approvals, evidence, memory)", () => {
  it("small house job fits when a long build cannot — no head-of-line starvation (E047)", async () => {
    const w = setupWorld();
    insertJob(w, { id: "job-big", workspaceId: w.workspaceId, priority: 3, cpu: 60_000, mem: 60_000 });
    insertJob(w, { id: "job-house", workspaceId: w.workspaceId, priority: 1, cpu: 100, mem: 128 });
    const r = seedRunner(w, "runner-fair1");
    const offer = w.brain.claim(r, "req-fair1") as unknown as Offer;
    expect(offer.jobId).toBe("job-house");
    w.brain.close();
  });

  it("inflated priority cannot starve another workspace with fewer in-flight jobs (E048)", async () => {
    const w = setupWorld();
    w.brain.createWorkspace(w.actor("owner-1"), { workspaceId: "ws-other", slug: "other" });
    const a = runningAttempt(w, "greedy-0", "runner-greedy-0");
    void a;
    insertJob(w, { id: "job-greedy", workspaceId: w.workspaceId, priority: 3 }); // schema caps priority at 3
    insertJob(w, { id: "job-other", workspaceId: "ws-other", priority: 1 });
    const r2 = seedRunner(w, "runner-fair2");
    const offer = w.brain.claim(r2, "req-fair2") as unknown as Offer;
    expect(offer.workspaceId).toBe("ws-other");
    expect(offer.jobId).toBe("job-other");
    w.brain.close();
  });

  it("claim paging finds an eligible job beyond the first 100 candidates (E049)", async () => {
    const w = setupWorld();
    for (let i = 0; i < 150; i++) {
      insertJob(w, { id: `job-noise-${i}`, workspaceId: w.workspaceId, priority: 3, group: "someone-else", createdOffsetMs: i });
    }
    insertJob(w, { id: "job-eligible", workspaceId: w.workspaceId, priority: 0 });
    const r = seedRunner(w, "runner-page");
    const offer = w.brain.claim(r, "req-page") as unknown as Offer;
    expect(offer.jobId).toBe("job-eligible");
    w.brain.close();
  });

  it("approval expiring in queue or before effect denies decision and permit (E052)", async () => {
    const w = setupWorld();
    const approver = await w.grantApprover("exp-approver");
    const subject = baseSubject(w, "exp-n1");
    const req = w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-exp-1", commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: "exp-1", payload: { subject },
    }, "ce1");
    const approvalId = (req.receipt as { resourceId?: string }).resourceId ?? "";
    w.brain.store.control.prepare("UPDATE approval_requests SET expires_at_ms=? WHERE id=?").run(Date.now() - 1, approvalId);
    const digest = approvalSubjectDigest(subject as unknown as JsonValue);
    expect(() => w.brain.decideApproval(approver.identity, approvalId, {
      contractVersion: "brain.approval-decision/v1", idempotencyKey: "exp-dec", decision: "reject",
      subjectDigest: digest, expectedVersion: 1, note: "late",
    })).toThrow(/expired/);
    const a = runningAttempt(w, "exp-run", "runner-exp");
    const ok = await approveSubject(w, baseSubject(w, "exp-n2"), "exp-2");
    w.brain.store.control.prepare("UPDATE approval_requests SET expires_at_ms=? WHERE id=?").run(Date.now() - 1, ok.approvalId);
    expect(() => w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "exp-inv", subjectDigest: ok.digest, approvalId: ok.approvalId, resourceKeys: [] })).toThrow(/expired/);
    w.brain.close();
  });

  it("revoke between issuance and effect invalidates the permit at validation (E055)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "rev-1", "runner-rev");
    const s1 = await approveSubject(w, baseSubject(w, "rev-n1"), "rev-apr");
    const p = w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "rev-inv", subjectDigest: s1.digest, approvalId: s1.approvalId, resourceKeys: [] }) as unknown as { token: string };
    expect(w.brain.validatePermit(p.token, "rev-inv")).toBe(true);
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-rev", commandType: "approval.revoke",
      workspaceId: w.workspaceId, idempotencyKey: "rev-1", payload: { approvalId: s1.approvalId, reason: "changed mind" },
    }, "cr");
    expect(w.brain.validatePermit(p.token, "rev-inv")).toBe(false);
    w.brain.close();
  });

  it("crash after mutation: outcome unknown blocks retry until reconciliation (E056)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "crash-1", "runner-crash");
    w.brain.completeAttempt(a.runner, a.offer.attemptId, { result: "unknown-outcome", output: {}, jobFence: a.offer.jobFence, cleanupConfirmed: false });
    expect(jobState(w, a.offer.jobId)).toBe("outcome_unknown");
    const r2 = seedRunner(w, "runner-crash-2");
    expect(w.brain.claim(r2, "req-crash-2")).toBeNull();
    const jobVersion = (w.brain.store.control.prepare("SELECT version FROM jobs WHERE id=?").get(a.offer.jobId) as { version: number }).version;
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-rec", commandType: "job.reconcile",
      workspaceId: w.workspaceId, idempotencyKey: "rec-1", expectedVersion: jobVersion, payload: { jobId: a.offer.jobId, reason: "probe" },
    }, "crec");
    w.brain.reconcileJob({ organizationId: w.org, jobId: a.offer.jobId, outcome: "unknown", evidenceDigest: DIGEST_A });
    expect(jobState(w, a.offer.jobId)).toBe("outcome_unknown");
    w.brain.reconcileJob({ organizationId: w.org, jobId: a.offer.jobId, outcome: "absent", evidenceDigest: DIGEST_A });
    expect(jobState(w, a.offer.jobId)).toBe("queued");
    expect(w.brain.claim(r2, "req-crash-3")).toBeTruthy();
    w.brain.close();
  });

  it("changed target precondition after approval blocks the permit (E058)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "pre-1", "runner-pre");
    const approved = await approveSubject(w, baseSubject(w, "pre-n1"), "pre-apr");
    const moved = baseSubject(w, "pre-n1", { target: { targetId: "t-1", environmentId: "prod", preconditionDigest: `sha256:${"b".repeat(64)}` } });
    const movedDigest = approvalSubjectDigest(moved as unknown as JsonValue);
    expect(movedDigest).not.toBe(approved.digest);
    expect(() => w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "pre-inv", subjectDigest: movedDigest, approvalId: approved.approvalId, resourceKeys: [] })).toThrow(/mismatch/);
    w.brain.close();
  });

  it("two aliases of one physical target share one canonical conflict key (E059)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "alias-1", "runner-a1");
    const s1 = await approveSubject(w, baseSubject(w, "alias-n1"), "alias-apr-1");
    w.brain.issuePermit(a.runner, a.offer.attemptId, { invocationId: "alias-inv-1", subjectDigest: s1.digest, approvalId: s1.approvalId, resourceKeys: ["Target:Prod-DB/"] });
    const b = runningAttempt(w, "alias-2", "runner-a2");
    const s2 = await approveSubject(w, baseSubject(w, "alias-n2"), "alias-apr-2");
    expect(() => w.brain.issuePermit(b.runner, b.offer.attemptId, { invocationId: "alias-inv-2", subjectDigest: s2.digest, approvalId: s2.approvalId, resourceKeys: ["target:prod-db"] })).toThrow(/guarded/);
    w.brain.close();
  });

  it("malformed, duplicate and oversized harness events are contained (E063/E072)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "ev-1", "runner-ev");
    const body = { leaseId: a.offer.leaseId, jobFence: a.offer.jobFence };
    const ok = w.brain.attemptEvents(a.runner, a.offer.attemptId, { ...body, events: [{ sequence: 1, text: "a" }, { sequence: 2, text: "b" }] }) as unknown as { lastCommittedSequence: number };
    expect(ok.lastCommittedSequence).toBe(2);
    const dup = w.brain.attemptEvents(a.runner, a.offer.attemptId, { ...body, events: [{ sequence: 1, text: "again" }, { sequence: 3, text: "c" }] }) as unknown as { lastCommittedSequence: number };
    expect(dup.lastCommittedSequence).toBe(3);
    expect(() => w.brain.attemptEvents(a.runner, a.offer.attemptId, { ...body, events: [{ sequence: "x" }] })).toThrow(/sequence/);
    expect(() => w.brain.attemptEvents(a.runner, a.offer.attemptId, { ...body, events: ["truncated"] })).toThrow();
    expect(() => w.brain.attemptEvents(a.runner, a.offer.attemptId, { ...body, events: Array.from({ length: 129 }, (_, i) => ({ sequence: 10 + i })) })).toThrow(/128/);
    const after = w.brain.attemptEvents(a.runner, a.offer.attemptId, { ...body, events: [] }) as unknown as { lastCommittedSequence: number };
    expect(after.lastCommittedSequence).toBe(3); // durable stream unharmed by rejects
    w.brain.close();
  });

  it("changed verdict for the same bundle conflicts; identical replay is stable (E075)", async () => {
    const w = setupWorld();
    const a = runningAttempt(w, "verd-1", "runner-verd");
    w.brain.completeAttempt(a.runner, a.offer.attemptId, { result: "succeeded", output: { message: "Brain fixture" }, jobFence: a.offer.jobFence, cleanupConfirmed: true });
    const bundle=bundleForAttempt(w.brain,w.org,w.workspaceId,a.offer.attemptId,"bundle-verd");
    const submitted = w.brain.submitEvidence(a.runner,bundle) as {digest:string};
    const evaluator=seedRunner(w,"runner-verdict-eval","fixture-evaluators");
    attestDomain(w.brain,a.runner.runnerId,"author"); attestDomain(w.brain,evaluator.runnerId,"evaluator");
    const offer=w.brain.claim(evaluator,"claim-verdict-eval") as unknown as Offer;
    w.brain.ackAttempt(evaluator,offer.attemptId,{leaseId:offer.leaseId,jobFence:offer.jobFence});
    w.brain.completeAttempt(evaluator,offer.attemptId,{result:"succeeded",output:{checks:bundle.checks},jobFence:offer.jobFence,cleanupConfirmed:true});
    const assignment=w.brain.evidence.assignment(offer.jobId)!;
    const verdict = {contractVersion:"brain.verdict/v1",bundleDigest:submitted.digest,evaluatorAttemptId:offer.attemptId,evaluatorRelease:assignment.evaluatorRelease,
      independence:assignment.independence,outcome:"verified",checks:bundle.checks,acceptedBy:evaluator.runnerId,createdAt:w.brain.store.nowIso()};
    const first = w.brain.acceptVerdict(evaluator,w.workspaceId,verdict) as { verdictId: string };
    const replay = w.brain.acceptVerdict(evaluator,w.workspaceId,verdict) as { verdictId: string };
    expect(replay.verdictId).toBe(first.verdictId);
    expect(() => w.brain.acceptVerdict(evaluator,w.workspaceId,{ ...verdict, outcome: "rejected" })).toThrow(/immutable/);
    w.brain.close();
  });

  it("only distinct verified roots count; concurrent thirds yield one candidate (E076/E077)", async () => {
    const w = setupWorld();
    const obs = (root: string, verified = true) => w.brain.recordToolObservation({
      organizationId: w.org, workspaceId: w.workspaceId, signature: "sig-x", rootOperationId: root, packageDigest: DIGEST_A, verified,
    }) as unknown as { distinctVerifiedRoots: number; candidateId: string | null };
    expect(obs("root-1").candidateId).toBeNull();
    expect(obs("root-1").distinctVerifiedRoots).toBe(1); // retry of same root
    expect(obs("root-1").distinctVerifiedRoots).toBe(1);
    expect(obs("root-2", false).distinctVerifiedRoots).toBe(1); // unverified never counts
    expect(obs("root-2").distinctVerifiedRoots).toBe(1); // first write wins per root
    expect(obs("root-3").candidateId).toBeNull();
    const third = obs("root-4");
    expect(third.distinctVerifiedRoots).toBe(3);
    expect(third.candidateId).toBeTruthy();
    const fourth = obs("root-5");
    expect(fourth.candidateId).toBe(third.candidateId);
    const rows = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n, state FROM tool_candidates WHERE signature='sig-x'").get() as { n: number; state: string };
    expect(rows.n).toBe(1);
    expect(rows.state).toBe("quarantined");
    w.brain.close();
  });

  it("memory publication rejects secret shapes incl. unenumerated names; results stay advisory (E080)", async () => {
    const w = setupWorld();
    const pub = (text: string, id: string) => w.brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: id, text });
    expect(() => pub("client_secret: hunter2", "s1")).toThrow(/secret/);
    expect(() => pub("SERVICE_ACCOUNT_TOKEN=abc123", "s2")).toThrow();
    expect(() => pub("-----BEGIN RSA PRIVATE KEY-----\nmii...", "s3")).toThrow();
    expect(() => pub("key is ghp_0123456789abcdefghij0123", "s4")).toThrow();
    expect(() => pub("Authorization: Bearer abcdefghijklmnopqrstuvwx", "s5")).toThrow();
    expect(pub("deploy runbook: restart the fixture service", "s6")).toBeTruthy();
    const found = w.brain.memory.search(
      { query: "runbook", limit: 4, maxChars: 1000, scope: { organizationId: w.org, visibility: "workspace", workspaceId: w.workspaceId } } as never,
      { organizationId: w.org, workspaceId: w.workspaceId },
    );
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.every((r) => r.status === "unverified")).toBe(true);
    w.brain.close();
  });

  it("memory export is an honest partial manifest with named omissions (E081)", async () => {
    const w = setupWorld();
    w.brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: "exp-1", text: "exportable note" });
    const out = w.brain.memory.exportScope(w.org, w.workspaceId);
    expect(out.completeness).toBe("partial");
    expect(out.missing).toContain("tencentdb-wiki");
    expect(out.missing).toContain("tencentdb-codegraph");
    expect(out.count).toBeGreaterThan(0);
    w.brain.close();
  });

  it("duplicate observations dedupe; id collision with new payload parks (E082/E086)", async () => {
    const w = setupWorld();
    const base = { organizationId: w.org, workspaceId: w.workspaceId, sourceId: "gitlab", externalId: "evt-9", cursor: "c-1" };
    const first = w.brain.ingestObservation({ ...base, payload: { title: "one" } }) as unknown as { outcome: string };
    const dup = w.brain.ingestObservation({ ...base, payload: { title: "one" } }) as unknown as { outcome: string };
    const clash = w.brain.ingestObservation({ ...base, payload: { title: "two" } }) as unknown as { outcome: string };
    expect(first.outcome).toBe("accepted");
    expect(dup.outcome).toBe("duplicate");
    expect(clash.outcome).toBe("parked");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const accepted = ws.prepare("SELECT payload_json FROM source_observations WHERE source_id='gitlab' AND external_id='evt-9'").get() as { payload_json: string };
    expect(JSON.parse(accepted.payload_json)).toEqual({ title: "one" });
    w.brain.close();
  });

  it("repeated identical approval requests share one signature request (E083)", async () => {
    const w = setupWorld();
    const subject = baseSubject(w, "shared-n1");
    const ask = (k: string) => (w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: `cmd-${k}`, commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: k, payload: { subject },
    }, k).receipt as { resourceId?: string }).resourceId;
    const first = ask("shared-1");
    const second = ask("shared-2");
    expect(second).toBe(first);
    const changed = baseSubject(w, "shared-n2");
    const third = (w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-shared-3", commandType: "approval.request",
      workspaceId: w.workspaceId, idempotencyKey: "shared-3", payload: { subject: changed },
    }, "shared-3").receipt as { resourceId?: string }).resourceId;
    expect(third).not.toBe(first); // changed draft requires its own fresh approval
    w.brain.close();
  });

  it("SSE replay resumes strictly after the cursor with no duplicates or gaps (E091)", async () => {
    const w = setupWorld();
    dispatchGolden(w, "sse-1");
    const all = w.brain.listEvents(w.owner, 0, 500) as unknown as Array<{ cursor: number }>;
    expect(all.length).toBeGreaterThan(2);
    const mid = all[1]!.cursor;
    const resumed = w.brain.listEvents(w.owner, mid, 500) as unknown as Array<{ cursor: number }>;
    expect(resumed.every((e) => e.cursor > mid)).toBe(true);
    expect([...all.slice(0, 2).map((e) => e.cursor), ...resumed.map((e) => e.cursor)]).toEqual(all.map((e) => e.cursor));
    const otherOrgActor = { ...w.owner, organizationId: "org-elsewhere" };
    expect(w.brain.listEvents(otherOrgActor, 0, 500)).toEqual([]);
    w.brain.close();
  });
});
