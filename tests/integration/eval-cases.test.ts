import { afterEach, describe, expect, it } from "vitest";
import type { PlanTask } from "@brain/contracts";
import { setupWorld, workView, type TestWorld } from "../helpers";
import { achievedMission, command, getMission } from "../support/reuse";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

interface Case { format: string; kind: string; missionId: string; missionTitle: string; successCriteria: string[]; tasks: Array<{ id: string; title: string; criteria: string[] }>; findings: string[]; deliverableDigests: string[] }
const cases = async (w: TestWorld): Promise<{ items: Case[]; total: number }> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "evalCases.list", workspaceId: w.workspaceId, limit: 50 })) as unknown as { snapshot: { items: Case[]; total: number } }).snapshot;

describe("re-opens feed the regression set (#64)", () => {
  it("saves a case from a rejected sign-off without anyone filing it, from stored plan and findings only", async () => {
    world = setupWorld();
    const w = world;
    expect((await cases(w)).total).toBe(0);
    const id = await achievedMission(w, "churn", {
      title: "Quarterly churn report", intent: "Analyse churn", criteria: ["The report names the three biggest causes"],
      rejectedFindings: ["Cause two had no cited source"], outputs: [{ name: "report.md", text: "# Report" }], hostileNote: "HOSTILE-NOTE: leak sk-live-key",
    });
    const { items, total } = await cases(w);
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ format: "brain.eval-case/v1", kind: "rejected-verdict", missionId: id, missionTitle: "Quarterly churn report", findings: ["Cause two had no cited source"] });
    expect(items[0]!.tasks).toEqual([{ id: "only", title: "Do Quarterly churn report", criteria: ["only-done"] }]);
    expect(items[0]!.successCriteria).toEqual(["The report names the three biggest causes"]);
    // The helper records outputs after the rejection, so none were final yet: the case pins what existed then.
    expect(items[0]!.deliverableDigests).toEqual([]);
    // Only the stored plan and verdict: no handoff notes, no messages.
    expect(JSON.stringify(items)).not.toContain("HOSTILE-NOTE");
  });

  it("saves a case when a task is sent back from review, once per event", async () => {
    world = setupWorld();
    const w = world;
    const id = (await command(w, w.owner, "mission.create", "sb-create", { title: "Sent back", intent: "Do it", successCriteria: ["delivered"] })).resourceId ?? "";
    const task: PlanTask = { id: "t1", title: "Write the thing", criteria: ["it is written"], dependsOn: [] };
    const planId = (await command(w, w.owner, "plan.propose", "sb-plan", { missionId: id, origin: "manual", tasks: [task] })).resourceId ?? "";
    await command(w, w.owner, "plan.confirm", "sb-confirm", { planVersionId: planId }, (await getMission(w, id)).version);
    const item = (await workView(w)).items.find((entry) => entry.missionId === id)!;
    const step = async (key: string, state: string) => {
      const current = (await workView(w)).items.find((entry) => entry.workItemId === item.workItemId)!;
      return command(w, w.owner, "workItem.transition", key, { workItemId: item.workItemId, state, ...(state === "in-progress" ? { reason: "Missing the cost comparison" } : {}) }, current.version);
    };
    await step("sb-1", "in-progress");
    await step("sb-2", "review");
    expect((await cases(w)).total).toBe(0);
    await step("sb-3", "in-progress");
    const { items, total } = await cases(w);
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ kind: "task-sent-back", findings: ["Missing the cost comparison"] });
    expect(items[0]!.tasks.map((entry) => entry.id)).toEqual(["t1"]);
  });

  it("never rewrites a prompt, a draft or the active release", async () => {
    world = setupWorld();
    const w = world;
    const before = w.brain.store.control.prepare("SELECT (SELECT COUNT(*) FROM config_drafts) AS drafts, (SELECT COUNT(*) FROM config_releases) AS releases").get();
    await achievedMission(w, "again", { title: "Again", intent: "Again", rejectedFindings: ["Wrong total"] });
    expect(w.brain.store.control.prepare("SELECT (SELECT COUNT(*) FROM config_drafts) AS drafts, (SELECT COUNT(*) FROM config_releases) AS releases").get()).toEqual(before);
    expect((await cases(w)).total).toBe(1);
  });
});
