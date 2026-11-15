import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorContext, AttentionItem, CommandReceipt, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { setupWorld, workView, type TestWorld } from "../helpers";
import { requestApproval } from "../support/approvals";
import { startPushReceiver, type PushReceiver } from "../support/push-receiver";

// Spec #90, ticket #104: every attention-item kind reaches a person's device as a web push, once, under the per-mission throttle, and
// progress never does. The receiver below is a real push service for one device (the push payload is decrypted with the device's key),
// so each assertion is about what the person would see. State is reached through commands and the clock; the two table writes that remain (a task Done, a mission paused at its limit) are named where used.
let world: TestWorld;
let device: PushReceiver;
beforeEach(async () => {
  world = setupWorld();
  device = await startPushReceiver();
  world.brain.registerPushSubscription(world.owner, device.subscription);
});
afterEach(async () => { world.brain.close(); await device.close(); });

const run = async (actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> =>
  (await world.brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: world.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
const query = async <T>(queryType: string, resourceId?: string): Promise<T> =>
  ((await world.brain.executeQuery(world.owner, { queryType, workspaceId: world.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const getMission = (id: string) => query<Mission>("missions.get", id);
const db = () => world.brain.store.workspaceDb(world.workspaceId, world.org);
const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [] });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (device.messages.length < count) { if (Date.now() > deadline) throw new Error(`expected ${count} pushes, got ${device.messages.length}: ${JSON.stringify(device.messages)}`); await wait(20); }
}
/** A pass of the maintenance notifier, then the pushes it caused: exactly `count` in all, and no more arrive. */
async function pass(count: number): Promise<void> {
  world.brain.notifyAttention();
  await until(count);
  await wait(150);
  expect(device.messages, "pushes after the pass").toHaveLength(count);
}
const last = () => device.messages.at(-1)!;

async function mission(key: string, tasks: PlanTask[], confirm = true): Promise<{ id: string; planId: string }> {
  const id = (await run(world.owner, "mission.create", `${key}-create`, { title: `Mission ${key}`, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(world.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  if (confirm) await run(world.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await getMission(id)).version);
  return { id, planId };
}
const itemOf = async (missionId: string, planTaskId: string): Promise<WorkItem> => (await workView(world)).items.find((entry: WorkItem) => entry.missionId === missionId && entry.planTaskId === planTaskId)!;
/** Three failed attempts park the task (the way a run that keeps failing does). */
async function park(missionId: string, planTaskId: string): Promise<void> {
  const item = await itemOf(missionId, planTaskId);
  for (const runId of [`${planTaskId}-r1`, `${planTaskId}-r2`, `${planTaskId}-r3`].map((name) => `${missionId}-${name}`)) {
    world.brain.missions.linkExecution(world.owner, world.workspaceId, item.workItemId, runId);
    world.brain.missions.recordRunFailure(world.org, world.workspaceId, runId, `tests failed in ${runId}`);
  }
}
/** A one-task mission whose task is Done (the one table write: Done needs a full run-and-evidence chain these tests do not run), then submitted. */
async function submitted(key: string): Promise<{ id: string; digest: string }> {
  const { id } = await mission(key, [task("only")]);
  db().prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, (await itemOf(id, "only")).workItemId);
  await run(world.owner, "mission.proposeCompletion", `${key}-finish`, { missionId: id }, (await getMission(id)).version);
  return { id, digest: (await query<{ digest: string }>("missionBundles.latest", id)).digest };
}
const base = (id: string) => `/missions/${id}`;
const w = "w=ws-test";

describe("push for every attention item (#104, ADR 0005 and 0011)", () => {
  it("an approval request reaches its approvers at once, with a link to that decision, and the maintenance pass does not repeat it", async () => {
    const approvalId = await requestApproval(world, "approval-1", "publish the release notes");
    await until(1);
    expect(last()).toEqual({ title: "Approval requested", body: "Approve or decline: publish the release notes", url: `/approvals/${approvalId}` });
    await pass(1);
    // The same pending request asked for again is the same item: nobody is told twice.
    expect(await requestApproval(world, "approval-1b", "publish the release notes", "approval-1")).toBe(approvalId);
    await pass(1);
    const another = await requestApproval(world, "approval-2");
    await until(2);
    expect(last()).toMatchObject({ body: "Approval awaiting review", url: `/approvals/${another}` });
  });

  it("a plan proposal pushes once and opens the proposal on the Plan tab", async () => {
    const { id, planId } = await mission("proposal", [task("a")], false);
    await pass(1);
    expect(last()).toEqual({ title: "Plan proposal for Mission proposal", body: "A mission needs you.", url: `${base(id)}/plan?${w}&proposal=${planId}` });
    await pass(1);
  });

  it("a parked task pushes once and opens the Plan tab; a paused mission opens its brief", async () => {
    const { id } = await mission("parked", [task("a"), task("b")]);
    await park(id, "a");
    expect((await query<{ items: AttentionItem[] }>("attention.list")).items.map((item) => item.kind)).toEqual(["parked"]);
    await pass(1);
    expect(last()).toMatchObject({ title: "Task a is parked", url: `${base(id)}/plan?${w}` });
    await pass(1);

    // A mission paused because a limit was reached: the one table write is the pause, which a run's admission makes at the limit.
    const paused = await mission("budget", [task("x")]);
    db().prepare("UPDATE missions SET state='paused', pause_reason='budget' WHERE id=?").run(paused.id);
    await pass(2);
    expect(last()).toMatchObject({ title: expect.stringContaining("Mission budget is paused"), url: `${base(paused.id)}/brief?${w}` });
  });

  it("a mission whose remaining work is all parked pushes once; its parked task waits for the mission's window, then pushes once", async () => {
    const { id } = await mission("stuck", [task("a")]);
    await park(id, "a");
    expect((await query<{ items: AttentionItem[] }>("attention.list")).items.map((item) => item.kind)).toEqual(["needs-attention", "parked"]);
    await pass(1);
    expect(last()).toMatchObject({ title: "Mission stuck needs attention: all remaining work is parked", url: `${base(id)}/plan?${w}` });
    // The second item of the same mission is inside the 15-minute window: held, not lost.
    await pass(1);
    // Sixteen minutes later (only the clock moves) the window is over and the held item goes out, once.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await pass(2);
      expect(last()).toMatchObject({ title: "Task a is parked" });
      await pass(2);
    } finally { vi.useRealTimers(); }
  });

  it("a mission submitted for sign-off pushes and opens its Results tab; a verified verdict waiting to close does too", async () => {
    const signOff = await submitted("signoff");
    await pass(1);
    expect(last()).toMatchObject({ title: "Mission signoff is ready for sign-off", url: `${base(signOff.id)}/outputs?${w}` });
    await pass(1);

    const verified = await submitted("verdict");
    await run(world.owner, "mission.verdict.record", "verdict-ok", { missionId: verified.id, bundleDigest: verified.digest, outcome: "verified" });
    await pass(2);
    expect(last()).toMatchObject({ title: "Mission verdict is verified and ready to close", url: `${base(verified.id)}/outputs?${w}` });
  });

  it("findings routed to the mission push and open the live view", async () => {
    const rejected = await submitted("routed");
    await run(world.owner, "mission.verdict.record", "routed-reject", { missionId: rejected.id, bundleDigest: rejected.digest, outcome: "rejected", findings: ["Name the three biggest causes"] });
    expect((await query<{ items: AttentionItem[] }>("attention.list")).items.map((item) => item.kind)).toEqual(["routed", "result-ready"]);
    await pass(1);
    expect(last()).toMatchObject({ title: "Findings routed to the mission", body: expect.stringContaining("Name the three biggest causes"), url: `${base(rejected.id)}/live?${w}` });
    await pass(1);
  });

  it("a result pushes once when the mission closes as achieved, and opens its Results tab or write-up", async () => {
    const done = await submitted("achieved");
    await run(world.owner, "mission.verdict.record", "achieved-ok", { missionId: done.id, bundleDigest: done.digest, outcome: "verified" });
    await run(world.owner, "mission.close", "achieved-close", { missionId: done.id, outcome: "achieved" }, (await getMission(done.id)).version);
    await pass(1);
    expect(last().title).toBe("Result ready: Mission achieved");
    expect(last().url).toMatch(new RegExp(`^(${base(done.id)}/outputs\\?${w}|/w/ws-test/knowledge/review\\?asset=\\S+)$`, "u"));
    await pass(1);
  });

  it("a schedule that could not start pushes to the workspace owner and opens Schedules", async () => {
    const automationId = (await run(world.owner, "automation.upsert", "schedule-upsert", { title: "Weekly report", target: { kind: "play", id: "ghost-play" }, trigger: { kind: "cron", cron: "0 8 * * *", timezone: "UTC" }, overlap: "queue-one", input: {} })).resourceId ?? "";
    await wait(5);
    await run(world.owner, "automation.control", "schedule-now", { automationId, action: "runNow" });
    const failed = (await query<{ items: AttentionItem[] }>("attention.list")).items.filter((item) => item.kind === "schedule-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.missionId).toBeUndefined();
    await pass(1);
    expect(last()).toMatchObject({ title: "Weekly report could not start its latest run", url: "/w/ws-test/schedules" });
    await pass(1);
  });

  it("progress never pushes: confirming a plan, editing the brief and changing the budget send nothing", async () => {
    const { id } = await mission("progress", [task("a"), task("b")]);
    await run(world.owner, "mission.brief.edit", "progress-brief", { missionId: id, baseVersion: 1, constraints: ["Stay in the EU"] });
    await run(world.owner, "mission.budget.set", "progress-budget", { missionId: id, budget: { maxMicroUsd: 5_000_000, memberCap: 2 } }, (await getMission(id)).version);
    await run(world.owner, "mission.seen", "progress-seen", { missionId: id, cursor: 1 });
    expect((await query<{ items: AttentionItem[] }>("attention.list")).items).toEqual([]);
    await pass(0);
  });

  it("a person who turned push off, or removed the device, is not pushed; the inbox still records it", async () => {
    world.brain.setNotificationPreferences(world.owner, { push: false });
    await mission("quiet-pref", [task("a")], false);
    await pass(0);
    world.brain.setNotificationPreferences(world.owner, { push: true });
    world.brain.unregisterPushSubscription(world.owner, device.subscription.endpoint);
    await mission("quiet-device", [task("a")], false);
    await pass(0);
    expect((await query<{ items: unknown[] }>("notifications.list")).items).toHaveLength(2);
  });
});
