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
function finishAttempt(w: World, attemptId: string, microUsd: number): void {
  w.brain.store.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(attemptId, 1, JSON.stringify({ kind: "usage", payload: { microUsd, accounting: "final-total" } }));
  w.brain.jobProtocol.releaseReservation(attemptId);
}
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
});
