import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

// Story 98 (ADR 0040): a workspace's queue (jobs waiting for a runner) has an operator-set limit. A person's new work is refused at the
// door with a reason once the queue is at it; work already admitted, other workspaces and idempotent retries are untouched. State is reached
// through commands only (no runner is ever started, so every job stays queued).
const worlds: TestWorld[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: TestWorld, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, opts: { workspaceId?: string; expectedVersion?: number } = {}): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: opts.workspaceId ?? w.workspaceId, idempotencyKey: key,
    ...(opts.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const fails = async (fn: () => Promise<unknown>, pattern: RegExp) => await expect(Promise.resolve().then(fn)).rejects.toThrow(pattern);
const settings = async (w: TestWorld, workspaceId = w.workspaceId) => ((await w.brain.executeQuery(w.owner, { queryType: "engineSettings.get", workspaceId })) as unknown as { snapshot: { queueLimit: { maxQueued: number; queued: number; isDefault: boolean } } }).snapshot.queueLimit;
const setLimit = (w: TestWorld, key: string, maxQueued: number, workspaceId = w.workspaceId) => run(w, w.owner, "workspace.queueLimit.set", key, { maxQueued }, { workspaceId });

function world(): TestWorld {
  const w = setupWorld();
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  worlds.push(w);
  return w;
}
const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id} is written up`], dependsOn: [] });
const missionsOf = async (w: TestWorld, workspaceId = w.workspaceId) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.list", workspaceId })) as unknown as { snapshot: { items: Mission[] } }).snapshot.items;

/** A mission with a confirmed one-task plan: with no runner its job waits in the queue. */
async function queueOne(w: TestWorld, key: string, workspaceId = w.workspaceId): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"] }, { workspaceId })).resourceId ?? "";
  await proposeAndConfirm(w, id, key, workspaceId);
  return id;
}
async function proposeAndConfirm(w: TestWorld, missionId: string, key: string, workspaceId = w.workspaceId): Promise<CommandReceipt> {
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks: [task("t")] }, { workspaceId })).resourceId ?? "";
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId, resourceId: missionId })) as unknown as { snapshot: Mission }).snapshot.version;
  return await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, { workspaceId, expectedVersion: version });
}
async function queuedIs(w: TestWorld, n: number, workspaceId = w.workspaceId): Promise<void> {
  const deadline = Date.now() + 15_000;
  while ((await settings(w, workspaceId)).queued !== n) {
    if (Date.now() > deadline) throw new Error(`queue never reached ${n}: ${(await settings(w, workspaceId)).queued}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("queue-depth limit (story 98)", () => {
  it("has a documented default that a fresh workspace already carries, and an empty queue", async () => {
    const w = world();
    expect(await settings(w)).toEqual({ maxQueued: 100, queued: 0, isDefault: true });
  });

  it("refuses new work with the reason once the queue is at the limit, and creates nothing", async () => {
    const w = world();
    expect((await setLimit(w, "limit-2", 2)).accepted).toBe(true);
    expect(await settings(w)).toMatchObject({ maxQueued: 2, isDefault: false });
    await queueOne(w, "m1");
    await queueOne(w, "m2");
    await queuedIs(w, 2);
    const before = (await missionsOf(w)).length;
    await fails(() => run(w, w.owner, "mission.create", "over-1", { title: "Over", intent: "Too much", successCriteria: ["done"] }), /already has 2 tasks waiting for a runner.*queue limit \(2\).*administrator/su);
    expect((await missionsOf(w)).length).toBe(before);
    // The refusal is a capacity error a client can retry, not a validation failure.
    await run(w, w.owner, "mission.create", "over-2", { title: "Over", intent: "Too much", successCriteria: ["done"] }).catch((error: unknown) => {
      expect(error).toMatchObject({ code: "CAPACITY_EXCEEDED", retryable: true });
    });
  });

  it("accepts new work again as soon as the queue drops below the limit or an administrator raises it", async () => {
    const w = world();
    await setLimit(w, "limit-1", 1);
    await queueOne(w, "m1");
    await queuedIs(w, 1);
    await fails(() => run(w, w.owner, "mission.create", "blocked", { title: "B", intent: "B", successCriteria: ["b"] }), /queue limit/u);
    expect((await setLimit(w, "limit-3", 3)).accepted).toBe(true);
    expect((await run(w, w.owner, "mission.create", "allowed", { title: "A", intent: "A", successCriteria: ["a"] })).accepted).toBe(true);
  });

  it("does not refuse a retry of a command that was already accepted", async () => {
    const w = world();
    await setLimit(w, "limit-1", 1);
    const first = await run(w, w.owner, "mission.create", "retry-me", { title: "Retry", intent: "Retry", successCriteria: ["r"] });
    expect(first.accepted).toBe(true);
    await queueOne(w, "m1");
    await queuedIs(w, 1);
    await fails(() => run(w, w.owner, "mission.create", "fresh", { title: "F", intent: "F", successCriteria: ["f"] }), /queue limit/u);
    const again = await run(w, w.owner, "mission.create", "retry-me", { title: "Retry", intent: "Retry", successCriteria: ["r"] });
    expect(again).toEqual(first);
  });

  it("never refuses work that is already admitted: a plan confirmed on a full queue still starts its tasks (the Governor's own dispatch is not a person's new work)", async () => {
    const w = world();
    const early = (await run(w, w.owner, "mission.create", "early-create", { title: "Early", intent: "Early", successCriteria: ["e"] })).resourceId ?? "";
    await setLimit(w, "limit-1", 1);
    await queueOne(w, "m1");
    await queuedIs(w, 1);
    await fails(() => run(w, w.owner, "mission.create", "late", { title: "L", intent: "L", successCriteria: ["l"] }), /queue limit/u);
    expect((await proposeAndConfirm(w, early, "early")).accepted).toBe(true);
    await queuedIs(w, 2);
    expect((await settings(w)).queued).toBeGreaterThan((await settings(w)).maxQueued - 1);
  });

  it("belongs to one workspace: another workspace keeps its own limit and its own queue", async () => {
    const w = world();
    const other = "ws-queue-other";
    w.brain.createWorkspace(w.owner, { workspaceId: other, slug: "queue-other" });
    await setLimit(w, "limit-a", 1);
    await queueOne(w, "m1");
    await queuedIs(w, 1);
    await fails(() => run(w, w.owner, "mission.create", "a-over", { title: "A", intent: "A", successCriteria: ["a"] }), /queue limit/u);
    expect((await run(w, w.owner, "mission.create", "b-fine", { title: "B", intent: "B", successCriteria: ["b"] }, { workspaceId: other })).accepted).toBe(true);
    expect(await settings(w, other)).toMatchObject({ maxQueued: 100, queued: 0, isDefault: true });
  });

  it("also refuses a person's dispatch of a Play or a restart, and answers its retry with the first receipt", async () => {
    const w = setupWorld();
    worlds.push(w);
    const digest = w.brain.activeRelease(w.org)!.digest;
    const dispatch = (key: string) => run(w, w.owner, "workflow.dispatch", key, { workflow: { id: "fixture-workflow", digest }, input: { message: key } });
    await setLimit(w, "limit-d", 1);
    const first = await dispatch("dispatch-1");
    expect(first.accepted).toBe(true);
    await queuedIs(w, 1);
    await fails(() => dispatch("dispatch-2"), /already has 1 task waiting for a runner.*queue limit \(1\)/su);
    expect(await dispatch("dispatch-1")).toEqual(first);
    expect(await settings(w)).toMatchObject({ queued: 1, maxQueued: 1 });
  });

  it("only an administrator may set it, and only within bounds", async () => {
    const w = world();
    const operator = (await w.grantApprover("queue-operator")).actor;
    await fails(() => run(w, operator, "workspace.queueLimit.set", "op-set", { maxQueued: 5 }), /forbidden|scope|not permitted|administration/iu);
    expect((await settings(w)).isDefault).toBe(true);
    for (const bad of [0, -1, 10_001, 1.5]) await fails(() => setLimit(w, `bad-${bad}`, bad), /payload|schema|maximum|minimum|integer/iu);
    expect((await settings(w)).isDefault).toBe(true);
  });
});
