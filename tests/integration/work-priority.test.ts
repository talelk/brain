import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, Mission, WorkItem } from "@brain/contracts";
import { setupWorld, DIGEST_A } from "../helpers";
import { fixtureStarter } from "../support/starter";

// Spec #90, stories 54-57: priority, tags and a due date on work items. Priority is written into job priority at job creation; claiming
// keeps per-workspace fairness first and priority second; overdue is a board flag that never becomes an attention item or a notification.
type World = ReturnType<typeof setupWorld>;
type Offer = { jobId: string; attemptId: string; workspaceId: string };

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

function world(): World {
  const w = setupWorld();
  worlds.push(w);
  return w;
}

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number, workspaceId = w.workspaceId): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.actor("owner-1", workspaceId), {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const mission = async (w: World, id: string, workspaceId = w.workspaceId) =>
  ((await w.brain.executeQuery(w.actor("owner-1", workspaceId), { queryType: "missions.get", workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const getItem = async (w: World, id: string, workspaceId = w.workspaceId) =>
  ((await w.brain.executeQuery(w.actor("owner-1", workspaceId), { queryType: "workItems.get", workspaceId, resourceId: id })) as { snapshot: WorkItem }).snapshot;
const listItems = async (w: World, workspaceId = w.workspaceId) =>
  ((await w.brain.executeQuery(w.actor("owner-1", workspaceId), { queryType: "workItems.list", workspaceId, limit: 100 })) as { snapshot: { items: WorkItem[] } }).snapshot.items;

interface Task { id: string; title?: string; criteria?: string[]; dependsOn?: string[] }

/** A mission with a confirmed plan of independent tasks; auto-start is off so a test decides when work starts. Returns task id to work item id. */
async function confirmedMission(w: World, key: string, taskIds: string[], extra: Record<string, unknown> = {}, workspaceId = w.workspaceId): Promise<{ missionId: string; ids: Record<string, string> }> {
  const missionId = (await run(w, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], autoStart: false, ...extra }, undefined, workspaceId)).resourceId ?? "";
  const tasks = taskIds.map((id): Task => ({ id, title: `${key} ${id}`, criteria: [`${id}-done`], dependsOn: [] }));
  const planId = (await run(w, "plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks }, undefined, workspaceId)).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, missionId, workspaceId)).version, workspaceId);
  const ids: Record<string, string> = {};
  for (const item of await listItems(w, workspaceId)) if (item.missionId === missionId) ids[item.planTaskId] = item.workItemId;
  return { missionId, ids };
}

async function setDetails(w: World, key: string, workItemId: string, payload: Record<string, unknown>, workspaceId = w.workspaceId): Promise<CommandReceipt> {
  const item = await getItem(w, workItemId, workspaceId);
  return run(w, "workItem.details.set", key, { workItemId, ...payload }, item.version, workspaceId);
}

/** The fixture workflow dispatched for a work item, as the Start button does. */
async function dispatch(w: World, key: string, workItemId: string, workspaceId = w.workspaceId): Promise<void> {
  const digest = w.brain.activeRelease(w.org)!.digest;
  await run(w, "workflow.dispatch", key, { workflow: { id: "fixture-workflow", digest }, input: { message: key }, workItemId }, undefined, workspaceId);
}

function seedRunner(w: World, id: string, slots = 8) {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 64000, 131072, 204800, ?)`).run(id, w.org, DIGEST_A, s.now(), slots);
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-isolation:fixture:ephemeral-container"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId: id, epoch: 1, organizationId: w.org };
}

/** The work item a claimed job belongs to: the item its run is linked to (a read of the execution links). */
async function claimedItem(w: World, runner: ReturnType<typeof seedRunner>, request: string): Promise<string | null> {
  const offer = w.brain.jobProtocol.claim(runner, request) as unknown as Offer | null;
  if (!offer) return null;
  const runId = (w.brain.store.control.prepare("SELECT workflow_run_id AS id FROM jobs WHERE id=?").get(offer.jobId) as { id: string }).id;
  const link = w.brain.store.workspaceDb(offer.workspaceId, w.org).prepare("SELECT work_item_id AS id FROM execution_links WHERE run_id=?").get(runId) as { id: string } | undefined;
  return link?.id ?? null;
}

describe("work item priority, tags and due date (#116)", () => {
  it("defaults to normal priority with no tags or due date, and is edited by one command that tidies the tags", async () => {
    const w = world();
    const { ids } = await confirmedMission(w, "details", ["a"]);
    const fresh = await getItem(w, ids["a"]!);
    expect(fresh).toMatchObject({ priority: "normal", tags: [] });
    expect(fresh.dueAt).toBeUndefined();
    expect(fresh.overdue).toBeUndefined();

    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await setDetails(w, "d1", ids["a"]!, { priority: "urgent", tags: ["  Billing ", "billing", "Q4-Launch"], dueAt: due });
    const edited = await getItem(w, ids["a"]!);
    expect(edited).toMatchObject({ priority: "urgent", tags: ["billing", "q4-launch"], dueAt: due });
    expect(edited.version).toBe(fresh.version + 1);
    expect(edited.overdue).toBeUndefined();

    // A field left out stays as it was; null clears the due date.
    await setDetails(w, "d2", ids["a"]!, { priority: "low" });
    expect(await getItem(w, ids["a"]!)).toMatchObject({ priority: "low", tags: ["billing", "q4-launch"], dueAt: due });
    await setDetails(w, "d3", ids["a"]!, { dueAt: null, tags: [] });
    const cleared = await getItem(w, ids["a"]!);
    expect(cleared).toMatchObject({ priority: "low", tags: [] });
    expect(cleared.dueAt).toBeUndefined();
  });

  it("refuses an unknown priority, too many or oversized tags, a stale version and an edit by an agent", async () => {
    const w = world();
    const { ids } = await confirmedMission(w, "refuse", ["a"]);
    await expect(setDetails(w, "r1", ids["a"]!, { priority: "critical" })).rejects.toThrow();
    await expect(setDetails(w, "r2", ids["a"]!, { tags: Array.from({ length: 11 }, (_, n) => `t${n}`) })).rejects.toThrow();
    await expect(setDetails(w, "r3", ids["a"]!, { tags: ["x".repeat(33)] })).rejects.toThrow();
    await expect(run(w, "workItem.details.set", "r4", { workItemId: ids["a"], priority: "high" }, 99)).rejects.toThrow(/version|changed/i);
    expect((await getItem(w, ids["a"]!)).priority).toBe("normal");
  });

  it("flags an overdue item on read, only while it is open, and never raises an attention item or a notification", async () => {
    const w = world();
    const { ids } = await confirmedMission(w, "overdue", ["late", "later"]);
    const attention = async () => ((await w.brain.executeQuery(w.owner, { queryType: "attention.list", workspaceId: w.workspaceId } as never)) as unknown as { snapshot: { items: Array<{ kind: string; title: string }> } }).snapshot.items;
    const notices = async () => ((await w.brain.executeQuery(w.owner, { queryType: "notifications.list", workspaceId: w.workspaceId } as never)) as unknown as { snapshot: { items: unknown[] } }).snapshot.items;
    const beforeAttention = await attention();
    const beforeNotices = await notices();

    await setDetails(w, "o1", ids["late"]!, { dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    await setDetails(w, "o2", ids["later"]!, { dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    expect((await getItem(w, ids["late"]!)).overdue).toBe(true);
    expect((await getItem(w, ids["later"]!)).overdue).toBeUndefined();
    expect((await listItems(w)).filter((item) => item.overdue).map((item) => item.workItemId)).toEqual([ids["late"]]);

    // Flagging is derived: nothing appears in Needs you and nobody is told.
    expect(await attention()).toEqual(beforeAttention);
    expect(await notices()).toEqual(beforeNotices);
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    expect(await attention()).toEqual(beforeAttention);
    expect(await notices()).toEqual(beforeNotices);
  });

  it("keeps priority, tags and due date when a replan keeps the task", async () => {
    const w = world();
    const { missionId, ids } = await confirmedMission(w, "replan", ["a", "b"]);
    const due = new Date(Date.now() + 86_400_000).toISOString();
    await setDetails(w, "p1", ids["a"]!, { priority: "high", tags: ["ops"], dueAt: due });
    const planId = (await run(w, "plan.propose", "replan-plan2", { missionId, origin: "manual", tasks: [
      { id: "a", title: "replan a", criteria: ["a-done"], dependsOn: [] },
      { id: "b", title: "replan b renamed", criteria: ["b-done"], dependsOn: [] },
    ] })).resourceId ?? "";
    await run(w, "plan.confirm", "replan-confirm2", { planVersionId: planId }, (await mission(w, missionId)).version);
    const live = (await listItems(w)).filter((item) => item.missionId === missionId);
    const a = live.find((item) => item.planTaskId === "a")!;
    expect(a.workItemId).toBe(ids["a"]);
    expect(a).toMatchObject({ priority: "high", tags: ["ops"], dueAt: due });
    // A task the plan changed becomes a new work item that inherits what a person set on its predecessor.
    const renamed = live.find((item) => item.planTaskId === "b")!;
    expect(renamed.workItemId).not.toBe(ids["b"]);
    await setDetails(w, "p2", renamed.workItemId, { priority: "urgent", tags: ["renamed"] });
    const changed = (await run(w, "plan.propose", "replan-plan3", { missionId, origin: "manual", tasks: [
      { id: "a", title: "replan a", criteria: ["a-done"], dependsOn: [] },
      { id: "b", title: "replan b again", criteria: ["b-done"], dependsOn: [] },
    ] })).resourceId ?? "";
    await run(w, "plan.confirm", "replan-confirm3", { planVersionId: changed }, (await mission(w, missionId)).version);
    const b = (await listItems(w)).find((item) => item.missionId === missionId && item.planTaskId === "b")!;
    expect(b.workItemId).not.toBe(renamed.workItemId);
    expect(b).toMatchObject({ priority: "urgent", tags: ["renamed"] });
  });

  it("does not change the Done rule: an urgent item still needs verified evidence (ADR 0022)", async () => {
    const w = world();
    const { ids } = await confirmedMission(w, "done-rule", ["a"]);
    await setDetails(w, "u1", ids["a"]!, { priority: "urgent" });
    let item = await getItem(w, ids["a"]!);
    await run(w, "workItem.transition", "u-start", { workItemId: ids["a"], state: "in-progress" }, item.version);
    item = await getItem(w, ids["a"]!);
    await run(w, "workItem.transition", "u-review", { workItemId: ids["a"], state: "review" }, item.version);
    item = await getItem(w, ids["a"]!);
    await expect(run(w, "workItem.transition", "u-done", { workItemId: ids["a"], state: "done" }, item.version)).rejects.toThrow(/evidence/i);
    expect((await getItem(w, ids["a"]!)).state).toBe("review");
  });
});

describe("priority in claiming (#116)", () => {
  it("writes the work item's priority into the job it creates, so a higher-priority ready job is claimed first in a workspace", async () => {
    const w = world();
    const { ids } = await confirmedMission(w, "order", ["low", "normal", "high", "urgent"], { budget: { memberCap: 5 } });
    await setDetails(w, "pr-low", ids["low"]!, { priority: "low" });
    await setDetails(w, "pr-high", ids["high"]!, { priority: "high" });
    await setDetails(w, "pr-urgent", ids["urgent"]!, { priority: "urgent" });
    // Dispatched oldest first: age alone would serve low first.
    for (const task of ["low", "normal", "high", "urgent"]) await dispatch(w, `order-${task}`, ids[task]!);
    const runner = seedRunner(w, "runner-order");
    const order: Array<string | null> = [];
    for (let n = 0; n < 4; n++) order.push(await claimedItem(w, runner, `req-order-${n}`));
    expect(order).toEqual([ids["urgent"], ids["high"], ids["normal"], ids["low"]]);
  });

  it("serves a higher-priority job of one mission before a lower one of another in the same workspace", async () => {
    const w = world();
    const x = await confirmedMission(w, "mx", ["busy", "urgent"], { budget: { memberCap: 3 } });
    const y = await confirmedMission(w, "my", ["calm"], { budget: { memberCap: 3 } });
    // Mission x already has an attempt running, so by mission turn-taking alone mission y would go next.
    await dispatch(w, "mx-busy", x.ids["busy"]!);
    const runner = seedRunner(w, "runner-missions");
    expect(await claimedItem(w, runner, "req-m-0")).toBe(x.ids["busy"]);
    await setDetails(w, "mx-up", x.ids["urgent"]!, { priority: "urgent" });
    await dispatch(w, "my-calm", y.ids["calm"]!);
    await dispatch(w, "mx-urgent", x.ids["urgent"]!);
    expect(await claimedItem(w, runner, "req-m-1")).toBe(x.ids["urgent"]);
    expect(await claimedItem(w, runner, "req-m-2")).toBe(y.ids["calm"]);
  });

  it("applies a priority edit to a job that is already queued", async () => {
    const w = world();
    const { ids } = await confirmedMission(w, "edit", ["first", "second"]);
    await dispatch(w, "edit-first", ids["first"]!);
    await dispatch(w, "edit-second", ids["second"]!);
    await setDetails(w, "edit-bump", ids["second"]!, { priority: "urgent" });
    const runner = seedRunner(w, "runner-edit");
    expect(await claimedItem(w, runner, "req-e-0")).toBe(ids["second"]);
    expect(await claimedItem(w, runner, "req-e-1")).toBe(ids["first"]);
  });

  it("never lets one workspace starve another by inflating priority, even with hundreds of urgent jobs queued", async () => {
    const w = world();
    w.brain.createWorkspace(w.actor("owner-1"), { workspaceId: "ws-other", slug: "other" });
    const greedy = await confirmedMission(w, "greedy", ["g"], { budget: { memberCap: 5 } });
    const other = await confirmedMission(w, "modest", ["m"], {}, "ws-other");
    await setDetails(w, "g-urgent", greedy.ids["g"]!, { priority: "urgent" });
    await setDetails(w, "m-low", other.ids["m"]!, { priority: "low" }, "ws-other");
    // An administrator may allow a long queue (the default limit is 100); the claim must stay fair at any length.
    await run(w, "workspace.queueLimit.set", "greedy-queue", { maxQueued: 1000 });
    for (let n = 0; n < 230; n++) await dispatch(w, `greedy-${n}`, greedy.ids["g"]!);
    await dispatch(w, "modest-0", other.ids["m"]!, "ws-other");
    const runner = seedRunner(w, "runner-fair");
    expect(await claimedItem(w, runner, "req-f-0")).toBe(greedy.ids["g"]);
    // The greedy workspace now has an attempt in flight and the other none: fairness comes first, so the low job is offered next.
    expect(await claimedItem(w, runner, "req-f-1")).toBe(other.ids["m"]);
  }, 300_000);

  it("starts the highest-priority ready task first when the mission can run only one", async () => {
    const w = world();
    const starter = fixtureStarter();
    w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, starter.documents, starter.sourceRevision, starter.scripts, starter.instructions, starter.schemas).digest);
    const missionId = (await run(w, "mission.create", "as-create", { title: "as", intent: "Deliver as", successCriteria: ["delivered"], autoStart: false, budget: { memberCap: 1 } })).resourceId ?? "";
    const tasks = ["a", "b", "c"].map((id) => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [], workflowId: "operations-triage" }));
    const planId = (await run(w, "plan.propose", "as-plan", { missionId, origin: "manual", tasks })).resourceId ?? "";
    await run(w, "plan.confirm", "as-confirm", { planVersionId: planId }, (await mission(w, missionId)).version);
    const items = (await listItems(w)).filter((item) => item.missionId === missionId);
    const c = items.find((item) => item.planTaskId === "c")!;
    await setDetails(w, "as-urgent", c.workItemId, { priority: "urgent" });
    await run(w, "mission.policy.set", "as-on", { missionId, autoStart: true }, (await mission(w, missionId)).version);
    const states = Object.fromEntries((await listItems(w)).filter((item) => item.missionId === missionId).map((item) => [item.planTaskId, item.state]));
    expect(states).toEqual({ a: "ready", b: "ready", c: "in-progress" });
  });
});
