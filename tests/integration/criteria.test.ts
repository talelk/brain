import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask, PlanVersion } from "@brain/contracts";
import { setupWorld, workView } from "../helpers";
import { finishTask } from "../support/finish-task";

// ADR 0034: success criteria have stable ids, plan tasks name the ones they serve, and the mission read says where each one stands.
type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: Mission }).snapshot;
const plan = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "plans.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: PlanVersion }).snapshot;
const task = (id: string, serves: string[] = [], dependsOn: string[] = []): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn, ...(serves.length ? { criterionIds: serves } : {}) });
const agent = (w: World): ActorContext => ({ ...w.owner, kind: "agent" });
const coverage = async (w: World, id: string) => (await mission(w, id)).successCriteria.map((criterion) => `${criterion.criterionId}:${criterion.state}:${criterion.serving.done}/${criterion.serving.total}`);

function world(): World { const w = setupWorld(); worlds.push(w); return w; }

async function create(w: World, key: string, criteria = ["Facts are listed", "A recommendation is made", "Risks are named"]): Promise<string> {
  return (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: criteria, autoStart: false })).resourceId ?? "";
}
async function confirm(w: World, id: string, key: string, tasks: PlanTask[], actor: ActorContext = w.owner): Promise<string> {
  const planId = (await run(w, actor, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  return planId;
}
const finish = (w: World, missionId: string, taskId: string, digestChar: string): Promise<void> => finishTask(w, missionId, taskId, digestChar);

describe("success criteria with stable ids (ADR 0034)", () => {
  it("gives each criterion an id by position and keeps it across brief versions and plan versions", async () => {
    const w = world();
    const id = await create(w, "stable");
    expect((await mission(w, id)).successCriteria.map((criterion) => [criterion.criterionId, criterion.text])).toEqual([["c1", "Facts are listed"], ["c2", "A recommendation is made"], ["c3", "Risks are named"]]);
    await run(w, w.owner, "mission.brief.edit", "stable-edit", { missionId: id, baseVersion: 1, intent: "Deliver it differently" });
    await confirm(w, id, "stable-v1", [task("a", ["c1"])]);
    await confirm(w, id, "stable-v2", [task("a", ["c1"]), task("b", ["c2"])]);
    const after = await mission(w, id);
    expect(after.briefVersion).toBe(2);
    expect(after.successCriteria.map((criterion) => criterion.criterionId)).toEqual(["c1", "c2", "c3"]);
  });

  it("refuses a plan task that serves a criterion the mission does not have, and offers the real ones", async () => {
    const w = world();
    const id = await create(w, "unknown");
    await expect(run(w, w.owner, "plan.propose", "unknown-plan", { missionId: id, origin: "manual", tasks: [task("a", ["c1", "c9"])] })).rejects.toThrow(/unknown success criterion c9/);
    const accepted = await run(w, w.owner, "plan.propose", "unknown-ok", { missionId: id, origin: "manual", tasks: [task("a", ["c1", "c3"])] });
    expect(accepted.accepted).toBe(true);
    expect((await plan(w, accepted.resourceId ?? "")).tasks[0]?.criterionIds).toEqual(["c1", "c3"]);
  });

  it("reads coverage against the criteria: no task serving, serving but unfinished, covered when every serving task is done", async () => {
    const w = world();
    const id = await create(w, "coverage");
    expect(await coverage(w, id)).toEqual(["c1:not-covered:0/0", "c2:not-covered:0/0", "c3:not-covered:0/0"]);
    await confirm(w, id, "coverage", [task("a", ["c1"]), task("b", ["c1", "c2"], ["a"])]);
    expect(await coverage(w, id)).toEqual(["c1:not-covered:0/2", "c2:not-covered:0/1", "c3:not-covered:0/0"]);
    await finish(w, id, "a", "a");
    expect(await coverage(w, id)).toEqual(["c1:not-covered:1/2", "c2:not-covered:0/1", "c3:not-covered:0/0"]);
    await finish(w, id, "b", "b");
    expect(await coverage(w, id)).toEqual(["c1:covered:2/2", "c2:covered:1/1", "c3:not-covered:0/0"]);
  });

  it("keeps coverage after a replan retains finished work: it is read from the confirmed plan, not the item's old plan version", async () => {
    const w = world();
    const id = await create(w, "replan");
    await confirm(w, id, "replan-1", [task("a", ["c1"])]);
    await finish(w, id, "a", "c");
    const retained = (await workView(w)).items.find((entry) => entry.missionId === id)!;
    await confirm(w, id, "replan-2", [task("a", ["c1"]), task("b", ["c2"], ["a"])]);
    expect((await workView(w)).items.find((entry) => entry.missionId === id && entry.planTaskId === "a" && entry.state !== "abandoned")?.workItemId).toBe(retained.workItemId);
    expect(await coverage(w, id)).toEqual(["c1:covered:1/1", "c2:not-covered:0/1", "c3:not-covered:0/0"]);
  });

  it("lets a person relink finished work without touching it, but an agent needs the policy to allow the change", async () => {
    const w = world();
    const id = await create(w, "relink");
    await confirm(w, id, "relink-1", [task("a", ["c1"])]);
    await finish(w, id, "a", "d");
    const before = (await workView(w)).items.find((entry) => entry.missionId === id)!;
    await confirm(w, id, "relink-2", [task("a", ["c1", "c3"])]);
    const after = (await workView(w)).items.find((entry) => entry.missionId === id && entry.state !== "abandoned")!;
    expect(after.workItemId).toBe(before.workItemId);
    expect(after.state).toBe("done");
    expect(await coverage(w, id)).toEqual(["c1:covered:1/1", "c2:not-covered:0/0", "c3:covered:1/1"]);

    // A supervised mission lets a coordinator propose a relink but not confirm it: claiming coverage for finished work stays a person's call.
    const supervised = await create(w, "relink-supervised");
    await confirm(w, supervised, "relink-s1", [task("a", ["c1"])]);
    await run(w, w.owner, "mission.policy.set", "relink-s-policy", { missionId: supervised, preset: "supervised" }, (await mission(w, supervised)).version);
    const proposal = await run(w, agent(w), "plan.propose", "relink-s2", { missionId: supervised, origin: "agent", tasks: [task("a", ["c1", "c2"])] });
    expect((await plan(w, proposal.resourceId ?? "")).state).toBe("proposed");
    expect(await coverage(w, supervised)).toEqual(["c1:not-covered:0/1", "c2:not-covered:0/0", "c3:not-covered:0/0"]);
    // The standard preset allows task.change, so the same proposal confirms by itself.
    const standard = await create(w, "relink-standard");
    await confirm(w, standard, "relink-t1", [task("a", ["c1"])]);
    const auto = await run(w, agent(w), "plan.propose", "relink-t2", { missionId: standard, origin: "agent", tasks: [task("a", ["c1", "c2"])] });
    expect((await plan(w, auto.resourceId ?? "")).state).toBe("confirmed");
  });
});
