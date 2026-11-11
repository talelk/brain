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
async function missionWithJobs(w: World, key: string, budget: Record<string, number>, tasks: string[]): Promise<string> {
  const id = (await run(w, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], budget })).resourceId ?? "";
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
  w.brain.store.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(attemptId, 1, JSON.stringify({ kind: "usage", payload: { microUsd, accounting: "final-total", ...tokens } }));
  w.brain.jobProtocol.releaseReservation(attemptId);
}
function reportUsage(w: World, attemptId: string, seq: number, payload: Record<string, unknown>): void {
  w.brain.store.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(attemptId, seq, JSON.stringify({ kind: "usage", payload }));
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
    await expect(Promise.resolve().then(async () => await run(w, "mission.resume", "b-resume-early", { missionId: id }, paused.version))).rejects.toThrow(/raise the mission budget/);
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

  it("wall-clock time excludes paused time and exhausting it pauses for budget", async () => {
    const w = setupWorld();
    const id = await missionWithJobs(w, "c", { maxWallClockMs: 1, memberCap: 2 }, ["a"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(w.brain.jobProtocol.claim(seedRunner(w, "runner-clock"), "req-c-1")).toBeNull();
    expect(queueReason(w, "job-c-a")).toBe("waiting: budget");
    expect(await mission(w, id)).toMatchObject({ state: "paused", pauseReason: "budget" });
    const frozen = (await mission(w, id)).usage.activeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await mission(w, id)).usage.activeMs).toBe(frozen);
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
    await expect(Promise.resolve().then(async () => await run(w, "mission.resume", "k-resume-early", { missionId: id }, paused.version))).rejects.toThrow(/raise the mission budget/);
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
    expect(none).not.toHaveProperty("totalEstimatedMinutes"); expect(none).not.toHaveProperty("totalMicroUsd"); expect(none).not.toHaveProperty("ceilingMicroUsd");
    w.brain.close();
  });
});
