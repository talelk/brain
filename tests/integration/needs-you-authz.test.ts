import { afterEach, describe, expect, it } from "vitest";
import type { AttentionItem, Mission, PlanTask } from "@brain/contracts";
import { setupWorld, seedHuman } from "../helpers";
import { command, getMission } from "../support/reuse";

type World = ReturnType<typeof setupWorld>;
let world: World | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

/**
 * #51: the Needs you queue shows an item to anyone who can read the workspace, but the inline actions
 * are the existing commands, so a person without the scope is refused by the Governor, not only by a disabled button.
 */
describe("Needs you: seeing is not acting", () => {
  it("a viewer sees a plan proposal and a parked task in attention.list, and every inline command is refused", async () => {
    world = setupWorld();
    const w = world;
    seedHuman(w.brain, w.org, "viewer-1");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'viewer-1', 'viewer', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    const viewer = w.actor("viewer-1", w.workspaceId);

    const missionId = (await command(w, w.owner, "mission.create", "m-create", { title: "Queue mission", intent: "Decide things", successCriteria: ["done"] })).resourceId ?? "";
    const task: PlanTask = { id: "t", title: "Do it", criteria: ["done"], dependsOn: [] };
    const planId = (await command(w, w.owner, "plan.propose", "m-plan", { missionId, origin: "manual", tasks: [task] })).resourceId ?? "";

    const attention = async (): Promise<AttentionItem[]> =>
      ((await w.brain.executeQuery(viewer, { queryType: "attention.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: AttentionItem[] } }).snapshot.items;
    expect((await attention()).map((item) => item.kind)).toContain("plan-proposal");

    const mission: Mission = await getMission(w, missionId);
    await expect(command(w, viewer, "plan.confirm", "v-confirm", { planVersionId: planId }, mission.version)).rejects.toThrow(/scope|forbidden|denied/i);
    await expect(command(w, viewer, "plan.reject", "v-reject", { planVersionId: planId, reason: "no" })).rejects.toThrow(/scope|forbidden|denied/i);
    // Nothing changed: the proposal is still waiting, and the owner can decide it.
    expect((await attention()).map((item) => item.kind)).toContain("plan-proposal");
    expect((await command(w, w.owner, "plan.confirm", "o-confirm", { planVersionId: planId }, mission.version)).accepted).toBe(true);

    const item = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id, version FROM work_items WHERE mission_id=?").get(missionId) as { id: string; version: number };
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE work_items SET state='blocked', parked=1, parked_diagnostic='stuck' WHERE id=?").run(item.id);
    expect((await attention()).map((entry) => entry.kind)).toContain("parked");
    await expect(command(w, viewer, "workItem.transition", "v-retry", { workItemId: item.id, state: "ready" }, item.version)).rejects.toThrow(/scope|forbidden|denied/i);
    await expect(command(w, viewer, "mission.close", "v-close", { missionId, outcome: "ended" }, (await getMission(w, missionId)).version)).rejects.toThrow(/scope|forbidden|denied/i);
  });
});
