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

  it("retries once more after the cooldown when restarts are used up, then stops the step with a plain 'try again' reason", async () => {
    const w = setupWorld();
    const previous = process.env["BRAIN_PARKED_COOLDOWN_SECONDS"];
    process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] = "30";
    try {
      const offer = await authorFinished(w, "wd-exhausted", "runner-wd2");
      const c = w.brain.store.control;
      for (let i = 0; i < 4; i++) c.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms)
        VALUES (?,?,?,?,?,?,?,'failed',1,1)`).run(`att-old-${i}`, offer.jobId, "runner-wd2", 1, 100 + i, `lease-old-${i}`, 100 + i);
      // Fifth interruption, but the cooldown has not passed yet.
      c.prepare("UPDATE job_attempts SET lease_expires_at_ms=?, offer_expires_at_ms=? WHERE id=?").run(Date.now() - 10_000, Date.now() - 11_000, offer.attemptId);
      w.brain.jobProtocol.sweepStuckJobs(1);
      expect(job(w, offer.jobId).state).toBe("outcome_unknown");
      expect(w.brain.jobProtocol.sweepStuckJobs(1)).toBe(0);
      // After the cooldown it is queued once more, exactly once.
      c.prepare("UPDATE job_attempts SET lease_expires_at_ms=?, offer_expires_at_ms=? WHERE id=?").run(Date.now() - 60_000, Date.now() - 61_000, offer.attemptId);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(1);
      expect(job(w, offer.jobId)).toMatchObject({ state: "queued", queue_reason: "RESTARTED_AFTER_INTERRUPTION" });
      expect((c.prepare("SELECT auto_retries FROM jobs WHERE id=?").get(offer.jobId) as { auto_retries: number }).auto_retries).toBe(1);
      // The extra try is interrupted too: the step stops with a plain reason and the run fails for a person.
      const runner = seedRunner(w, "runner-wd2b");
      const again = w.brain.jobProtocol.claim(runner, "req-wd-extra") as unknown as Offer;
      w.brain.jobProtocol.ack(runner, again.attemptId, { leaseId: again.leaseId, jobFence: again.jobFence });
      w.brain.jobProtocol.complete(runner, again.attemptId, { result: "succeeded", output: { ok: true }, jobFence: again.jobFence, cleanupConfirmed: true });
      c.prepare("UPDATE job_attempts SET lease_expires_at_ms=1, offer_expires_at_ms=1 WHERE id=?").run(offer.attemptId);
      age(w, again, 40);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBeGreaterThan(0);
      expect(job(w, offer.jobId).state).toBe("failed");
      const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
      expect((ws.prepare("SELECT state FROM workflow_runs LIMIT 1").get() as { state: string }).state).toBe("failed");
      const out = ws.prepare("SELECT output_json FROM step_outputs LIMIT 1").get() as { output_json: string };
      expect(JSON.parse(out.output_json)).toMatchObject({ code: "AGENT_INTERRUPTED", error: "The agent was interrupted 6 times; try again." });
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(0);
    } finally {
      if (previous === undefined) delete process.env["BRAIN_PARKED_COOLDOWN_SECONDS"]; else process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] = previous;
      w.brain.close();
    }
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

  const attention = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "attention.list" } as never)) as unknown as { snapshot: { items: Array<{ id: string; kind: string; detail?: string; safeToRetry?: boolean; version?: number; resourceId: string }> } }).snapshot.items;
  const settle = async (w: World, jobId: string, resolution: "fail" | "retry", version: number) => (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${resolution}-${jobId}`, commandType: "job.reconcile", workspaceId: w.workspaceId, idempotencyKey: `${resolution}-${jobId}`,
    expectedVersion: version, payload: { jobId, reason: "test", resolution },
  } as never, `${resolution}-${jobId}`)).receipt;

  it("a tool step left outcome_unknown appears in Needs you with a plain reason; Treat as failed fails the step, never retried automatically", async () => {
    const w = setupWorld();
    try {
      const offer = await authorFinished(w, "wd-unk-write", "runner-unk1", false);
      w.brain.store.control.prepare("UPDATE jobs SET effect_class='write' WHERE id=?").run(offer.jobId);
      age(w, offer, 30);
      w.brain.jobProtocol.sweepStuckJobs(15 * MIN);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBe(0);
      const item = (await attention(w)).find((entry) => entry.kind === "outcome-unknown");
      expect(item).toMatchObject({ id: `unknown:${offer.jobId}`, safeToRetry: false });
      expect(item?.detail).toMatch(/may already have changed something outside Brain/);
      // Try again is refused for an effectful step.
      await expect(Promise.resolve().then(async () => await settle(w, offer.jobId, "retry", item!.version!))).rejects.toThrow(/not safe/);
      expect(job(w, offer.jobId).state).toBe("outcome_unknown");
      await settle(w, offer.jobId, "fail", item!.version!);
      expect(job(w, offer.jobId).state).toBe("failed");
      expect((await attention(w)).some((entry) => entry.kind === "outcome-unknown")).toBe(false);
      const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
      expect((ws.prepare("SELECT state FROM workflow_runs LIMIT 1").get() as { state: string }).state).toBe("failed");
    } finally { w.brain.close(); }
  });

  it("a read-only tool step left outcome_unknown offers Try again, which queues it once for a fresh attempt", async () => {
    const w = setupWorld();
    try {
      const offer = await authorFinished(w, "wd-unk-read", "runner-unk2", false);
      age(w, offer, 30);
      w.brain.jobProtocol.sweepStuckJobs(15 * MIN);
      const item = (await attention(w)).find((entry) => entry.kind === "outcome-unknown");
      expect(item).toMatchObject({ safeToRetry: true });
      await settle(w, offer.jobId, "retry", item!.version!);
      expect(job(w, offer.jobId).state).toBe("queued");
      expect((await attention(w)).some((entry) => entry.kind === "outcome-unknown")).toBe(false);
    } finally { w.brain.close(); }
  });

  it("an interrupted agent step shows as restarting, not running, and is not offered to a person", async () => {
    const w = setupWorld();
    const previous = process.env["BRAIN_PARKED_COOLDOWN_SECONDS"];
    process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] = "300";
    try {
      const offer = await authorFinished(w, "wd-restarting", "runner-unk3");
      const c = w.brain.store.control;
      for (let i = 0; i < 4; i++) c.prepare(`INSERT INTO job_attempts(id, job_id, runner_id, runner_epoch, attempt_no, lease_id, job_fence, state, offer_expires_at_ms, lease_expires_at_ms)
        VALUES (?,?,?,?,?,?,?,'failed',1,1)`).run(`att-r-${i}`, offer.jobId, "runner-unk3", 1, 100 + i, `lease-r-${i}`, 100 + i);
      c.prepare("UPDATE job_attempts SET lease_expires_at_ms=?, offer_expires_at_ms=? WHERE id=?").run(Date.now() - 10_000, Date.now() - 11_000, offer.attemptId);
      w.brain.jobProtocol.sweepStuckJobs(1);
      expect(job(w, offer.jobId).state).toBe("outcome_unknown");
      const view = (await w.brain.executeQuery(w.owner, { queryType: "job.get", resourceId: offer.jobId } as never)) as unknown as { snapshot: { restarting?: boolean; workflowState?: string } };
      expect(view.snapshot).toMatchObject({ restarting: true, workflowState: "running" });
      expect((await attention(w)).some((entry) => entry.kind === "outcome-unknown")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["BRAIN_PARKED_COOLDOWN_SECONDS"]; else process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] = previous;
      w.brain.close();
    }
  });

  it("a read step past the 20-attempt safety cap does not hold its reservation: one last try, then it fails and every reservation is released (row 54)", async () => {
    const w = setupWorld();
    const previous = process.env["BRAIN_PARKED_COOLDOWN_SECONDS"];
    process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] = "0";
    try {
      const offer = await authorFinished(w, "wd-cap", "runner-cap1");
      const c = w.brain.store.control;
      c.prepare("UPDATE jobs SET attempt_counter=20 WHERE id=?").run(offer.jobId);
      age(w, offer, 30);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBeGreaterThan(0);
      expect(job(w, offer.jobId)).toMatchObject({ state: "queued", queue_reason: "RESTARTED_AFTER_INTERRUPTION" });
      const runner = seedRunner(w, "runner-cap2");
      const again = w.brain.jobProtocol.claim(runner, "req-wd-cap") as unknown as Offer;
      w.brain.jobProtocol.ack(runner, again.attemptId, { leaseId: again.leaseId, jobFence: again.jobFence });
      w.brain.jobProtocol.complete(runner, again.attemptId, { result: "succeeded", output: { ok: true }, jobFence: again.jobFence, cleanupConfirmed: true });
      age(w, again, 30);
      expect(w.brain.jobProtocol.sweepStuckJobs(15 * MIN)).toBeGreaterThan(0);
      expect(job(w, offer.jobId).state).toBe("failed");
      const open = c.prepare("SELECT COUNT(*) AS n FROM capacity_reservations WHERE released_at_ms IS NULL").get() as { n: number };
      expect(open.n).toBe(0);
    } finally {
      if (previous === undefined) delete process.env["BRAIN_PARKED_COOLDOWN_SECONDS"]; else process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] = previous;
      w.brain.close();
    }
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
