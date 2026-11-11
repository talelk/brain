import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { fixtureGate } from "../../apps/runner/src/engines/fixture";
import { GovernorProtocolError } from "../../apps/runner/src/governor-client";
import { enrollAndHello, newRunnerControls, refreshSession, runClaimLoops, runOnce, type RunnerConfig } from "../../apps/runner/src/supervisor";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

// Backlog row 64: a runner of 3 slots runs 3 attempts at the same time. Reservations, the one-claim rule, per-attempt isolation,
// lease renewal, a session refresh while attempts run, and a runner restart mid-flight, all on the fixture engine with latency the test controls.
type App = Awaited<ReturnType<typeof createApp>>;
const savedSlots = process.env["BRAIN_RUNNER_SLOTS"];

interface Gate { entered: string[]; release: () => void; waiting: number }
function holdFirst(count: number): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const gate: Gate = { entered: [], waiting: 0, release: () => open() };
  fixtureGate.hold = async (attemptId) => {
    gate.entered.push(attemptId);
    if (gate.entered.length > count) return;
    gate.waiting += 1;
    await opened;
  };
  return gate;
}
async function until(done: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached in time"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

describe("a runner with 3 slots running 3 attempts at the same time (row 64)", () => {
  let root: string; let app: App; let world: ReturnType<typeof setupWorld>; let cfg: RunnerConfig; let session: { token: string; epoch: number; bootNonce: string };
  const s = () => world.brain.store;
  const dispatch = async (key: string) => (await world.brain.executeCommand(world.owner, {
    contractVersion: "brain.command/v1", commandType: "workflow.dispatch", commandId: `cmd-${key}`, idempotencyKey: key, workspaceId: world.workspaceId,
    payload: { workflow: { id: "agent-smoke", digest: world.brain.activeRelease(world.org)!.digest }, input: { message: "BRAIN_OK" } },
  }, `corr-${key}`)).receipt.resourceId!;
  const runner = () => s().control.prepare("SELECT slots_reserved AS slots, cpu_reserved AS cpu, memory_reserved AS memory, session_epoch AS epoch FROM runners WHERE id='runner-slots'").get() as { slots: number; cpu: number; memory: number; epoch: number };

  beforeEach(async () => {
    process.env["BRAIN_RUNNER_SLOTS"] = "3";
    root = mkdtempSync(join(tmpdir(), "brain-slots-"));
    app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    world = setupWorld(app.brain);
    const bundle = fixtureStarter();
    const { digest } = world.brain.stageRelease(world.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
    world.brain.activateRelease(world.owner, digest);
    const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-slots", stateDir: join(root, "runner"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
    const hello = await enrollAndHello(cfg, world.brain.jobProtocol.issueEnrollment(world.owner, "agents").token);
    session = { token: hello.sessionToken, epoch: hello.epoch, bootNonce: hello.bootNonce };
  });
  afterEach(async () => {
    delete fixtureGate.hold;
    if (savedSlots === undefined) delete process.env["BRAIN_RUNNER_SLOTS"]; else process.env["BRAIN_RUNNER_SLOTS"] = savedSlots;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reserves one slot per attempt, never hands one job out twice, isolates attempts, renews every lease and completes all three", async () => {
    const gate = holdFirst(3);
    const runs = [await dispatch("slots-1"), await dispatch("slots-2"), await dispatch("slots-3"), await dispatch("slots-4")];
    const controls = newRunnerControls();
    const claims = Array.from({ length: 3 }, () => runOnce(cfg, () => session.token, session.epoch, controls));
    await until(() => gate.waiting === 3);

    // Three distinct attempts run now, on three different jobs, with three reservations.
    const attempts = s().control.prepare("SELECT id, job_id, state, lease_expires_at_ms AS lease FROM job_attempts WHERE runner_id='runner-slots' ORDER BY id").all() as Array<{ id: string; job_id: string; state: string; lease: number }>;
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(3);
    expect(new Set(attempts.map((a) => a.job_id)).size).toBe(3);
    expect(attempts.every((a) => a.state === "running")).toBe(true);
    expect([...controls.activeAttemptIds].sort()).toEqual(attempts.map((a) => a.id).sort());
    expect(runner()).toMatchObject({ slots: 3, cpu: 1500, memory: 768 });
    expect((s().control.prepare("SELECT COUNT(*) AS n FROM capacity_reservations WHERE released_at_ms IS NULL").get() as { n: number }).n).toBe(3);
    // The fourth job waits: no slot is free, and asking again hands nothing out and reserves nothing more.
    expect(await runOnce(cfg, () => session.token, session.epoch, controls)).toBe(false);
    expect(runner().slots).toBe(3);
    expect((s().control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get() as { n: number }).n).toBe(1);

    // Per-attempt isolation: a spool file and an engine session for each attempt, none shared.
    const spools = readdirSync(join(cfg.stateDir, "spool")).sort();
    expect(spools).toEqual(attempts.map((a) => `${a.id}.jsonl`).sort());
    const sessions = world.brain.store.workspaceDb(world.workspaceId, world.org).prepare("SELECT attempt_id AS attemptId, COUNT(*) AS n FROM sessions WHERE attempt_id IS NOT NULL GROUP BY attempt_id").all() as Array<{ attemptId: string; n: number }>;
    expect(sessions.map((row) => row.attemptId).sort()).toEqual(attempts.map((a) => a.id).sort());
    expect(sessions.every((row) => row.n === 1)).toBe(true);

    // Lease renewal: every attempt's lease is pushed forward while it runs (renewals fire every 15 seconds).
    await until(() => (s().control.prepare("SELECT lease_expires_at_ms AS lease FROM job_attempts WHERE runner_id='runner-slots' ORDER BY id").all() as Array<{ lease: number }>).every((row, index) => row.lease > attempts[index]!.lease), 25_000);

    // A session refresh while all three run: same epoch, new token; the attempts finish with it and the fourth is claimed afterwards.
    const before = session.token;
    const next = await refreshSession(cfg, session.bootNonce);
    expect(next.epoch).toBe(session.epoch);
    expect(next.sessionToken).not.toBe(before);
    session.token = next.sessionToken;
    gate.release();
    expect(await Promise.all(claims)).toEqual([true, true, true]);
    expect(controls.activeAttemptIds.size).toBe(0);
    expect(runner()).toMatchObject({ slots: 0, cpu: 0, memory: 0 });
    expect((s().control.prepare("SELECT COUNT(*) AS n FROM capacity_reservations WHERE released_at_ms IS NULL").get() as { n: number }).n).toBe(0);
    expect(s().control.prepare("SELECT DISTINCT state FROM job_attempts WHERE runner_id='runner-slots'").all()).toEqual([{ state: "verifying" }]);
    expect(await runOnce(cfg, () => session.token, session.epoch, controls)).toBe(true);
    expect(runs).toHaveLength(4);
    for (const id of attempts.map((a) => a.id)) expect(existsSync(join(cfg.stateDir, "spool", `${id}.jsonl`))).toBe(false);
  }, 60_000);

  it("a refresh in the middle of a long attempt does not drop it, and a short attempt claimed after it finishes with the new token", async () => {
    const gate = holdFirst(2);
    await dispatch("long-1"); await dispatch("long-2"); await dispatch("short-3");
    const controls = newRunnerControls();
    const long = [runOnce(cfg, () => session.token, session.epoch, controls), runOnce(cfg, () => session.token, session.epoch, controls)];
    await until(() => gate.waiting === 2);
    const refreshed = await refreshSession(cfg, session.bootNonce);
    session.token = refreshed.sessionToken;
    // A third worker keeps claiming new work with the refreshed token while the two long attempts are still running.
    expect(await runOnce(cfg, () => session.token, session.epoch, controls)).toBe(true);
    expect(controls.activeAttemptIds.size).toBe(2);
    gate.release();
    expect(await Promise.all(long)).toEqual([true, true]);
    expect(s().control.prepare("SELECT state, COUNT(*) AS n FROM job_attempts WHERE runner_id='runner-slots' GROUP BY state").all()).toEqual([{ state: "verifying", n: 3 }]);
  }, 60_000);

  it("a runner restarted mid-flight is a new epoch: the old attempts are fenced, their reservations are freed when the leases lapse, and the new process claims again", async () => {
    const gate = holdFirst(3);
    await dispatch("restart-1"); await dispatch("restart-2"); await dispatch("restart-3"); await dispatch("restart-4");
    const controls = newRunnerControls();
    const old = Array.from({ length: 3 }, () => runOnce(cfg, () => session.token, session.epoch, controls).then(() => "finished", (error: unknown) => error));
    await until(() => gate.waiting === 3);
    expect(runner().slots).toBe(3);

    // The process dies and a new one starts: a new boot nonce, so a new epoch, while the old attempts are still on the books.
    const restarted = await enrollAndHello(cfg, "unused-already-enrolled");
    expect(restarted.epoch).toBe(session.epoch + 1);
    expect(restarted.bootNonce).not.toBe(session.bootNonce);
    // The old process, if it wakes up, is fenced: it cannot complete or renew, and it cannot claim.
    gate.release();
    const outcomes = await Promise.all(old);
    for (const outcome of outcomes) expect(outcome === "finished" || outcome instanceof GovernorProtocolError || outcome instanceof Error).toBe(true);
    expect(s().control.prepare("SELECT DISTINCT state FROM job_attempts WHERE runner_id='runner-slots'").all()).not.toContainEqual({ state: "succeeded" });
    expect(world.brain.store.workspaceDb(world.workspaceId, world.org).prepare("SELECT state FROM workflow_runs WHERE state='succeeded'").all()).toEqual([]);

    // The leases lapse (nothing renews them now): the Governor marks the attempts unknown and frees the runner's reservations.
    s().control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE runner_id='runner-slots' AND state='running'").run(s().now() - 1);
    expect(world.brain.jobProtocol.expireLeases()).toBeGreaterThanOrEqual(3);
    world.brain.jobProtocol.sweepStuckJobs(0);
    expect(runner().slots).toBe(0);
    expect(runner().cpu).toBe(0);

    // The new process has all three slots again and can fill them.
    fixtureGate.hold = undefined as never;
    delete fixtureGate.hold;
    const fresh = newRunnerControls();
    let claimed = 0;
    for (let i = 0; i < 4; i++) if (await runOnce(cfg, () => restarted.sessionToken, restarted.epoch, fresh)) claimed += 1;
    expect(claimed).toBeGreaterThanOrEqual(1);
    expect(runner().epoch).toBe(restarted.epoch);
  }, 60_000);
});

describe("the claim loops across a session refresh (row 64)", () => {
  it("refreshes while slots are busy with long attempts, and an idle slot keeps claiming with the new token meanwhile", async () => {
    const session = { token: "t0", sinceMs: Date.now(), stale: false };
    let refreshes = 0;
    let longRunning = 0; let shortClaims = 0;
    const seenTokens: string[] = [];
    let finishLong!: () => void;
    const longDone = new Promise<void>((resolve) => { finishLong = resolve; });
    let stop = false;
    const loops = runClaimLoops({
      slots: 3, session, refreshAfterMs: 60, idleMs: 10, errorMs: 10,
      configurationChanged: () => stop,
      refresh: async () => { refreshes += 1; session.token = `t${refreshes}`; session.sinceMs = Date.now(); session.stale = false; },
      claimOnce: async () => {
        // The first two claims are long attempts that hold their slot; later claims are short and carry the token current at the time.
        if (longRunning < 2) { longRunning += 1; await longDone; return true; }
        shortClaims += 1; seenTokens.push(session.token);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return true;
      },
    });
    await until(() => refreshes >= 2 && shortClaims >= 20, 5000);
    // Two slots are still inside their long attempts and the refreshes happened anyway, with the third slot never waiting for them.
    expect(longRunning).toBe(2);
    expect(new Set(seenTokens).size).toBeGreaterThan(1);
    stop = true;
    finishLong();
    await loops;
  });

  it("refreshes on a timer when every slot is busy", async () => {
    const session = { token: "t0", sinceMs: Date.now(), stale: false };
    let refreshes = 0; let stop = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const loops = runClaimLoops({
      slots: 2, session, refreshAfterMs: 40, idleMs: 10, errorMs: 10, configurationChanged: () => stop,
      refresh: async () => { refreshes += 1; session.sinceMs = Date.now(); },
      claimOnce: async () => { await held; return true; },
    });
    await until(() => refreshes >= 2, 3000);
    stop = true; release();
    await loops;
  });

  it("a 401 marks the session stale and the next pass refreshes it", async () => {
    const session = { token: "t0", sinceMs: Date.now(), stale: false };
    let refreshes = 0; let calls = 0; let stop = false;
    const loops = runClaimLoops({
      slots: 1, session, idleMs: 10, errorMs: 10, configurationChanged: () => stop,
      refresh: async () => { refreshes += 1; session.stale = false; session.sinceMs = Date.now(); },
      claimOnce: async () => { calls += 1; if (calls === 1) throw new Error("claim failed 401: stale"); return false; },
    });
    await until(() => refreshes === 1 && calls >= 2, 3000);
    stop = true;
    await loops;
  });
});
