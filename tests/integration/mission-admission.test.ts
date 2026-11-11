import { describe, expect, it } from "vitest";
import type { CommandReceipt, Mission, PlanTask } from "@brain/contracts";
import { setupWorld, DIGEST_A, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;
type Offer = { jobId: string; attemptId: string };

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [] });

/** A mission with confirmed work items linked to runs run-<key>-<task>, and a queued job per run. */
async function missionWithJobs(w: World, key: string, budget: Record<string, number>, tasks: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const id = (await run(w, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], budget, ...extra })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: tasks.map(task) })).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  for (const item of (await workView(w)).items.filter((entry) => entry.missionId === id)) {
    w.brain.missions.linkExecution(w.owner, w.workspaceId, item.workItemId, `run-${key}-${item.planTaskId}`);
    insertJob(w, `job-${key}-${item.planTaskId}`, `run-${key}-${item.planTaskId}`);
  }
  return id;
}

function insertJob(w: World, id: string, runId: string, createdOffsetMs = 0): void {
  const s = w.brain.store;
  const placement = { group: "fixture-tools", all: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], isolation: "ephemeral-container", resources: { cpuMillicores: 500, memoryMb: 256, diskMb: 256, slots: 1 } };
  const now = s.now() + createdOffsetMs;
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, priority, created_at_ms, ready_at_ms, deadline_ms)
    VALUES (?,?,?,?,?, 'echo', 'queued', ?, ?, ?, 'read', 'WAITING_FOR_RUNNER', 0, ?, ?, ?)`)
    .run(id, w.org, w.workspaceId, `key-${id}`, runId, w.brain.activeRelease(w.org)!.digest, JSON.stringify(placement), DIGEST_A, now, now, now + 3600000);
  s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(id, "dispatch", "{}");
}

function seedRunner(w: World, runnerId: string, slots = 4) {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 16000, 32768, 40960, ?)`).run(runnerId, w.org, DIGEST_A, s.now(), slots);
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(runnerId, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}

/** The runner reports usage and the attempt releases its capacity, as at the end of a real attempt. */
function finishAttempt(w: World, attemptId: string, microUsd: number, tokens?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): void {
  w.brain.store.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(attemptId, 1, JSON.stringify({ kind: "engine", payload: { kind: "usage", payload: { microUsd, accounting: "final-total", ...tokens } } }));
  w.brain.jobProtocol.releaseReservation(attemptId);
}
function reportUsage(w: World, attemptId: string, seq: number, payload: Record<string, unknown>): void {
  w.brain.store.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(attemptId, seq, JSON.stringify({ kind: "engine", payload: { kind: "usage", payload } }));
}
const usageOf = async (w: World, queryType: string, resourceId?: string) => ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: { usage: Record<string, unknown>; attemptRows?: Array<Record<string, unknown>>; spendCap?: Record<string, number> } }).snapshot;
const queueReason = (w: World, jobId: string) => (w.brain.store.control.prepare("SELECT queue_reason FROM jobs WHERE id=?").get(jobId) as { queue_reason: string | null }).queue_reason;

describe("mission admission (T19)", () => {
  it("queues attempts that do not fit the budget and auto-pauses only when nothing fits and nothing runs (E111)", async () => {
    const w = setupWorld();
    const id = await missionWithJobs(w, "b", { maxMicroUsd: 100, memberCap: 3, attemptReserveMicroUsd: 60 }, ["a", "b"]);
    const runner = seedRunner(w, "runner-budget");
    const first = w.brain.jobProtocol.claim(runner, "req-b-1") as unknown as Offer;
    expect(first.jobId).toBe("job-b-a");
    expect(w.brain.jobProtocol.claim(runner, "req-b-2")).toBeNull();
    expect(queueReason(w, "job-b-b")).toBe("waiting: budget");
    expect((await mission(w, id)).state).toBe("active");
    finishAttempt(w, first.attemptId, 70);
    expect(w.brain.jobProtocol.claim(runner, "req-b-3")).toBeNull();
    const paused = await mission(w, id);
    expect(paused).toMatchObject({ state: "paused", pauseReason: "budget", usage: { settledMicroUsd: 70, reservedMicroUsd: 0, runningMembers: 0 } });
    await expect(Promise.resolve().then(async () => await run(w, "mission.resume", "b-resume-early", { missionId: id }, paused.version))).rejects.toThrow(/raise the limit that was reached/);
    await run(w, "mission.budget.set", "b-raise", { missionId: id, budget: { maxMicroUsd: 500, memberCap: 3, attemptReserveMicroUsd: 60 } }, paused.version);
    await run(w, "mission.resume", "b-resume", { missionId: id }, (await mission(w, id)).version);
    expect((w.brain.jobProtocol.claim(runner, "req-b-4") as unknown as Offer).jobId).toBe("job-b-b");
    w.brain.close();
  });

  it("applies the member cap before runner capacity and serves interactive work first, then missions in turn (E112)", async () => {
    const w = setupWorld();
    await missionWithJobs(w, "x", { memberCap: 1 }, ["a", "b"]);
    await missionWithJobs(w, "y", { memberCap: 2 }, ["a"]);
    insertJob(w, "job-interactive", "run-interactive", 60_000);
    const runner = seedRunner(w, "runner-fair", 8);
    const order = [1, 2, 3, 4].map((n) => (w.brain.jobProtocol.claim(runner, `req-fair-${n}`) as unknown as Offer | null)?.jobId ?? null);
    expect(order[0]).toBe("job-interactive");
    expect(order.slice(1, 3).sort()).toEqual(["job-x-a", "job-y-a"]);
    expect(order[3]).toBeNull();
    expect(queueReason(w, "job-x-b")).toBe("waiting: member cap");
    w.brain.close();
  });

  /** Makes an attempt look like it has been running for `minutes`: its ledger row starts that long ago and its lease covers the span. */
  const backdate = (w: World, attemptId: string, minutes: number): void => {
    const now = w.brain.store.now();
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE mission_spend SET created_at_ms=? WHERE attempt_id=?").run(now - minutes * 60_000, attemptId);
    w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(now + 3_600_000, attemptId);
  };
  const attention = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "attention.list", workspaceId: w.workspaceId } as never)) as unknown as { snapshot: { items: Array<{ kind: string; limits?: string[]; title: string }> } }).snapshot.items;

  it("working time counts only attempts, once for parallel ones; exhausting it pauses naming the time limit (ADR 0016)", async () => {
    const w = setupWorld();
    const id = await missionWithJobs(w, "c", { maxWallClockMs: 30 * 60_000, memberCap: 2 }, ["a", "b", "c"], { autonomy: "supervised" });
    const runner = seedRunner(w, "runner-clock", 4);
    // The mission has existed for a while with nobody working on it (planning, waiting for Confirm): no working time.
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE missions SET created_at_ms=? WHERE id=?").run(w.brain.store.now() - 3 * 3_600_000, id);
    expect((await mission(w, id)).usage.activeMs).toBe(0);
    const first = w.brain.jobProtocol.claim(runner, "req-c-1") as unknown as Offer;
    const second = w.brain.jobProtocol.claim(runner, "req-c-2") as unknown as Offer;
    backdate(w, first.attemptId, 20); backdate(w, second.attemptId, 20);
    const running = (await mission(w, id)).usage.activeMs;
    expect(running).toBeGreaterThanOrEqual(20 * 60_000); expect(running).toBeLessThan(21 * 60_000); // parallel attempts overlap: not 40 minutes
    finishAttempt(w, first.attemptId, 0); finishAttempt(w, second.attemptId, 0);
    const stopped = (await mission(w, id)).usage.activeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await mission(w, id)).usage.activeMs).toBe(stopped); // the clock stops with the attempts
    backdate(w, first.attemptId, 40);
    expect((await mission(w, id)).usage.activeMs).toBeGreaterThan(30 * 60_000);
    expect(w.brain.jobProtocol.claim(runner, "req-c-3")).toBeNull();
    expect(queueReason(w, "job-c-c")).toBe("waiting: budget");
    expect(await mission(w, id)).toMatchObject({ state: "paused", pauseReason: "budget" });
    expect((await attention(w)).find((item) => item.kind === "budget-pause")).toMatchObject({ limits: ["time"], title: expect.stringContaining("time limit") });
    const paused = await mission(w, id);
    await expect(Promise.resolve().then(async () => await run(w, "mission.resume", "c-resume-early", { missionId: id }, paused.version))).rejects.toThrow(/raise the limit/);
    await run(w, "mission.budget.set", "c-raise", { missionId: id, budget: { ...paused.budget, maxWallClockMs: 2 * 3_600_000 } }, paused.version);
    await run(w, "mission.resume", "c-resume", { missionId: id }, (await mission(w, id)).version);
    expect((w.brain.jobProtocol.claim(runner, "req-c-4") as unknown as Offer).jobId).toBe("job-c-c");
    w.brain.close();
  });

  it("a restart does not bill the downtime: an attempt in flight ends at its lease (ADR 0016)", async () => {
    const w = setupWorld();
    const id = await missionWithJobs(w, "r", { maxWallClockMs: 3_600_000, memberCap: 1 }, ["a"]);
    const attempt = w.brain.jobProtocol.claim(seedRunner(w, "runner-restart"), "req-r-1") as unknown as Offer;
    const now = w.brain.store.now();
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE mission_spend SET created_at_ms=? WHERE attempt_id=?").run(now - 5 * 3_600_000, attempt.attemptId);
    w.brain.store.control.prepare("UPDATE job_attempts SET lease_expires_at_ms=? WHERE id=?").run(now - 5 * 3_600_000 + 10 * 60_000, attempt.attemptId);
    // The Governor was down for hours; recovery releases the attempt late.
    w.brain.jobProtocol.releaseReservation(attempt.attemptId);
    expect((await mission(w, id)).usage.activeMs).toBe(10 * 60_000);
    w.brain.close();
  });

  it("on a one-person install with standard autonomy, a time-only pause is extended once by half, with a note", async () => {
    const w = setupWorld();
    const id = await missionWithJobs(w, "x1", { maxWallClockMs: 30 * 60_000, memberCap: 1 }, ["a", "b", "c"]);
    const runner = seedRunner(w, "runner-extend", 4);
    const first = w.brain.jobProtocol.claim(runner, "req-x1-1") as unknown as Offer;
    backdate(w, first.attemptId, 40);
    finishAttempt(w, first.attemptId, 0);
    const next = w.brain.jobProtocol.claim(runner, "req-x1-2") as unknown as Offer;
    expect(next.jobId).toBe("job-x1-b"); // admitted: the limit grew instead of pausing
    expect(await mission(w, id)).toMatchObject({ state: "active", timeExtendedByBrain: true, budget: { maxWallClockMs: 45 * 60_000 } });
    backdate(w, next.attemptId, 120);
    finishAttempt(w, next.attemptId, 0);
    expect(w.brain.jobProtocol.claim(runner, "req-x1-3")).toBeNull(); // only once
    expect(await mission(w, id)).toMatchObject({ state: "paused", pauseReason: "budget", timeExtendedByBrain: true });
    w.brain.close();
  });

  it("does not extend time when money ran out too", async () => {
    const w = setupWorld();
    const both = await missionWithJobs(w, "x2", { maxWallClockMs: 30 * 60_000, maxMicroUsd: 100, memberCap: 1, attemptReserveMicroUsd: 60 }, ["a", "b"]);
    const runner = seedRunner(w, "runner-noext", 4);
    const first = w.brain.jobProtocol.claim(runner, "req-x2-1") as unknown as Offer;
    backdate(w, first.attemptId, 40);
    finishAttempt(w, first.attemptId, 70);
    expect(w.brain.jobProtocol.claim(runner, "req-x2-2")).toBeNull();
    expect(await mission(w, both)).toMatchObject({ state: "paused", pauseReason: "budget" });
    expect((await mission(w, both)).timeExtendedByBrain).toBeUndefined();
    w.brain.close();
  });

  it("confirming a plan raises a default time limit to fit it, keeps a named one, and the estimate warns before confirming", async () => {
    const w = setupWorld();
    const db = () => w.brain.store.workspaceDb(w.workspaceId, w.org);
    const defaulted = (await run(w, "mission.create", "w1-create", { title: "w1", intent: "Fit", successCriteria: ["done"] })).resourceId ?? "";
    db().prepare("UPDATE missions SET budget_wall_ms=? WHERE id=?").run(30 * 60_000, defaulted); // what a Play's default looks like
    const longPlan = (await run(w, "plan.propose", "w1-plan", { missionId: defaulted, origin: "manual", tasks: [{ ...task("a"), estimatedMinutes: 85 }] })).resourceId ?? "";
    const before = ((await w.brain.executeQuery(w.owner, { queryType: "plans.estimate", workspaceId: w.workspaceId, resourceId: longPlan })) as unknown as { snapshot: Record<string, unknown> }).snapshot;
    expect(before).toMatchObject({ ceilingWallClockMs: 255 * 60_000 }); expect(before).not.toHaveProperty("timeLimitBelowEstimate");
    await run(w, "plan.confirm", "w1-confirm", { planVersionId: longPlan }, (await mission(w, defaulted)).version);
    expect((await mission(w, defaulted)).budget.maxWallClockMs).toBe(255 * 60_000);
    const named = (await run(w, "mission.create", "w2-create", { title: "w2", intent: "Named", successCriteria: ["done"], budget: { maxWallClockMs: 30 * 60_000, memberCap: 2 } })).resourceId ?? "";
    const plan = (await run(w, "plan.propose", "w2-plan", { missionId: named, origin: "manual", tasks: [{ ...task("a"), estimatedMinutes: 85 }] })).resourceId ?? "";
    const warned = ((await w.brain.executeQuery(w.owner, { queryType: "plans.estimate", workspaceId: w.workspaceId, resourceId: plan })) as unknown as { snapshot: Record<string, unknown> }).snapshot;
    expect(warned).toMatchObject({ ceilingWallClockMs: 30 * 60_000, timeLimitBelowEstimate: true });
    await run(w, "plan.confirm", "w2-confirm", { planVersionId: plan }, (await mission(w, named)).version);
    expect((await mission(w, named)).budget.maxWallClockMs).toBe(30 * 60_000);
    w.brain.close();
  });

  it("totals tokens per run, task, mission and workspace; a duplicate usage id counts once; estimates are flagged (#76)", async () => {
    const w = setupWorld();
    const id = await missionWithJobs(w, "u", { memberCap: 3 }, ["a", "b"]);
    const runner = seedRunner(w, "runner-usage");
    const first = w.brain.jobProtocol.claim(runner, "req-u-1") as unknown as Offer;
    const second = w.brain.jobProtocol.claim(runner, "req-u-2") as unknown as Offer;
    // Incremental stream: the replayed usage id is counted once, the estimated report is flagged.
    reportUsage(w, first.attemptId, 1, { usageId: "u1", inputTokens: 100, outputTokens: 20, microUsd: 0, accounting: "incremental" });
    reportUsage(w, first.attemptId, 2, { usageId: "u1", inputTokens: 100, outputTokens: 20, microUsd: 0, accounting: "incremental" });
    reportUsage(w, first.attemptId, 3, { usageId: "u2", inputTokens: 50, outputTokens: 10, cachedInputTokens: 5, microUsd: 7, accounting: "incremental", estimated: true });
    w.brain.jobProtocol.releaseReservation(first.attemptId);
    // Final-total stream: the last total replaces earlier ones.
    reportUsage(w, second.attemptId, 1, { usageId: "t1", inputTokens: 1, outputTokens: 1, microUsd: 1, accounting: "final-total" });
    reportUsage(w, second.attemptId, 2, { usageId: "t2", inputTokens: 300, outputTokens: 40, cachedInputTokens: 60, microUsd: 0, accounting: "final-total" });
    // Before settlement the second attempt is still running and shows what it reported so far.
    const runningRun = await usageOf(w, "usage.run", "run-u-b");
    expect(runningRun.attemptRows?.[0]).toMatchObject({ settled: false, inputTokens: 300, outputTokens: 40 });
    w.brain.jobProtocol.releaseReservation(second.attemptId);
    const missionTotals = (await usageOf(w, "usage.mission", id)).usage;
    expect(missionTotals).toMatchObject({ inputTokens: 450, outputTokens: 70, cachedInputTokens: 65, settledTokens: 585, settledMicroUsd: 7, reservedTokens: 0, attempts: 2, openAttempts: 0, estimated: true });
    expect((await usageOf(w, "usage.run", "run-u-a")).usage).toMatchObject({ inputTokens: 150, outputTokens: 30, cachedInputTokens: 5, settledMicroUsd: 7, estimated: true });
    const items = (await workView(w)).items.filter((entry) => entry.missionId === id);
    const taskB = items.find((entry) => entry.planTaskId === "b")!;
    expect((await usageOf(w, "usage.task", taskB.workItemId)).usage).toMatchObject({ settledTokens: 400, settledMicroUsd: 0, estimated: false });
    expect((await usageOf(w, "usage.workspace")).usage).toMatchObject({ settledTokens: 585, attempts: 2 });
    expect((await mission(w, id)).usage).toMatchObject({ settledTokens: 585, estimated: true });
    w.brain.close();
  });

  it("pauses at the mission token ceiling even when dollars are zero, and raising it resumes (#78)", async () => {
    const w = setupWorld();
    const id = await missionWithJobs(w, "k", { maxTokens: 1000, attemptReserveTokens: 100, memberCap: 3 }, ["a", "b"]);
    expect((await mission(w, id)).budget).toMatchObject({ maxTokens: 1000, attemptReserveTokens: 100 });
    const runner = seedRunner(w, "runner-tokens");
    const first = w.brain.jobProtocol.claim(runner, "req-k-1") as unknown as Offer;
    expect((await mission(w, id)).usage).toMatchObject({ reservedTokens: 100 });
    finishAttempt(w, first.attemptId, 0, { inputTokens: 900, outputTokens: 50 });
    expect(w.brain.jobProtocol.claim(runner, "req-k-2")).toBeNull();
    expect(queueReason(w, "job-k-b")).toBe("waiting: budget");
    const paused = await mission(w, id);
    expect(paused).toMatchObject({ state: "paused", pauseReason: "budget", usage: { settledTokens: 950, settledMicroUsd: 0 } });
    await expect(Promise.resolve().then(async () => await run(w, "mission.resume", "k-resume-early", { missionId: id }, paused.version))).rejects.toThrow(/raise the limit that was reached/);
    await run(w, "mission.budget.set", "k-raise", { missionId: id, budget: { maxTokens: 5000, memberCap: 3, attemptReserveTokens: 100 } }, paused.version);
    await run(w, "mission.resume", "k-resume", { missionId: id }, (await mission(w, id)).version);
    expect((w.brain.jobProtocol.claim(runner, "req-k-3") as unknown as Offer).jobId).toBe("job-k-b");
    w.brain.close();
  });

  it("an absent token ceiling behaves as before (#78)", async () => {
    const w = setupWorld();
    const id = await missionWithJobs(w, "n", { memberCap: 3 }, ["a", "b"]);
    const runner = seedRunner(w, "runner-no-ceiling");
    const first = w.brain.jobProtocol.claim(runner, "req-n-1") as unknown as Offer;
    finishAttempt(w, first.attemptId, 0, { inputTokens: 9_000_000, outputTokens: 1 });
    expect((w.brain.jobProtocol.claim(runner, "req-n-2") as unknown as Offer).jobId).toBe("job-n-b");
    expect((await mission(w, id)).state).toBe("active");
    w.brain.close();
  });

  it("a workspace spend cap reached mid-run pauses admission and raising it resumes (#55)", async () => {
    const w = setupWorld();
    const a = await missionWithJobs(w, "p", { memberCap: 3 }, ["a", "b"]);
    const runner = seedRunner(w, "runner-cap");
    await run(w, "workspace.spendCap.set", "cap-1", { dailyMicroUsd: 1000 });
    const first = w.brain.jobProtocol.claim(runner, "req-p-1") as unknown as Offer;
    finishAttempt(w, first.attemptId, 1500, { inputTokens: 10, outputTokens: 5 });
    expect(w.brain.jobProtocol.claim(runner, "req-p-2")).toBeNull();
    expect(await mission(w, a)).toMatchObject({ state: "paused", pauseReason: "budget" });
    const view = await usageOf(w, "usage.workspace");
    expect(view.spendCap).toMatchObject({ dailyMicroUsd: 1000, dailySpentMicroUsd: 1500 });
    const paused = await mission(w, a);
    await expect(Promise.resolve().then(async () => await run(w, "mission.resume", "p-resume-early", { missionId: a }, paused.version))).rejects.toThrow(/raise/);
    await run(w, "workspace.spendCap.set", "cap-2", { dailyMicroUsd: 5000 });
    await run(w, "mission.resume", "p-resume", { missionId: a }, (await mission(w, a)).version);
    expect((w.brain.jobProtocol.claim(runner, "req-p-3") as unknown as Offer).jobId).toBe("job-p-b");
    w.brain.close();
  });

  it("interactive runs outside missions are recorded in the workspace bucket, total in the workspace and count towards the spend cap (#77)", async () => {
    const w = setupWorld();
    const a = await missionWithJobs(w, "o", { memberCap: 3 }, ["a"]);
    insertJob(w, "job-adhoc", "run-adhoc");
    insertJob(w, "job-adhoc-2", "run-adhoc-2", 1000);
    const runner = seedRunner(w, "runner-outside");
    await run(w, "workspace.spendCap.set", "cap-o", { dailyMicroUsd: 1000 });
    const first = w.brain.jobProtocol.claim(runner, "req-o-1") as unknown as Offer;
    expect(first.jobId).toBe("job-adhoc");
    reportUsage(w, first.attemptId, 1, { inputTokens: 200, outputTokens: 30, microUsd: 1200, accounting: "final-total" });
    // In flight it is part of the cap through its (zero) reservation only; once settled its dollars count.
    w.brain.jobProtocol.releaseReservation(first.attemptId);
    const view = (await w.brain.executeQuery(w.owner, { queryType: "usage.workspace", workspaceId: w.workspaceId } as never)) as unknown as { snapshot: { usage: Record<string, number>; outsideMissions: Record<string, number>; spendCap: Record<string, number> } };
    expect(view.snapshot.outsideMissions).toMatchObject({ settledTokens: 230, settledMicroUsd: 1200, attempts: 1 });
    expect(view.snapshot.usage).toMatchObject({ settledTokens: 230, attempts: 1 });
    expect(view.snapshot.spendCap).toMatchObject({ dailySpentMicroUsd: 1200 });
    expect((await usageOf(w, "usage.run", "run-adhoc")).usage).toMatchObject({ settledTokens: 230, settledMicroUsd: 1200 });
    // The cap is reached by interactive spend: neither another ad-hoc run nor a mission attempt starts.
    expect(w.brain.jobProtocol.claim(runner, "req-o-2")).toBeNull();
    expect(queueReason(w, "job-adhoc-2")).toBe("waiting: workspace spend cap");
    expect(queueReason(w, "job-o-a")).toBe("waiting: budget");
    expect(await mission(w, a)).toMatchObject({ state: "paused", pauseReason: "budget" });
    w.brain.close();
  });

  it("plan estimates total only declared values and the ceiling equals the enforced budget (#54)", async () => {
    const w = setupWorld();
    const id = (await run(w, "mission.create", "e-create", { title: "e", intent: "Estimate", successCriteria: ["done"], budget: { maxMicroUsd: 900, finalAllowanceMicroUsd: 100, maxTokens: 4000, memberCap: 2 } })).resourceId ?? "";
    const planId = (await run(w, "plan.propose", "e-plan", { missionId: id, origin: "manual", tasks: [{ ...task("a"), estimatedMinutes: 10, maxMicroUsd: 300 }, { ...task("b"), estimatedMinutes: 5 }, task("c")] })).resourceId ?? "";
    const estimate = ((await w.brain.executeQuery(w.owner, { queryType: "plans.estimate", workspaceId: w.workspaceId, resourceId: planId })) as unknown as { snapshot: Record<string, unknown> }).snapshot;
    expect(estimate).toMatchObject({ taskCount: 3, totalEstimatedMinutes: 15, unknownMinutesTasks: 1, totalMicroUsd: 300, unknownCostTasks: 2, ceilingMicroUsd: 800, ceilingTokens: 4000 });
    const bare = (await run(w, "mission.create", "e2-create", { title: "e2", intent: "Bare", successCriteria: ["done"] })).resourceId ?? "";
    const barePlan = (await run(w, "plan.propose", "e2-plan", { missionId: bare, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
    const none = ((await w.brain.executeQuery(w.owner, { queryType: "plans.estimate", workspaceId: w.workspaceId, resourceId: barePlan })) as unknown as { snapshot: Record<string, unknown> }).snapshot;
    expect(none).toMatchObject({ unknownMinutesTasks: 1, unknownCostTasks: 1 });
    expect(none).not.toHaveProperty("totalEstimatedMinutes"); expect(none).not.toHaveProperty("totalMicroUsd"); expect(none).toMatchObject({ ceilingMicroUsd: 5_000_000 }); // the Governor's default budget (#47)
    w.brain.close();
  });
});
