import { describe, expect, it } from "vitest";
import { JobProtocol, type JobProtocolPorts } from "../../apps/governor/src/modules/jobs/index";
import { BrainDomainError } from "../../apps/governor/src/domain/errors";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// Module-level tests: the JobProtocol interface is exercised against a fixture
// Store with scripted fake ports — the real port wiring lives in the full-stack
// (HTTP/chaos) suites, so the seam here is proven by fakes recording calls.

type Offer = { attemptId: string; jobId: string; leaseId: string; jobFence: number };

function seedRunner(w: TestWorld, id: string): { runnerId: string; epoch: number; organizationId: string } {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(id, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3_600_000);
  }
  return { runnerId: id, epoch: 1, organizationId: w.org };
}

async function dispatch(w: TestWorld, key: string): Promise<void> {
  const digest = w.brain.activeRelease(w.org)!.digest;
  await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch",
    workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: key } },
  }, key);
}

function recorder() {
  const calls: Array<{ port: string; args: unknown[] }> = [];
  const ports: JobProtocolPorts = {
    completeStep: (...args) => { calls.push({ port: "completeStep", args }); },
    evaluatorEligible: (runnerId, jobId) => { calls.push({ port: "evaluatorEligible", args: [runnerId, jobId] }); return true; },
    runnerCurrent: (organizationId, runnerId) => { calls.push({ port: "runnerCurrent", args: [organizationId, runnerId] }); return true; },
    activeRelease: () => undefined,
    resolveWorkflow: () => ({ workflow: {}, configDigest: `sha256:${"0".repeat(64)}` }),
    startRun: () => ({ runId: "unused" }),
  };
  return { ports, calls };
}

describe("JobProtocol interface (modules/jobs)", () => {
  it("claim reaches the host only through its ports", async () => {
    const w = setupWorld();
    try {
      await dispatch(w, "proto-claim");
      const runner = seedRunner(w, "runner-proto");
      const { ports, calls } = recorder();
      const protocol = new JobProtocol(w.brain.store, ports);

      const offer = protocol.claim(runner, "req-proto-1") as Offer | null;
      expect(offer).toBeTruthy();
      // The eligibility seam was exercised, with the identity's organization.
      expect(calls.some((c) => c.port === "runnerCurrent" && c.args[0] === w.org && c.args[1] === "runner-proto")).toBe(true);
      expect(calls.some((c) => c.port === "evaluatorEligible" && c.args[0] === "runner-proto")).toBe(true);

      // A replayed request id returns the original offer without new effects.
      const replay = protocol.claim(runner, "req-proto-1") as Offer | null;
      expect(replay?.attemptId).toBe(offer!.attemptId);
      expect(replay?.leaseId).toBe(offer!.leaseId);
    } finally {
      w.brain.close();
    }
  });

  it("a false runnerCurrent port stops the claim with no offer", async () => {
    const w = setupWorld();
    try {
      await dispatch(w, "proto-stale");
      const runner = seedRunner(w, "runner-stale");
      const { ports } = recorder();
      ports.runnerCurrent = () => false;
      const protocol = new JobProtocol(w.brain.store, ports);
      expect(protocol.claim(runner, "req-stale-1")).toBeNull();
    } finally {
      w.brain.close();
    }
  });

  it("a false evaluatorEligible port withholds the offer", async () => {
    const w = setupWorld();
    try {
      await dispatch(w, "proto-eval");
      const runner = seedRunner(w, "runner-eval");
      const { ports } = recorder();
      ports.evaluatorEligible = () => false;
      const protocol = new JobProtocol(w.brain.store, ports);
      expect(protocol.claim(runner, "req-eval-1")).toBeNull();
    } finally {
      w.brain.close();
    }
  });

  it("complete routes the failed outcome to the completeStep port exactly once per receipt", async () => {
    const w = setupWorld();
    try {
      await dispatch(w, "proto-complete");
      const runner = seedRunner(w, "runner-complete");
      const { ports, calls } = recorder();
      const protocol = new JobProtocol(w.brain.store, ports);

      const offer = protocol.claim(runner, "req-complete-1") as Offer;
      protocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
      const receipt = { result: "failed", jobFence: offer.jobFence, cleanupConfirmed: true, output: { error: "boom" } };
      const outcome = protocol.complete(runner, offer.attemptId, receipt) as { jobState: string };
      expect(outcome.jobState).toBe("failed");

      const completions = calls.filter((c) => c.port === "completeStep");
      expect(completions).toHaveLength(1);
      expect(completions[0]!.args[0]).toBe(w.org);
      expect(completions[0]!.args[1]).toBe(w.workspaceId);
      expect(completions[0]!.args[5]).toBe(false); // ok=false for a failed outcome
      expect((completions[0]!.args[4] as { error: string }).error).toBe("boom");

      // Capacity released by the cleanup-bound completion.
      const reserved = w.brain.store.control.prepare("SELECT slots_reserved FROM runners WHERE id='runner-complete'").get() as { slots_reserved: number };
      expect(reserved.slots_reserved).toBe(0);
    } finally {
      w.brain.close();
    }
  });

  it("expiry sweeps through the interface and frees the reservation", async () => {
    const w = setupWorld();
    try {
      await dispatch(w, "proto-expire");
      const runner = seedRunner(w, "runner-expire");
      const { ports } = recorder();
      const protocol = new JobProtocol(w.brain.store, ports);
      const offer = protocol.claim(runner, "req-expire-1") as Offer;
      expect((w.brain.store.control.prepare("SELECT slots_reserved FROM runners WHERE id='runner-expire'").get() as { slots_reserved: number }).slots_reserved).toBe(1);
      w.brain.store.control.prepare("UPDATE job_attempts SET offer_expires_at_ms=0, lease_expires_at_ms=0 WHERE id=?").run(offer.attemptId);
      expect(protocol.expireLeases()).toBeGreaterThanOrEqual(1);
      expect((w.brain.store.control.prepare("SELECT slots_reserved FROM runners WHERE id='runner-expire'").get() as { slots_reserved: number }).slots_reserved).toBe(0);
    } finally {
      w.brain.close();
    }
  });

  it("dispatch loops run through the interface without declared documents", () => {
    const w = setupWorld();
    try {
      const { ports } = recorder();
      const protocol = new JobProtocol(w.brain.store, ports);
      expect(protocol.dispatchSchedules()).toEqual({ dispatched: 0, skipped: 0 });
      expect(protocol.dispatchAutomations()).toEqual({ dispatched: 0, skipped: 0 });
    } finally {
      w.brain.close();
    }
  });

  it("authenticate refuses browser sessions at the interface boundary", () => {
    const w = setupWorld();
    try {
      const { ports } = recorder();
      const protocol = new JobProtocol(w.brain.store, ports);
      expect(() => protocol.authenticate(new Headers({ cookie: "session=abc" }))).toThrowError(BrainDomainError);
      expect(() => protocol.authenticate(new Headers())).toThrowError(/runner session required/);
    } finally {
      w.brain.close();
    }
  });
});
