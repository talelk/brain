import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A } from "../helpers";

type World = ReturnType<typeof setupWorld>;

function seedRunner(w: World, runnerId: string) {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(runnerId, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)")
      .run(runnerId, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}

interface Offer { attemptId: string; leaseId: string; jobFence: number; jobId: string }

/** Dispatches the fixture workflow, makes its job an agent step and runs it to the point where the author finished and awaits evidence. */
async function authorFinished(w: World, key: string, runnerId: string, asAgent = true): Promise<Offer> {
  const digest = w.brain.activeRelease(w.org)!.digest;
  await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
  }, key);
  if (asAgent) w.brain.store.control.prepare("UPDATE job_payloads SET payload_json=json_set(payload_json,'$.step.uses.type','agent') WHERE job_id IN (SELECT id FROM jobs ORDER BY rowid DESC LIMIT 1)").run();
  const runner = seedRunner(w, runnerId);
  const offer = w.brain.jobProtocol.claim(runner, `req-${key}`) as unknown as Offer;
  w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  w.brain.jobProtocol.complete(runner, offer.attemptId, { result: "succeeded", output: { ok: true }, jobFence: offer.jobFence, cleanupConfirmed: true });
  return offer;
}

const job = (w: World, id: string) => w.brain.store.control.prepare("SELECT state, queue_reason, attempt_counter FROM jobs WHERE id=?").get(id) as { state: string; queue_reason: string | null; attempt_counter: number };
const MIN = 60_000;
const age = (w: World, offer: Offer, minutes: number) => w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=?, offer_expires_at_ms=? WHERE id=?").run(Date.now() - minutes * MIN, Date.now() - minutes * MIN - 1000, offer.attemptId);

describe("stuck-run watchdog", () => {
  it("leaves a fresh finished author alone, restarts one that waited too long for evidence, and is idempotent", async () => {
    const w = setupWorld();
    try {
      const offer = await authorFinished(w, "wd-verifying", "runner-wd1");
      expect(job(w, offer.jobId).state).toBe("verifying");
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(0);
      age(w, offer, 20);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(1);
      expect(job(w, offer.jobId)).toMatchObject({ state: "queued", queue_reason: "RESTARTED_AFTER_INTERRUPTION" });
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(0);
      const again = w.brain.jobProtocol.claim(seedRunner(w, "runner-wd1b"), "req-wd-again") as unknown as Offer;
      expect(again.jobId).toBe(offer.jobId);
      expect(again.attemptId).not.toBe(offer.attemptId);
      const events = w.brain.store.control.prepare("SELECT payload_json FROM events WHERE aggregate_id=? AND event_type='job.updated'").all(offer.jobId) as Array<{ payload_json: string }>;
      expect(events.some((e) => /stopped responding after 20 minutes; Brain restarted it/.test(e.payload_json))).toBe(true);
    } finally { w.brain.close(); }
  });

  it("fails the step with a plain reason once the restarts are used up", async () => {
    const w = setupWorld();
    try {
      const offer = await authorFinished(w, "wd-exhausted", "runner-wd2");
      w.brain.store.control.prepare("UPDATE jobs SET attempt_counter=5 WHERE id=?").run(offer.jobId);
      age(w, offer, 30);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(1);
      expect(job(w, offer.jobId).state).toBe("failed");
      const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
      expect((ws.prepare("SELECT state FROM workflow_runs LIMIT 1").get() as { state: string }).state).toBe("failed");
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(0);
    } finally { w.brain.close(); }
  });

  it("never blind-restarts a tool step; it stays outcome_unknown for a person", async () => {
    const w = setupWorld();
    try {
      const offer = await authorFinished(w, "wd-tool", "runner-wd3", false);
      age(w, offer, 30);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(1);
      expect(job(w, offer.jobId).state).toBe("outcome_unknown");
    } finally { w.brain.close(); }
  });

  it("requeues a running job whose attempt is gone", async () => {
    const w = setupWorld();
    try {
      const offer = await authorFinished(w, "wd-lost", "runner-wd4");
      const s = w.brain.store.control;
      s.prepare("UPDATE job_attempts SET state='failed' WHERE id=?").run(offer.attemptId);
      s.prepare("UPDATE jobs SET state='running' WHERE id=?").run(offer.jobId);
      age(w, offer, 30);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(1);
      expect(job(w, offer.jobId)).toMatchObject({ state: "queued", queue_reason: "RESTARTED_AFTER_INTERRUPTION" });
    } finally { w.brain.close(); }
  });
});
