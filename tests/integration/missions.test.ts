import { describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, MissionBrief, PlanTask, PlanVersion, WorkItem } from "@brain/contracts";
import { setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const fails = async (fn: () => Promise<unknown>, pattern: RegExp) => await expect(Promise.resolve().then(fn)).rejects.toThrow(pattern);
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const brief = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.brief", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: MissionBrief }).snapshot;
const plan = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "plans.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: PlanVersion }).snapshot;
const task = (id: string, dependsOn: string[] = [], extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn, ...extra });
const coordinator = (w: World): ActorContext => ({ ...w.owner, kind: "agent" });

async function confirmedMission(w: World, key: string, tasks: PlanTask[], autonomy?: string): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], constraints: ["No production writes"], ...(autonomy ? { autonomy } : {}) })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  return id;
}

describe("missions (T51)", () => {
  it("starts active with brief v1, the standard autonomy preset and its constraints", async () => {
    const w = setupWorld();
    const id = (await run(w, w.owner, "mission.create", "m-create", { title: "Stabilize auth", intent: "Fix session expiry", successCriteria: ["sessions survive"], constraints: ["Keep the public API"] })).resourceId ?? "";
    const created = await mission(w, id);
    expect(created).toMatchObject({ state: "active", briefVersion: 1, autonomyPolicy: { preset: "standard", version: 1 } });
    expect(await brief(w, id)).toMatchObject({ version: 1, intent: "Fix session expiry", constraints: ["Keep the public API"], decisions: [], progress: { total: 0 } });
    w.brain.close();
  });

  it("stale expected versions conflict without overwriting (E009)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-stale", [task("a")]);
    const current = await mission(w, id);
    await run(w, w.owner, "mission.pause", "m-stale-pause", { missionId: id }, current.version);
    await fails(async () => await run(w, w.owner, "mission.resume", "m-stale-resume", { missionId: id }, current.version), /version|stale|conflict/i);
    expect((await mission(w, id)).state).toBe("paused");
    w.brain.close();
  });

  it("follows the lifecycle: paused and verifying missions start no work; closed is terminal", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-life", [task("a"), task("b")]);
    const [first] = (await workView(w)).items;
    await run(w, w.owner, "mission.pause", "m-life-pause", { missionId: id }, (await mission(w, id)).version);
    expect(await mission(w, id)).toMatchObject({ state: "paused", pauseReason: "human" });
    expect(() => w.brain.missions.linkExecution(w.owner, w.workspaceId, first!.workItemId, "run-paused")).toThrow(/paused mission starts no new work/);
    await run(w, w.owner, "mission.resume", "m-life-resume", { missionId: id }, (await mission(w, id)).version);
    w.brain.missions.linkExecution(w.owner, w.workspaceId, first!.workItemId, "run-active");
    await run(w, coordinator(w), "mission.proposeCompletion", "m-life-verify", { missionId: id }, (await mission(w, id)).version);
    expect((await mission(w, id)).state).toBe("verifying");
    await fails(async () => await run(w, w.owner, "mission.close", "m-life-achieved", { missionId: id, outcome: "achieved" }, (await mission(w, id)).version), /verified mission verdict/);
    w.brain.missions.returnToActive(w.owner, w.workspaceId, id);
    expect((await mission(w, id)).state).toBe("active");
    await run(w, w.owner, "mission.close", "m-life-cancel", { missionId: id, outcome: "cancelled" }, (await mission(w, id)).version);
    expect(await mission(w, id)).toMatchObject({ state: "closed", outcome: "cancelled" });
    expect((await workView(w)).items).toEqual([]);
    await fails(async () => await run(w, w.owner, "mission.brief.edit", "m-life-edit", { missionId: id, baseVersion: 1, intent: "Again" }), /terminal/);
    w.brain.close();
  });

  it("humans own intent and constraints; a stale human edit is rebased, never lost (E117)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-brief", [task("a")]);
    await fails(async () => await run(w, coordinator(w), "mission.brief.edit", "m-brief-agent", { missionId: id, baseVersion: 1, intent: "Agent intent" }), /only humans|cannot run/);
    await run(w, coordinator(w), "decision.accept", "m-brief-dec", { missionId: id, baseVersion: 1, statement: "Use Postgres for sessions", source: { kind: "handoff", ref: "handoff-1" } });
    await run(w, w.owner, "mission.brief.edit", "m-brief-human", { missionId: id, baseVersion: 1, constraints: ["No production writes", "Stay within EU regions"] });
    const after = await brief(w, id);
    expect(after.version).toBe(3);
    expect(after.constraints).toEqual(["No production writes", "Stay within EU regions"]);
    expect(after.decisions.map((entry) => entry.statement)).toEqual(["Use Postgres for sessions"]);
    await fails(async () => await run(w, coordinator(w), "decision.accept", "m-brief-stale", { missionId: id, baseVersion: 2, statement: "Use Redis", source: { kind: "handoff" } }), /brief changed since version 2/);
    await fails(async () => await run(w, w.owner, "mission.brief.edit", "m-brief-cap", { missionId: id, baseVersion: 3, intent: "x".repeat(8000) }), /condense/);
    w.brain.close();
  });

  it("accepted decisions are immutable and superseded by later entries", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-dec", [task("a")]);
    const first = (await run(w, w.owner, "decision.accept", "m-dec-1", { missionId: id, baseVersion: 1, statement: "Ship behind a flag", source: { kind: "human" } })).resourceId ?? "";
    await run(w, w.owner, "decision.accept", "m-dec-2", { missionId: id, baseVersion: 2, statement: "Ship to 10% first", source: { kind: "human" }, supersedes: first });
    const decisions = (await brief(w, id)).decisions;
    expect(decisions).toEqual([expect.objectContaining({ decisionId: first, statement: "Ship behind a flag", supersededBy: expect.any(String) }), expect.objectContaining({ statement: "Ship to 10% first" })]);
    await fails(async () => await run(w, w.owner, "decision.accept", "m-dec-3", { missionId: id, baseVersion: 3, statement: "Again", source: { kind: "human" }, supersedes: first }), /active decision/);
    w.brain.close();
  });

  it("a coordinator plan version inside the autonomy policy confirms itself; beyond it stays a proposal (E113)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-gate", [task("a"), task("b", ["a"]), task("c")]);
    const added = (await run(w, coordinator(w), "plan.propose", "m-gate-add", { missionId: id, origin: "agent", tasks: [task("a"), task("b", ["a"]), task("c"), task("d", ["a"])] })).resourceId ?? "";
    expect((await plan(w, added)).state).toBe("confirmed");
    expect((await workView(w)).items.map((item) => item.planTaskId).sort()).toEqual(["a", "b", "c", "d"]);
    const dropped = (await run(w, coordinator(w), "plan.propose", "m-gate-drop", { missionId: id, origin: "agent", tasks: [task("a"), task("b", ["a"]), task("d", ["a"])] })).resourceId ?? "";
    expect((await plan(w, dropped)).state).toBe("proposed");
    await fails(async () => await run(w, coordinator(w), "plan.confirm", "m-gate-self", { planVersionId: dropped }, (await mission(w, id)).version), /human|actor/i);
    await fails(async () => await run(w, coordinator(w), "mission.policy.set", "m-gate-widen", { missionId: id, preset: "autonomous" }, (await mission(w, id)).version), /human|cannot run/i);
    await run(w, w.owner, "plan.confirm", "m-gate-human", { planVersionId: dropped }, (await mission(w, id)).version);
    expect((await plan(w, dropped)).state).toBe("confirmed");
    w.brain.close();
  });

  it("no plan version may change started work, and confirming keeps it running (E114)", async () => {
    const w = setupWorld();
    const id = await confirmedMission(w, "m-started", [task("a"), task("b")]);
    const a = (await workView(w)).items.find((item) => item.planTaskId === "a") as WorkItem;
    w.brain.missions.linkExecution(w.owner, w.workspaceId, a.workItemId, "run-a");
    await fails(async () => await run(w, w.owner, "plan.propose", "m-started-change", { missionId: id, origin: "manual", tasks: [task("a", [], { title: "Task a, revised" }), task("b")] }), /started work: a/);
    await fails(async () => await run(w, coordinator(w), "plan.propose", "m-started-drop", { missionId: id, origin: "agent", tasks: [task("b")] }), /started work: a/);
    const next = (await run(w, w.owner, "plan.propose", "m-started-ok", { missionId: id, origin: "manual", tasks: [task("a"), task("b", [], { title: "Task b, revised" })] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "m-started-reconfirm", { planVersionId: next }, (await mission(w, id)).version);
    const items = (await workView(w)).items;
    expect(items.find((item) => item.workItemId === a.workItemId)?.state).toBe("in-progress");
    expect(items.find((item) => item.planTaskId === "b")?.title).toBe("Task b, revised");
    w.brain.close();
  });
});
