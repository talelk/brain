import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// T17 packet acceptance: atomic offer/capacity/job-fence with duplicate-safe
// claim ACKs. Exactly one runner ever holds a job; a replayed claim returns
// the original offer; capacity is a hard bound; fences only move forward.
type Offer = { attemptId: string; jobId: string; leaseId: string; jobFence: number };

function seedRunner(w: TestWorld, id: string, slots = 1): { runnerId: string; epoch: number; organizationId: string } {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, ?)`).run(id, w.org, DIGEST_A, s.now(), slots);
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId: id, epoch: 1, organizationId: w.org };
}

function dispatch(w: TestWorld, key: string): void {
  const digest = w.brain.activeRelease(w.org)!.digest;
  w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch",
    workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: key } },
  }, key);
}

describe("atomic claim, capacity and fences (T17)", () => {
  it("exactly one of two racing runners wins; replayed request returns the same offer", () => {
    const w = setupWorld();
    dispatch(w, "claim-race");
    const r1 = seedRunner(w, "runner-a");
    const r2 = seedRunner(w, "runner-b");
    const o1 = w.brain.claim(r1, "req-1") as Offer | null;
    const o2 = w.brain.claim(r2, "req-2") as Offer | null;
    expect([o1, o2].filter(Boolean)).toHaveLength(1);
    const winner = o1 ?? o2;
    const winnerRunner = o1 ? r1 : r2;
    const replay = w.brain.claim(winnerRunner, o1 ? "req-1" : "req-2") as Offer | null;
    expect(replay?.attemptId).toBe(winner!.attemptId);
    expect(replay?.leaseId).toBe(winner!.leaseId);
    // A fresh request from the loser still gets nothing while the lease lives.
    expect(w.brain.claim(o1 ? r2 : r1, "req-3")).toBeNull();
    w.brain.close();
  });

  it("slot capacity is hard: a second job is not offered until capacity frees", () => {
    const w = setupWorld();
    dispatch(w, "claim-cap-1");
    dispatch(w, "claim-cap-2");
    const r = seedRunner(w, "runner-cap", 1);
    const first = w.brain.claim(r, "req-cap-1") as Offer | null;
    expect(first).toBeTruthy();
    expect(w.brain.claim(r, "req-cap-2")).toBeNull();
    w.brain.close();
  });

  it("lease expiry re-offers the job with a strictly greater fence", () => {
    const w = setupWorld();
    dispatch(w, "claim-fence");
    const r = seedRunner(w, "runner-fence");
    const first = w.brain.claim(r, "req-fence-1") as Offer | null;
    expect(first).toBeTruthy();
    // Force the offer deadline into the past, then run the expiry sweep.
    w.brain.store.control.prepare("UPDATE job_attempts SET offer_expires_at_ms=0, lease_expires_at_ms=0 WHERE id=?").run(first!.attemptId);
    expect(w.brain.expireLeases()).toBeGreaterThanOrEqual(1);
    const second = w.brain.claim(r, "req-fence-2") as Offer | null;
    expect(second).toBeTruthy();
    expect(second!.jobId).toBe(first!.jobId);
    expect(second!.jobFence).toBeGreaterThan(first!.jobFence);
    expect(second!.attemptId).not.toBe(first!.attemptId);
    w.brain.close();
  });
});
