import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { FleetOverview } from "@brain/contracts";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { command } from "../support/reuse";
import { scaled } from "../support/timing";

// An approval an agent proposed names its proposing attempt, not a mission. The fleet overview follows it to the mission the attempt serves
// (so that mission needs attention rather than waiting), and counts an approval of a standalone run apart, never as a mission.
let world: EffectsWorld | undefined;
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

const overview = async (w: EffectsWorld): Promise<FleetOverview> =>
  ((await w.w.brain.executeQuery(w.w.owner, { queryType: "fleet.overview", workspaceId: w.w.workspaceId })) as unknown as { snapshot: FleetOverview }).snapshot;

describe("fleet overview: approvals", () => {
  it("a mission whose task waits for an approval needs attention; an approval outside any mission is counted apart", async () => {
    world = await effectsWorld();
    const w = world;
    const missionId = (await w.command("mission.create", "m-create", { title: "Restart the unhealthy app", intent: "Restart demo-app", successCriteria: ["restarted"] })).resourceId!;
    const planId = (await w.command("plan.propose", "m-plan", { missionId, origin: "manual", tasks: [{ id: "a", title: "Restart", criteria: ["restarted"], dependsOn: [] }] })).resourceId!;
    const mission = ((await w.w.brain.executeQuery(w.w.owner, { queryType: "missions.get", workspaceId: w.w.workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot;
    await command(w.w, w.w.owner, "plan.confirm", "m-confirm", { planVersionId: planId }, mission.version);
    const workItemId = (w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id;
    expect((await overview(w)).missions).toMatchObject({ open: 1, waiting: 1, needsAttention: 0 });

    const runId = (await w.dispatch("linked")).resourceId!;
    w.w.brain.missions.linkExecution(w.w.owner, w.w.workspaceId, workItemId, runId);
    expect(await w.run()).toBe(true);
    await w.pendingApproval();
    const waiting = await overview(w);
    expect(waiting.missions).toMatchObject({ open: 1, working: 0, waiting: 0, needsAttention: 1 });
    expect(waiting.attentionOutsideMissions).toBe(0);

    // A standalone run's approval belongs to no mission: the mission count does not move, the item is counted apart.
    await w.dispatch("standalone");
    expect(await w.run()).toBe(true);
    const both = await overview(w);
    expect(both.missions).toMatchObject({ open: 1, needsAttention: 1 });
    expect(both.attentionOutsideMissions).toBe(1);
  }, scaled(120_000));
});
