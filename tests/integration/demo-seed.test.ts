import { describe, expect, it } from "vitest";
import { setupWorld, workView } from "../helpers";
import { seedDemoWorkspace } from "../support/seedDemoWorkspace";

describe("demo workspace seed", () => {
  it("covers every work item state, mission states, a pending approval and a dispatched run", async () => {
    const w = setupWorld();
    try {
      await w.brain.auth.ready();
      const seed = await seedDemoWorkspace(w.brain, w.owner, w.workspaceId, { dispatch: { workflowId: "fixture-workflow", input: { message: "Demo run" } } });
      const view = await workView(w);
      const states = new Set(view.items.map((entry) => entry.state));
      expect([...states].sort()).toEqual(["backlog", "blocked", "done", "in-progress", "ready", "review"]);
      expect(Object.keys(seed.workItems).sort()).toEqual(["abandoned", "backlog", "blocked", "done", "in-progress", "ready", "review"]);
      expect(seed.run?.sessionId).toBeTruthy();
      const missions = (await w.brain.executeQuery(w.owner, { queryType: "missions.list", workspaceId: w.workspaceId }) as unknown as { snapshot: { items: { state: string }[] } }).snapshot.items;
      expect(missions.map((mission) => mission.state).sort()).toEqual(["active", "closed", "paused"]);
    } finally { w.brain.close(); }
  });
});
