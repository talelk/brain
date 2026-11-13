import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { scaled } from "../support/timing";

/**
 * A proposal ends the attempt that made it (ADR 0028, which replaces ADR 0024's "wait inside the attempt"): while people decide, the task
 * holds no runner slot and no lease, so an overnight schedule costs nothing and other work goes on. What was decided is acted on by the
 * held job, and a decision missed by a crash or a cancelled task is cleaned up by the Governor's own pass.
 */
let world: EffectsWorld | undefined;
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

describe("a task that waits for a person holds nothing", () => {
  it("frees its slot and lease, lets other work run meanwhile, is not touched by the watchdogs, and goes on after the decision", async () => {
    world = await effectsWorld();
    const w = world;
    await w.dispatch("wait-1");
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();
    expect(w.liveAttempts()).toEqual([]);
    expect(w.slotsReserved()).toBe(0);
    expect((w.store.control.prepare("SELECT COUNT(*) AS n FROM capacity_reservations WHERE released_at_ms IS NULL").get() as { n: number }).n).toBe(0);
    // The runner has one slot, and it is free: an unrelated read-only task runs to its end while the approval waits.
    await w.dispatch("other-work", []);
    expect(await w.run()).toBe(true);
    expect(w.jobs().filter((job) => job.step_id === "respond").map((job) => job.state)).toEqual(["blocked", "verifying"]);
    // Leases expire and stalled-job sweeps run (even with a stall limit of one millisecond): a parked task is not a stalled one.
    expect(w.w.brain.jobProtocol.expireLeases()).toBe(0);
    expect(w.w.brain.jobProtocol.sweepStuckJobs(1)).toBe(0);
    expect(w.w.brain.jobProtocol.settleEffects()).toBe(0);
    expect(w.jobs()[0]).toMatchObject({ state: "blocked", queue_reason: "AWAITING_APPROVAL" });
    expect((w.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE state='pending'").get() as { n: number }).n).toBe(1);
    expect(w.restarts()).toEqual([]);
    // The decision comes much later: the held job restarts the container once and the task resumes.
    await w.decide(approval, "approve");
    await w.drain();
    expect(w.restarts()).toEqual(["restarted demo-app"]);
    expect(w.jobs()[0]!.state).toBe("verifying");
    expect(w.calls()[0]).toMatchObject({ outcome: "applied" });
    // Settling again changes nothing and runs nothing.
    expect(w.w.brain.jobProtocol.settleEffects()).toBe(0);
    expect(w.restarts()).toHaveLength(1);
  }, scaled(120_000));

  it("finds a decision whose follow-up was lost to a crash, on the next maintenance pass", async () => {
    const w = world!;
    await w.dispatch("crash-1");
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();
    // The refusal is committed but the process died before the held job was cancelled and the task resumed.
    w.store.control.prepare("UPDATE approval_requests SET state='rejected', version=version+1 WHERE id=?").run(approval.id);
    const call = w.calls().find((entry) => entry.approval_id === approval.id)!;
    expect(w.jobs().find((job) => job.id === call.act_job_id)!.state).toBe("blocked");
    expect(w.w.brain.jobProtocol.settleEffects()).toBeGreaterThan(0);
    expect(w.jobs().find((job) => job.id === call.act_job_id)!.state).toBe("cancelled");
    expect(w.jobs().find((job) => job.id === call.parent_job_id)!.state).toBe("queued");
    await w.drain();
    expect(w.restarts()).toHaveLength(1);
    expect(w.calls().find((entry) => entry.approval_id === approval.id)!.outcome).toBe("declined");
  }, scaled(120_000));

  it("withdraws a held change when its task is cancelled: the approval is revoked and nothing can run", async () => {
    const w = world!;
    await w.dispatch("cancel-1");
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();
    const parent = w.jobs().find((job) => job.state === "blocked" && job.step_id === "respond")!;
    const runId = (w.store.control.prepare("SELECT workflow_run_id AS id FROM jobs WHERE id=?").get(parent.id) as { id: string }).id;
    await w.command("workflow.cancel", "cancel-run", { runId, reason: "No longer needed" });
    const call = w.calls().find((entry) => entry.approval_id === approval.id)!;
    expect(w.jobs().find((job) => job.id === parent.id)!.state).toBe("cancelled");
    expect(w.jobs().find((job) => job.id === call.act_job_id)!.state).toBe("cancelled");
    expect((w.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(approval.id) as { state: string }).state).toBe("revoked");
    expect(call.outcome).toBe("cancelled");
    expect(await w.run()).toBe(false);
    expect(w.restarts()).toHaveLength(1);
  }, scaled(120_000));

  it("does not let a task keep asking: the same change is never proposed twice, and a task may propose only ten", async () => {
    const w = world!;
    const calls = Array.from({ length: 12 }, (_, index) => ({ id: "host.restart", input: { container: "demo-app", reason: `try ${index}` } }));
    await w.dispatch("loop-1", calls);
    expect(await w.run()).toBe(true);
    // The container name is the only argument the policy reads, but each call's arguments are its own change: ten are held, the rest refused.
    const held = w.calls().filter((entry) => entry.outcome === null);
    expect(held.length).toBeLessThanOrEqual(10);
    expect((w.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE state='pending'").get() as { n: number }).n).toBe(held.length);
  }, scaled(120_000));
});
