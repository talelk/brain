import { afterEach, describe, expect, it } from "vitest";
import { renderMetrics } from "../../apps/governor/src/modules/operations/index";
import { DIGEST_A, setupWorld, type TestWorld } from "../helpers";

// A second runner host (Phase 4): two hosts serve one runner group, each slot is used once, work spreads, a lost host's work moves to the
// other, and groups and administrative state still decide who may take what.
type Offer = { attemptId: string; jobId: string; leaseId: string; jobFence: number };
type Seed = { runnerId: string; epoch: number; organizationId: string };
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const CAPS = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"];
function seedRunner(w: TestWorld, id: string, host: string, opts: { group?: string; slots?: number; adminState?: string } = {}): Seed {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, ?, 'k', ?, 'healthy', ?, 1, ?, 4000, 8192, 20480, ?)`).run(id, w.org, opts.group ?? "fixture-tools", opts.adminState ?? "enabled", DIGEST_A, s.now(), opts.slots ?? 1);
  // The host a runner lives on is one of its verified capabilities, as the runner's own configuration declares it.
  for (const cap of [...CAPS, `host:${host}`]) s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3600_000);
  return { runnerId: id, epoch: 1, organizationId: w.org };
}
async function dispatch(w: TestWorld, key: string): Promise<void> {
  const digest = w.brain.activeRelease(w.org)!.digest;
  await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: key, payload: { workflow: { id: "fixture-workflow", digest } , input: { message: key } } }, key);
}
const claim = (w: TestWorld, runner: Seed, request: string) => w.brain.jobProtocol.claim(runner, request) as Offer | null;
const healthLine = async (w: TestWorld) => ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { services: Array<{ id: string; detail: string }> } }).snapshot.services.find((service) => service.id === "runners");

describe("two runner hosts serving one group", () => {
  it("spreads queued work over both hosts, uses each slot once and leaves the rest queued", async () => {
    world = setupWorld();
    const w = world;
    for (const key of ["a", "b", "c"]) await dispatch(w, `spread-${key}`);
    const hostA = seedRunner(w, "runner-fixture-a", "alpha");
    const hostB = seedRunner(w, "runner-fixture-b", "beta");
    const first = claim(w, hostA, "a-1");
    const second = claim(w, hostB, "b-1");
    expect(first && second).toBeTruthy();
    expect(first!.jobId).not.toBe(second!.jobId);
    // Each host has one slot: neither is offered another job while its slot is taken, and the third job waits.
    expect(claim(w, hostA, "a-2")).toBeNull();
    expect(claim(w, hostB, "b-2")).toBeNull();
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get()).toEqual({ n: 1 });
    // Health and metrics tell the same story: two online runners, both slots used, one job queued.
    expect((await healthLine(w))!.detail).toBe("2 of 2 slots in use on 2 online runners");
    const metrics = renderMetrics(w.brain.store);
    expect(metrics).toContain("brain_runners_online 2");
    expect(metrics).toContain('brain_runner_slots{state="used"} 2');
    expect(metrics).toContain("brain_queue_depth 1");
    expect(metrics).toMatch(/^brain_queue_oldest_age_seconds \d+$/mu);
  });

  it("moves a lost host's work to the other host with a newer fence, and the lost host cannot take it back while it is gone", async () => {
    world = setupWorld();
    const w = world;
    await dispatch(w, "lose-host");
    const hostA = seedRunner(w, "runner-fixture-a", "alpha");
    const hostB = seedRunner(w, "runner-fixture-b", "beta");
    const onB = claim(w, hostB, "b-1")!;
    expect(onB).toBeTruthy();
    expect(claim(w, hostA, "a-1")).toBeNull();
    // Host B goes dark: its lease runs out and its heartbeat stops. The sweep re-offers the job.
    w.brain.store.control.prepare("UPDATE job_attempts SET offer_expires_at_ms=0, lease_expires_at_ms=0 WHERE id=?").run(onB.attemptId);
    w.brain.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='runner-fixture-b'").run(Date.now() - 120_000);
    expect(w.brain.jobProtocol.expireLeases()).toBeGreaterThanOrEqual(1);
    const moved = claim(w, hostA, "a-2")!;
    expect(moved).toBeTruthy();
    expect(moved.jobId).toBe(onB.jobId);
    expect(moved.jobFence).toBeGreaterThan(onB.jobFence);
    expect(moved.attemptId).not.toBe(onB.attemptId);
    // Health counts only the host that is still online.
    expect((await healthLine(w))!.detail).toBe("1 of 1 slots in use on 1 online runner");
    expect(renderMetrics(w.brain.store)).toContain("brain_runners_online 1");
  });

  it("gives work only to hosts of the right group that are enabled: another group, a draining host and a disabled host get nothing", async () => {
    world = setupWorld();
    const w = world;
    await dispatch(w, "right-group");
    const otherGroup = seedRunner(w, "runner-other-c", "gamma", { group: "some-other-group" });
    const draining = seedRunner(w, "runner-fixture-d", "delta", { adminState: "draining" });
    const disabled = seedRunner(w, "runner-fixture-e", "epsilon", { adminState: "disabled" });
    for (const [index, runner] of [otherGroup, draining, disabled].entries()) expect(claim(w, runner, `x-${index}`), runner.runnerId).toBeNull();
    // A healthy enabled host of the group takes it at once.
    const good = seedRunner(w, "runner-fixture-f", "zeta", { slots: 2 });
    expect(claim(w, good, "good-1")).toBeTruthy();
    // Draining is how a host is taken out for maintenance: it finishes what it holds and is offered nothing new.
    await dispatch(w, "after-drain");
    w.brain.store.control.prepare("UPDATE runners SET admin_state='draining' WHERE id='runner-fixture-f'").run();
    expect(claim(w, good, "good-2")).toBeNull();
  });
});
