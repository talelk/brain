import { describe, expect, it } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";
import { setupWorld, DIGEST_A } from "../helpers";

describe("a stuck run is recovered by the first sweep of a restarted Governor", () => {
  it("restarts a finished author that never got its evidence accepted, once", async () => {
    const world = setupWorld();
    let reopened: Brain | undefined;
    try {
      const s = world.brain.store;
      const digest = world.brain.activeRelease(world.org)!.digest;
      await world.brain.executeCommand(world.owner, {
        contractVersion: "brain.command/v1", commandId: "cmd-stuck", commandType: "workflow.dispatch", workspaceId: world.workspaceId, idempotencyKey: "stuck-1",
        payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
      }, "stuck-1");
      s.control.prepare("UPDATE job_payloads SET payload_json=json_set(payload_json,'$.step.uses.type','agent')").run();
      s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
        VALUES ('runner-stuck', ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(world.org, DIGEST_A, s.now());
      for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
        s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES ('runner-stuck', ?, 1, 'test', ?, ?)").run(cap, s.now(), s.now() + 3600000);
      }
      const runner = { runnerId: "runner-stuck", epoch: 1, organizationId: world.org };
      const offer = world.brain.jobProtocol.claim(runner, "req-stuck") as unknown as { attemptId: string; leaseId: string; jobFence: number; jobId: string };
      world.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      world.brain.jobProtocol.complete(runner, offer.attemptId, { result: "succeeded", output: { ok: true }, jobFence: offer.jobFence, cleanupConfirmed: true });
      // The runner and the Governor both died before any evidence arrived, and a long time passed.
      const longAgo = Date.now() - 80 * 60_000;
      s.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=?, offer_expires_at_ms=? WHERE id=?").run(longAgo, longAgo - 1000, offer.attemptId);
      world.brain.close();

      reopened = new Brain({ dataDir: world.dir, allowTestActor: true });
      expect(reopened.jobProtocol.sweepStuckJobs()).toBe(1);
      expect(reopened.jobProtocol.sweepStuckJobs()).toBe(0);
      const job = reopened.store.control.prepare("SELECT state, queue_reason FROM jobs WHERE id=?").get(offer.jobId) as { state: string; queue_reason: string };
      expect(job).toEqual({ state: "queued", queue_reason: "RESTARTED_AFTER_INTERRUPTION" });
    } finally {
      reopened?.close();
    }
  });

  it("recovers a job left outcome_unknown with its restarts used up: one more try, no data migration", async () => {
    const world = setupWorld();
    let reopened: Brain | undefined;
    const previous = process.env["BRAIN_PARKED_COOLDOWN_SECONDS"];
    process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] = "1";
    try {
      const s = world.brain.store;
      const digest = world.brain.activeRelease(world.org)!.digest;
      await world.brain.executeCommand(world.owner, {
        contractVersion: "brain.command/v1", commandId: "cmd-left", commandType: "workflow.dispatch", workspaceId: world.workspaceId, idempotencyKey: "left-1",
        payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
      }, "left-1");
      s.control.prepare("UPDATE job_payloads SET payload_json=json_set(payload_json,'$.step.uses.type','agent')").run();
      s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
        VALUES ('runner-left', ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(world.org, DIGEST_A, s.now());
      for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
        s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES ('runner-left', ?, 1, 'test', ?, ?)").run(cap, s.now(), s.now() + 3600000);
      }
      const runner = { runnerId: "runner-left", epoch: 1, organizationId: world.org };
      const offer = world.brain.jobProtocol.claim(runner, "req-left") as unknown as { attemptId: string; leaseId: string; jobFence: number; jobId: string };
      world.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      // The live shape: four earlier restarts already used, and the fifth attempt's lease ran out while the Governor was down.
      for (let i = 0; i < 4; i++) s.control.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms)
        VALUES (?,?,?,?,?,?,?,'failed',1,1)`).run(`att-old-${i}`, offer.jobId, "runner-left", 1, 100 + i, `lease-old-${i}`, 100 + i);
      s.control.prepare("UPDATE job_attempts SET state='outcome_unknown', lease_expires_at_ms=?, offer_expires_at_ms=? WHERE id=?").run(Date.now() - 20 * 60_000, Date.now() - 21 * 60_000, offer.attemptId);
      s.control.prepare("UPDATE jobs SET state='outcome_unknown' WHERE id=?").run(offer.jobId);
      world.brain.close();

      reopened = new Brain({ dataDir: world.dir, allowTestActor: true });
      expect(reopened.jobProtocol.sweepStuckJobs()).toBe(1);
      expect(reopened.jobProtocol.sweepStuckJobs()).toBe(0);
      const job = reopened.store.control.prepare("SELECT state, queue_reason, auto_retries FROM jobs WHERE id=?").get(offer.jobId) as { state: string; queue_reason: string; auto_retries: number };
      expect(job).toEqual({ state: "queued", queue_reason: "RESTARTED_AFTER_INTERRUPTION", auto_retries: 1 });
    } finally {
      if (previous === undefined) delete process.env["BRAIN_PARKED_COOLDOWN_SECONDS"]; else process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] = previous;
      reopened?.close();
    }
  });
});
