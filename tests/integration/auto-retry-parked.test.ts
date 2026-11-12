import { describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, PlanTask, WorkItem } from "@brain/contracts";
import { goldenDocs, setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const task = (id: string, dependsOn: string[] = []): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn });
const releaseWith = (w: World, source: string) => { const staged = w.brain.stageRelease(w.owner, goldenDocs(), `sha256:${source.repeat(64)}`); return staged.digest; };

describe("parked work heals itself once per activated release", () => {
  it("retries parked work when a release is activated, never twice for the same release, and parks it again if it fails again", async () => {
    const w = setupWorld();
    const first = releaseWith(w, "a");
    const second = releaseWith(w, "b");
    const third = releaseWith(w, "c");
    expect(new Set([first, second, third]).size).toBe(3);
    w.brain.activateRelease(w.owner, first);
    const id = (await run(w, w.owner, "mission.create", "heal-create", { title: "Heal", intent: "Deliver", successCriteria: ["delivered"] })).resourceId ?? "";
    const planId = (await run(w, w.owner, "plan.propose", "heal-plan", { missionId: id, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
    const missionVersion = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot.version;
    await run(w, w.owner, "plan.confirm", "heal-confirm", { planVersionId: planId }, missionVersion);
    const item = async () => (await workView(w)).items.find((entry) => entry.planTaskId === "a") as WorkItem;
    const park = async (prefix: string) => {
      for (const runId of [`${prefix}-1`, `${prefix}-2`, `${prefix}-3`]) {
        w.brain.missions.linkExecution(w.owner, w.workspaceId, (await item()).workItemId, runId);
        w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, `failed in ${runId}`);
      }
    };
    await park("old");
    expect(await item()).toMatchObject({ state: "blocked", parked: true, failedAttempts: 3 });

    // A new release: the parked task is retried on its own, with the counter reset, and the audit trail says it was automatic.
    w.brain.activateRelease(w.owner, second, first);
    expect(await item()).toMatchObject({ state: "ready", parked: false, failedAttempts: 0 });
    const events = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT payload_json FROM events WHERE event_type='workItem.unparked'").all() as Array<{ payload_json: string }>;
    expect(events.some((event) => JSON.parse(event.payload_json).automatic === true)).toBe(true);
    // It fails three more times and parks again; re-activating the very same release does not retry it again.
    await park("new");
    expect(await item()).toMatchObject({ state: "blocked", parked: true });
    w.brain.activateRelease(w.owner, second, second);
    expect(await item()).toMatchObject({ state: "blocked", parked: true });
    // Another release is another chance.
    w.brain.activateRelease(w.owner, third, second);
    expect(await item()).toMatchObject({ state: "ready", parked: false });
    w.brain.close();
  });

  it("leaves parked work of a paused mission alone", async () => {
    const w = setupWorld();
    const first = releaseWith(w, "d");
    const second = releaseWith(w, "e");
    w.brain.activateRelease(w.owner, first);
    const id = (await run(w, w.owner, "mission.create", "heal-paused", { title: "Paused", intent: "Deliver", successCriteria: ["delivered"] })).resourceId ?? "";
    const planId = (await run(w, w.owner, "plan.propose", "heal-paused-plan", { missionId: id, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
    const get = async () => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot.version;
    await run(w, w.owner, "plan.confirm", "heal-paused-confirm", { planVersionId: planId }, await get());
    for (const runId of ["p-1", "p-2", "p-3"]) {
      const current = (await workView(w)).items.find((entry) => entry.planTaskId === "a") as WorkItem;
      w.brain.missions.linkExecution(w.owner, w.workspaceId, current.workItemId, runId);
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, "failed");
    }
    await run(w, w.owner, "mission.pause", "heal-pause", { missionId: id }, await get());
    w.brain.activateRelease(w.owner, second, first);
    expect(((await workView(w)).items.find((entry) => entry.planTaskId === "a") as WorkItem)).toMatchObject({ state: "blocked", parked: true });
    w.brain.close();
  });

  it("lets a person re-plan a parked task (run it with another recipe) and replaces the parked item, while running work stays untouched", async () => {
    const w = setupWorld();
    w.brain.activateRelease(w.owner, releaseWith(w, "f"));
    const id = (await run(w, w.owner, "mission.create", "heal-replan", { title: "Replan", intent: "Deliver", successCriteria: ["delivered"] })).resourceId ?? "";
    const planId = (await run(w, w.owner, "plan.propose", "heal-replan-plan", { missionId: id, origin: "manual", tasks: [task("a"), task("b")] })).resourceId ?? "";
    const version = async () => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot.version;
    await run(w, w.owner, "plan.confirm", "heal-replan-confirm", { planVersionId: planId }, await version());
    const items = async () => (await workView(w)).items as WorkItem[];
    const a = () => items().then((all) => all.filter((entry) => entry.planTaskId === "a"));
    for (const runId of ["r-1", "r-2", "r-3"]) {
      w.brain.missions.linkExecution(w.owner, w.workspaceId, (await a()).at(-1)!.workItemId, runId);
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, "the agent could not reach the containers");
    }
    // b is running: replanning may never touch it.
    w.brain.missions.linkExecution(w.owner, w.workspaceId, (await items()).find((entry) => entry.planTaskId === "b")!.workItemId, "r-b");
    const parkedId = (await a())[0]!.workItemId;
    expect((await a())[0]).toMatchObject({ state: "blocked", parked: true });
    const revised = (await run(w, w.owner, "plan.propose", "heal-replan-revise", { missionId: id, origin: "manual", tasks: [{ ...task("a"), workflowId: "sre-task" }, task("b")] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "heal-replan-reconfirm", { planVersionId: revised }, await version());
    const after = await items();
    expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT state FROM work_items WHERE id=?").get(parkedId)).toEqual({ state: "abandoned" });
    expect(after.filter((entry) => entry.planTaskId === "a" && entry.state !== "abandoned")).toEqual([expect.objectContaining({ workflowId: "sre-task", parked: false })]);
    expect(after.find((entry) => entry.planTaskId === "b")?.state).toBe("in-progress");
    // Changing running work is still refused.
    await expect(Promise.resolve().then(async () => await run(w, w.owner, "plan.propose", "heal-replan-b", { missionId: id, origin: "manual", tasks: [{ ...task("a"), workflowId: "sre-task" }, { ...task("b"), title: "changed" }] }))).rejects.toThrow(/started work: b/);
    w.brain.close();
  });
});
