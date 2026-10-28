import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// T46 packet acceptance: safe drift reconciliation. An outcome_unknown job
// is never blindly retried: an authorized reconcile request records the
// observation outcome; only proven-absent frees the job for a fresh attempt,
// conflicting/unknown keeps the guard, and there is no universal permission.
type Offer = { attemptId: string; jobId: string; jobFence: number };

function seedRunner(w: TestWorld, id: string): { runnerId: string; epoch: number; organizationId: string } {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 2)`).run(id, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId: id, epoch: 1, organizationId: w.org };
}

function unknownJob(w: TestWorld, key: string): { jobId: string; version: number } {
  const digest = w.brain.activeRelease(w.org)!.digest;
  w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch",
    workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: key } },
  }, key);
  const runner = seedRunner(w, `runner-${key}`);
  const offer = w.brain.claim(runner, `req-${key}`) as Offer | null;
  expect(offer).toBeTruthy();
  const s = w.brain.store;
  s.control.prepare("UPDATE job_attempts SET state='outcome_unknown' WHERE id=?").run(offer!.attemptId);
  s.control.prepare("UPDATE jobs SET state='outcome_unknown', version=version+1 WHERE id=?").run(offer!.jobId);
  const job = s.control.prepare("SELECT version FROM jobs WHERE id=?").get(offer!.jobId) as { version: number };
  return { jobId: offer!.jobId, version: job.version };
}

describe("drift reconciler (T46)", () => {
  it("absent outcome frees the job for a fresh attempt; conflicting keeps the guard", () => {
    const w = setupWorld();
    const s = w.brain.store;
    const a = unknownJob(w, "rec-a");
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-reconcile-a", commandType: "job.reconcile",
      workspaceId: w.workspaceId, idempotencyKey: "rec-a", expectedVersion: a.version,
      payload: { jobId: a.jobId, reason: "runner vanished mid-effect" },
    }, "rec-a");
    w.brain.reconcileJob({ organizationId: w.org, jobId: a.jobId, outcome: "absent", evidenceDigest: DIGEST_A });
    expect((s.control.prepare("SELECT state FROM jobs WHERE id=?").get(a.jobId) as { state: string }).state).toBe("queued");
    expect((s.control.prepare("SELECT state FROM reconciliation_requests WHERE command_id='cmd-reconcile-a'").get() as { state: string }).state).toBe("resolved");

    const b = unknownJob(w, "rec-b");
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-reconcile-b", commandType: "job.reconcile",
      workspaceId: w.workspaceId, idempotencyKey: "rec-b", expectedVersion: b.version,
      payload: { jobId: b.jobId, reason: "conflicting readback" },
    }, "rec-b");
    w.brain.reconcileJob({ organizationId: w.org, jobId: b.jobId, outcome: "conflicting", evidenceDigest: DIGEST_A });
    expect((s.control.prepare("SELECT state FROM jobs WHERE id=?").get(b.jobId) as { state: string }).state).toBe("outcome_unknown");
    expect((s.control.prepare("SELECT state FROM reconciliation_requests WHERE command_id='cmd-reconcile-b'").get() as { state: string }).state).toBe("blocked");
    w.brain.close();
  });

  it("reconcile is refused for known-state jobs, stale versions and unauthorized actors", () => {
    const w = setupWorld();
    const a = unknownJob(w, "rec-c");
    expect(() => w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-reconcile-c1", commandType: "job.reconcile",
      workspaceId: w.workspaceId, idempotencyKey: "rec-c1", expectedVersion: a.version + 5,
      payload: { jobId: a.jobId, reason: "stale view" },
    }, "rec-c1")).toThrow(/version/);
    const outsider = w.actor("mallory", w.workspaceId);
    expect(() => w.brain.executeCommand(outsider, {
      contractVersion: "brain.command/v1", commandId: "cmd-reconcile-c2", commandType: "job.reconcile",
      workspaceId: w.workspaceId, idempotencyKey: "rec-c2", expectedVersion: a.version,
      payload: { jobId: a.jobId, reason: "no authority" },
    }, "rec-c2")).toThrow();
    w.brain.reconcileJob({ organizationId: w.org, jobId: a.jobId, outcome: "absent", evidenceDigest: DIGEST_A });
    const after = w.brain.store.control.prepare("SELECT version FROM jobs WHERE id=?").get(a.jobId) as { version: number };
    expect(() => w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-reconcile-c3", commandType: "job.reconcile",
      workspaceId: w.workspaceId, idempotencyKey: "rec-c3", expectedVersion: after.version,
      payload: { jobId: a.jobId, reason: "already known" },
    }, "rec-c3")).toThrow(/only outcome_unknown/);
    w.brain.close();
  });
});
