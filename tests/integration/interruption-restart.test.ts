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

async function dispatch(w: World, key: string): Promise<void> {
  const digest = w.brain.activeRelease(w.org)!.digest;
  await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
  }, key);
}

/** Makes the queued fixture job a reasoning (agent) step, the kind that restarts itself, then runs it on a runner. */
async function running(w: World, key: string, runnerId: string, asAgent: boolean): Promise<{ runner: ReturnType<typeof seedRunner>; offer: Offer }> {
  await dispatch(w, key);
  if (asAgent) w.brain.store.control.prepare("UPDATE job_payloads SET payload_json=json_set(payload_json,'$.step.uses.type','agent') WHERE job_id IN (SELECT id FROM jobs ORDER BY rowid DESC LIMIT 1)").run();
  const runner = seedRunner(w, runnerId);
  const offer = w.brain.jobProtocol.claim(runner, `req-${key}`) as unknown as Offer;
  expect(offer).toBeTruthy();
  w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  return { runner, offer };
}

const job = (w: World, id: string) => w.brain.store.control.prepare("SELECT state, queue_reason, attempt_counter FROM jobs WHERE id=?").get(id) as { state: string; queue_reason: string | null; attempt_counter: number };
const attemptState = (w: World, id: string) => (w.brain.store.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(id) as { state: string }).state;

describe("an interrupted reasoning step restarts itself", () => {
  it("re-queues an agent job whose runner went away, on a fresh attempt, and does not fail the run", async () => {
    const w = setupWorld();
    try {
      const { offer } = await running(w, "agent-expiry", "runner-gone", true);
      w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(Date.now() - 1000, offer.attemptId);
      expect(w.brain.jobProtocol.expireLeases()).toBeGreaterThan(0);
      expect(job(w, offer.jobId)).toMatchObject({ state: "queued", queue_reason: "RESTARTED_AFTER_INTERRUPTION" });
      expect(attemptState(w, offer.attemptId)).toBe("failed");
      const runState = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT state FROM workflow_runs LIMIT 1").get() as { state: string }).state;
      expect(runState).not.toBe("failed");
      const again = w.brain.jobProtocol.claim(seedRunner(w, "runner-fresh"), "req-agent-again") as unknown as Offer;
      expect(again.jobId).toBe(offer.jobId);
      expect(again.attemptId).not.toBe(offer.attemptId);
      expect(job(w, offer.jobId).attempt_counter).toBe(2);
    } finally { w.brain.close(); }
  });

  it("also restarts when the runner itself reports that the outcome is unknown", async () => {
    const w = setupWorld();
    try {
      const { runner, offer } = await running(w, "agent-unknown", "runner-unknown", true);
      w.brain.jobProtocol.complete(runner, offer.attemptId, { result: "unknown-outcome", output: { error: "agent execution aborted; outcome unknown" }, jobFence: offer.jobFence, cleanupConfirmed: true });
      expect(job(w, offer.jobId).state).toBe("queued");
    } finally { w.brain.close(); }
  });

  it("does not spend the restart budget on interruptions caused by the platform, up to a high safety cap", async () => {
    const w = setupWorld();
    try {
      const { offer } = await running(w, "agent-platform", "runner-platform", true);
      const c = w.brain.store.control;
      for (let i = 0; i < 6; i++) c.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms, interruption)
        VALUES (?,?,?,?,?,?,?,'failed',1,1,'platform')`).run(`att-old-${i}`, offer.jobId, "runner-platform", 1, 100 + i, `lease-old-${i}`, 100 + i);
      c.prepare("UPDATE jobs SET attempt_counter=7 WHERE id=?").run(offer.jobId);
      c.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(Date.now() - 1000, offer.attemptId);
      w.brain.jobProtocol.expireLeases();
      expect(job(w, offer.jobId)).toMatchObject({ state: "queued", queue_reason: "RESTARTED_AFTER_INTERRUPTION" });
      expect((c.prepare("SELECT interruption FROM job_attempts WHERE id=?").get(offer.attemptId) as { interruption: string }).interruption).toBe("platform");
    } finally { w.brain.close(); }
  });

  it("stops restarting at the safety cap even when every interruption was the platform's", async () => {
    const w = setupWorld();
    try {
      const { offer } = await running(w, "agent-cap", "runner-cap", true);
      w.brain.store.control.prepare("UPDATE jobs SET attempt_counter=20 WHERE id=?").run(offer.jobId);
      w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(Date.now() - 1000, offer.attemptId);
      w.brain.jobProtocol.expireLeases();
      expect(job(w, offer.jobId).state).toBe("outcome_unknown");
    } finally { w.brain.close(); }
  });

  it("never blind-restarts a tool step: its outcome stays unknown until reconciled", async () => {
    const w = setupWorld();
    try {
      const { offer } = await running(w, "tool-expiry", "runner-tool", false);
      w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(Date.now() - 1000, offer.attemptId);
      w.brain.jobProtocol.expireLeases();
      expect(job(w, offer.jobId).state).toBe("outcome_unknown");
    } finally { w.brain.close(); }
  });
});
