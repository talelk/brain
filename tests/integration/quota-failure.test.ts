import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanTask, WorkItem } from "@brain/contracts";
import { JobProtocol } from "../../apps/governor/src/modules/jobs/index";
import { QUOTA_MAX_WAIT_MS, QUOTA_MAX_WAITS } from "../../apps/governor/src/domain/failure";
import { setupWorld, workView, DIGEST_A, type TestWorld } from "../helpers";
import { command, getMission } from "../support/reuse";
import { signProtocol } from "../support/signed-completion";

// ADR 0033: a provider's quota or rate limit is its own failure class. It is stored with the class "quota", said so to the person (the task, the
// run page), and its remedy waits for the provider's retry-after, bounded, without spending an attempt, then tries again.
// The failure comes in the way a real one does: a runner completes a failed attempt with the engine's error, and the mission's run is linked
// to the task; everything after that is the Governor's own.

const worlds: TestWorld[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); for (const w of worlds.splice(0)) w.brain.close(); });

const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [] });

function seedRunner(w: TestWorld, id: string): { runnerId: string; epoch: number; organizationId: string } {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(id, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3_600_000);
  }
  return { runnerId: id, epoch: 1, organizationId: w.org };
}

/** A mission with one task, ready to run. */
async function missionWithTask(w: TestWorld): Promise<{ missionId: string; workItemId: string }> {
  const missionId = (await command(w, w.owner, "mission.create", "q-create", { title: "Quota", intent: "Deliver", successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await command(w, w.owner, "plan.propose", "q-plan", { missionId, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
  await command(w, w.owner, "plan.confirm", "q-confirm", { planVersionId: planId }, (await getMission(w, missionId)).version);
  const item = (await workView(w)).items.find((entry) => entry.planTaskId === "a") as WorkItem;
  return { missionId, workItemId: item.workItemId };
}

type Failed = { attemptId: string; jobId: string; runId: string };
/** One attempt of the task the way a runner ends it: claimed, acknowledged and completed as failed with the engine's error. */
async function failedAttempt(w: TestWorld, workItemId: string, key: string, error: string): Promise<Failed> {
  await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest: w.brain.activeRelease(w.org)!.digest }, input: { message: key } },
  }, key);
  const runner = seedRunner(w, `runner-${key}`);
  const protocol = signProtocol(w.brain, new JobProtocol(w.brain.store, {
    completeStep: () => undefined, evaluatorEligible: () => true, runnerCurrent: () => true, activeRelease: () => undefined,
    resolveWorkflow: () => ({ workflow: {}, configDigest: `sha256:${"0".repeat(64)}` }), startRun: () => ({ runId: "unused" }),
  }));
  const offer = protocol.claim(runner, `req-${key}`) as { attemptId: string; jobId: string; leaseId: string; jobFence: number };
  protocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
  protocol.complete(runner, offer.attemptId, { result: "failed", jobFence: offer.jobFence, cleanupConfirmed: true, output: { error } });
  const runId = (w.brain.store.control.prepare("SELECT workflow_run_id AS r FROM jobs WHERE id=?").get(offer.jobId) as { r: string }).r;
  w.brain.missions.linkExecution(w.owner, w.workspaceId, workItemId, runId);
  w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, "the run failed");
  return { attemptId: offer.attemptId, jobId: offer.jobId, runId };
}

const itemOf = async (w: TestWorld): Promise<WorkItem> => (await workView(w)).items.find((entry) => entry.planTaskId === "a") as WorkItem;
const listed = (w: TestWorld, workItemId: string): boolean => w.brain.missions.autoStartPlan(w.org, w.workspaceId).flatMap((entry) => entry.items).some((entry) => entry.workItemId === workItemId);
const quotaError = (hint: string): string => `agent ended with error: quota or rate limit${hint}: 429: You exceeded your current quota, please check your plan and billing details.`;

describe("a quota or rate limit is a failure class of its own (ADR 0033)", () => {
  it("is stored as quota, said so to the person, and waits for the provider's retry-after before the task is tried again", async () => {
    const w = setupWorld(); worlds.push(w);
    const { workItemId } = await missionWithTask(w);
    const failed = await failedAttempt(w, workItemId, "q-1", quotaError(" (retry after 45s)"));

    // The class, its one remedy, and no attempt spent: the task is waiting, not failing.
    expect(await itemOf(w)).toMatchObject({ state: "ready", parked: false, failedAttempts: 0, failureClass: "quota", remedy: "wait-for-quota" });
    expect((await itemOf(w)).nextAction).toContain("quota or rate limit");
    expect((await itemOf(w)).nextAction).toContain("45 seconds");

    // What the person reads on the run: a quota, never "the model could not be reached".
    const job = (await w.brain.executeQuery(w.owner, { queryType: "job.get", workspaceId: w.workspaceId, resourceId: failed.jobId } as never)) as unknown as { snapshot: { attempts: Array<{ failureCode?: string; failureReason?: string }> } };
    expect(job.snapshot.attempts[0]).toMatchObject({ failureCode: "quota" });
    expect(job.snapshot.attempts[0]?.failureReason).toContain("quota or rate limit (retry after 45s)");

    // Held for exactly the provider's wait: not offered at 44 s, offered at 46 s.
    expect(listed(w, workItemId)).toBe(false);
    vi.setSystemTime(Date.now() + 44_000);
    expect(listed(w, workItemId)).toBe(false);
    vi.setSystemTime(Date.now() + 2_000);
    expect(listed(w, workItemId)).toBe(true);
  });

  it("waits the default when the provider named no time, and never longer than the ceiling when it named hours", async () => {
    const w = setupWorld(); worlds.push(w);
    const { workItemId } = await missionWithTask(w);
    await failedAttempt(w, workItemId, "q-none", quotaError(""));
    expect(await itemOf(w)).toMatchObject({ failureClass: "quota", failedAttempts: 0 });
    vi.setSystemTime(Date.now() + 59_000);
    expect(listed(w, workItemId)).toBe(false);
    vi.setSystemTime(Date.now() + 2_000);
    expect(listed(w, workItemId)).toBe(true);

    await failedAttempt(w, workItemId, "q-hours", quotaError(" (retry after 86400s)"));
    vi.setSystemTime(Date.now() + QUOTA_MAX_WAIT_MS - 1_000);
    expect(listed(w, workItemId)).toBe(false);
    vi.setSystemTime(Date.now() + 2_000);
    expect(listed(w, workItemId)).toBe(true);
  });

  it("a limit that outlasts the waits counts as a failed attempt, and the task parks at the threshold like any failure", async () => {
    const w = setupWorld(); worlds.push(w);
    const { workItemId } = await missionWithTask(w);
    for (let n = 0; n < QUOTA_MAX_WAITS; n++) {
      await failedAttempt(w, workItemId, `q-wait-${n}`, quotaError(" (retry after 10s)"));
      expect(await itemOf(w)).toMatchObject({ state: "ready", failedAttempts: 0, failureClass: "quota" });
    }
    await failedAttempt(w, workItemId, "q-count-1", quotaError(" (retry after 10s)"));
    expect(await itemOf(w)).toMatchObject({ state: "ready", failedAttempts: 1, failureClass: "quota", parked: false });
    await failedAttempt(w, workItemId, "q-count-2", quotaError(" (retry after 10s)"));
    await failedAttempt(w, workItemId, "q-count-3", quotaError(" (retry after 10s)"));
    expect(await itemOf(w)).toMatchObject({ state: "blocked", parked: true, failedAttempts: 3, failureClass: "quota" });
  });

  it("a provider's server error is not a quota", async () => {
    const w = setupWorld(); worlds.push(w);
    const { workItemId } = await missionWithTask(w);
    await failedAttempt(w, workItemId, "q-503", "agent ended with error: model endpoint: 503 service unavailable");
    expect((await itemOf(w)).failureClass).not.toBe("quota");
    expect((await itemOf(w)).failureClass).toBeDefined();
  });
});
