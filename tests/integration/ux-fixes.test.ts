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
const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [] });

describe("parked work in the read models", () => {
  it("shows why a task is parked on the work item and counts it as blocked in the workspace summary", async () => {
    const w = setupWorld();
    w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, goldenDocs(), `sha256:${"a".repeat(64)}`).digest);
    const id = (await run(w, w.owner, "mission.create", "ux-create", { title: "Parked", intent: "Deliver", successCriteria: ["delivered"] })).resourceId ?? "";
    const planId = (await run(w, w.owner, "plan.propose", "ux-plan", { missionId: id, origin: "manual", tasks: [task("a")] })).resourceId ?? "";
    const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot.version;
    await run(w, w.owner, "plan.confirm", "ux-confirm", { planVersionId: planId }, version);
    const summary = async () => ((await w.brain.executeQuery(w.owner, { queryType: "bridge" } as never)) as unknown as { snapshot: { items: Array<{ workspaceId: string; blockedJobs: number; health: string }> } }).snapshot.items.find((item) => item.workspaceId === w.workspaceId)!;
    expect((await summary()).blockedJobs).toBe(0);
    for (const runId of ["ux-1", "ux-2", "ux-3"]) {
      const current = (await workView(w)).items.find((entry) => entry.planTaskId === "a") as WorkItem;
      w.brain.missions.linkExecution(w.owner, w.workspaceId, current.workItemId, runId);
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, "Step respond failed");
    }
    const parked = (await workView(w)).items.find((entry) => entry.planTaskId === "a") as WorkItem;
    expect(parked).toMatchObject({ state: "blocked", parked: true });
    // The reason a person needs is on the item itself, not only in the attention list.
    expect(parked.parkedDiagnostic).toContain("Step respond failed");
    // A workspace with a parked task is not "healthy with nothing waiting".
    expect(await summary()).toMatchObject({ blockedJobs: 1, health: "degraded" });
    w.brain.close();
  });
});
