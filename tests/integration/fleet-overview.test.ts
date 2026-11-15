import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, AttentionItem, BrainSession, FleetOverview, Mission, PlanTask } from "@brain/contracts";
import { advertisedCapabilities } from "../../apps/runner/src/engines/isolation";
import { seedHuman, setupWorld, type TestWorld } from "../helpers";
import { observation, registerRunner } from "../support/runnerHello";
import { command, getMission } from "../support/reuse";
import { fixtureStarter } from "../support/starter";

// The fleet overview (spec #90, stories 43 and 44): every member sees open missions by condition, the team members at work, the runners'
// slot summary and spend today. Missions, plans, runners and sessions are reached through commands and the runner protocol; each count is
// compared with the record the rest of the product shows (missions.list, sessions.list, usage.workspace, runners.list, attention.list).

type Offer = { jobId: string; attemptId: string; leaseId: string; jobFence: number };
const worlds: TestWorld[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id} is done`], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" }, ...extra });
const read = async <T>(w: TestWorld, actor: ActorContext, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(actor, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: T }).snapshot;
const overview = (w: TestWorld, actor: ActorContext = w.owner) => read<FleetOverview>(w, actor, "fleet.overview");

function world(): TestWorld {
  const w = setupWorld();
  worlds.push(w);
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  return w;
}

/** A mission whose one task is assigned to the team member "pi". Confirmed, auto-start queues its job; unconfirmed, it is a plan proposal. */
async function mission(w: TestWorld, key: string, confirm: boolean): Promise<string> {
  const id = (await command(w, w.owner, "mission.create", `${key}-create`, { title: `Mission ${key}`, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await command(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
  if (confirm) await command(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await getMission(w, id)).version);
  return id;
}

/** A runner that enrolls through the runner protocol, reporting the fixture engine. */
function runner(w: TestWorld, runnerId: string) {
  const at = new Date(Date.now() - 60_000).toISOString();
  const caps = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", ...advertisedCapabilities([], [{ id: "fixture", features: ["sessions"] }])];
  const registered = registerRunner(w.brain, w.owner, runnerId, { capabilities: caps.map((capability) => observation(capability, at)) });
  return { ...registered, organizationId: w.org };
}

/** The runner claims the next queued job and starts its attempt: the attempt is running and its session is live. */
function start(w: TestWorld, who: ReturnType<typeof runner>, key: string): Offer {
  const offer = w.brain.jobProtocol.claim(who, `claim-${key}`) as unknown as Offer;
  expect(offer, "the runner was offered the task").toBeTruthy();
  w.brain.jobProtocol.ack(who, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: `sha256:${"a".repeat(64)}`, features: ["sessions"] } });
  return offer;
}

async function viewer(w: TestWorld): Promise<ActorContext> {
  seedHuman(w.brain, w.org, "viewer-1");
  await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-grant-viewer", commandType: "member.grant", workspaceId: w.workspaceId, idempotencyKey: "grant-viewer", expectedVersion: (await read<{ workspace: { version: number } }>(w, w.owner, "workspace.context")).workspace.version,
    payload: { principalId: "viewer-1", role: "viewer", reason: "reads the fleet overview" } } as never, "grant-viewer");
  return w.actor("viewer-1", w.workspaceId);
}

describe("fleet overview (spec #90, stories 43 and 44)", () => {
  it("counts each open mission once by condition, and the counts agree with the missions, sessions, runners and spend records", async () => {
    const w = world();
    const working = await mission(w, "working", true);
    const who = runner(w, "runner-1");
    start(w, who, "working");
    const waiting = await mission(w, "waiting", true);
    const needing = await mission(w, "needing", false);
    const ended = await mission(w, "ended", false);
    await command(w, w.owner, "mission.close", "ended-close", { missionId: ended, outcome: "cancelled" }, (await getMission(w, ended)).version);

    const fleet = await overview(w);
    expect(fleet.missions).toMatchObject({ open: 3, working: 1, waiting: 1, needsAttention: 1 });
    expect(fleet.missions.working + fleet.missions.waiting + fleet.missions.needsAttention).toBe(fleet.missions.open);
    expect(Object.fromEntries(fleet.missions.items.map((item) => [item.missionId, item.condition]))).toEqual({ [working]: "working", [waiting]: "waiting", [needing]: "needs-attention" });

    // Working is what Today's Working-now strip counts: open missions with a task running.
    const listed = (await read<{ items: Mission[] }>(w, w.owner, "missions.list")).items;
    expect(listed.filter((entry) => entry.state !== "closed" && entry.usage.runningMembers > 0).map((entry) => entry.missionId)).toEqual([working]);
    // Needs attention is what the attention list names: a blocking item bound to the mission.
    const attention = (await read<{ items: AttentionItem[] }>(w, w.owner, "attention.list")).items;
    expect(attention.filter((item) => item.tier <= 4).map((item) => item.missionId)).toEqual([needing]);

    // The team member serving the running task is active; its session is one of the workspace's live sessions.
    const sessions = (await read<{ items: BrainSession[] }>(w, w.owner, "sessions.list")).items.filter((session) => ["starting", "running", "waiting"].includes(session.state));
    expect(sessions).toHaveLength(1);
    expect(fleet.activeMembers).toEqual({ count: 1, items: [{ missionId: working, missionTitle: "Mission working", memberId: "pi", role: "pi", sessions: 1 }] });

    // Runner capacity sums the runners the administrator sees.
    const runners = (await read<{ items: Array<{ runnerId: string; capacity: { slots: number }; reserved: { slots: number }; connectivity: string }> }>(w, w.owner, "runners.list")).items;
    expect(runners.map((entry) => entry.runnerId)).toEqual(["runner-1"]);
    expect(fleet.runners).toMatchObject({ registered: 1, online: 1, slotsTotal: runners[0]!.capacity.slots, slotsUsed: runners[0]!.reserved.slots });
    expect(fleet.runners.slotsUsed).toBeGreaterThan(0);

    // Spend today is the workspace usage view's own trailing-day figure.
    const usage = await read<{ spendCap: { dailySpentMicroUsd: number } }>(w, w.owner, "usage.workspace");
    expect(fleet.spend.todayMicroUsd).toBe(usage.spendCap.dailySpentMicroUsd);
    expect(fleet.attentionOutsideMissions).toBe(0);
  });

  it("an empty workspace is all zeros, and a disabled runner is registered but offers no capacity", async () => {
    const w = world();
    expect(await overview(w)).toMatchObject({ missions: { open: 0, working: 0, waiting: 0, needsAttention: 0, items: [] }, activeMembers: { count: 0, items: [] }, runners: { registered: 0, online: 0, slotsUsed: 0, slotsTotal: 0 }, spend: { todayMicroUsd: 0 } });
    runner(w, "runner-off");
    expect((await overview(w)).runners).toMatchObject({ registered: 1, online: 1, slotsTotal: 2 });
    await command(w, w.owner, "runner.control", "drain", { runnerId: "runner-off", action: "disable", reason: "maintenance" });
    expect((await overview(w)).runners).toMatchObject({ registered: 1, online: 0, slotsUsed: 0, slotsTotal: 0 });
  });

  it("a workspace member without runner administration sees the counts and no runner, group or engine; an administrator also gets the runner detail", async () => {
    const w = world();
    runner(w, "runner-secret");
    await mission(w, "one", true);
    const member = await viewer(w);
    expect(member.scopes).not.toContain("runner:admin");

    const seen = await overview(w, member);
    expect(seen.missions.open).toBe(1);
    expect(seen.runners).toEqual({ registered: 1, online: 1, slotsUsed: 0, slotsTotal: 2 });
    expect(JSON.stringify(seen)).not.toMatch(/runner-secret|agents|fixture|detail/u);

    expect(w.owner.scopes).toContain("runner:admin");
    const admin = await overview(w);
    expect(admin.runners.detail).toEqual([{ runnerId: "runner-secret", group: "agents", status: "idle", slotsUsed: 0, slotsTotal: 2 }]);
  });

  it("is refused to someone who is not a member of the workspace", async () => {
    const w = world();
    seedHuman(w.brain, w.org, "stranger-1");
    await expect(overview(w, w.actor("stranger-1", w.workspaceId))).rejects.toThrow(/workspace|forbidden|denied|scope/iu);
  });
});
