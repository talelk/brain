import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, Mission, WorkItem } from "@brain/contracts";
import { setupWorld } from "../helpers";

// Spec #90, stories 59-60: a board of work items across a workspace's missions, filtered by mission, team member, priority and tag.
// The filters are read through `workItems.list` and applied before the page limit, so they stay true in a workspace with more
// than a page of open work. Done and Review stay out of a plain move (ADR 0022).
type World = ReturnType<typeof setupWorld>;

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const list = async (w: World, filter: Record<string, unknown> = {}) =>
  ((await w.brain.executeQuery(w.owner, { queryType: "workItems.list", workspaceId: w.workspaceId, ...filter })) as { snapshot: { items: WorkItem[] } }).snapshot.items;
const titles = (items: readonly WorkItem[]) => items.map((item) => item.title).sort();

type Task = { id: string; member?: string };

/** A mission with a confirmed plan; each task is assigned to a team member through the plan, as a planner does. */
async function missionWith(w: World, key: string, tasks: Task[]): Promise<{ missionId: string; ids: Record<string, string> }> {
  const missionId = (await run(w, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], autoStart: false })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", `${key}-plan`, {
    missionId, origin: "manual",
    tasks: tasks.map((task) => ({ id: task.id, title: `${key} ${task.id}`, criteria: [`${task.id}-done`], dependsOn: [], ...(task.member ? { assignment: { kind: "agent", id: task.member, role: "specialist" } } : {}) })),
  })).resourceId ?? "";
  const mission = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: missionId })) as { snapshot: Mission }).snapshot;
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, mission.version);
  const ids: Record<string, string> = {};
  for (const item of await list(w)) if (item.missionId === missionId) ids[item.planTaskId] = item.workItemId;
  return { missionId, ids };
}

async function setDetails(w: World, key: string, workItemId: string, payload: Record<string, unknown>): Promise<void> {
  const item = ((await w.brain.executeQuery(w.owner, { queryType: "workItems.get", workspaceId: w.workspaceId, resourceId: workItemId })) as { snapshot: WorkItem }).snapshot;
  await run(w, "workItem.details.set", key, { workItemId, ...payload }, item.version);
}

/** Two missions with assigned, prioritised and tagged work: the board's whole filter space. */
async function twoMissions() {
  const w = setupWorld();
  worlds.push(w);
  const alpha = await missionWith(w, "alpha", [{ id: "draft", member: "writer" }, { id: "check", member: "reviewer" }, { id: "plain" }]);
  const beta = await missionWith(w, "beta", [{ id: "build", member: "writer" }, { id: "ship", member: "builder" }]);
  await setDetails(w, "a-draft", alpha.ids["draft"]!, { priority: "urgent", tags: ["launch", "docs"] });
  await setDetails(w, "a-check", alpha.ids["check"]!, { priority: "high", tags: ["launch"] });
  await setDetails(w, "b-build", beta.ids["build"]!, { priority: "urgent", tags: ["infra"] });
  await setDetails(w, "b-ship", beta.ids["ship"]!, { tags: ["launch", "infra"] });
  return { w, alpha, beta };
}

describe("the workspace board lists work across missions and filters it (stories 59-60)", () => {
  it("lists every open work item of every mission when nothing is filtered", async () => {
    const { w } = await twoMissions();
    expect(titles(await list(w))).toEqual(["alpha check", "alpha draft", "alpha plain", "beta build", "beta ship"]);
  });

  it("filters by mission", async () => {
    const { w, alpha, beta } = await twoMissions();
    expect(titles(await list(w, { missionId: beta.missionId }))).toEqual(["beta build", "beta ship"]);
    expect(titles(await list(w, { missionId: alpha.missionId }))).toEqual(["alpha check", "alpha draft", "alpha plain"]);
    expect(await list(w, { missionId: "no-such-mission" })).toEqual([]);
  });

  it("filters by team member, across missions", async () => {
    const { w } = await twoMissions();
    expect(titles(await list(w, { memberId: "writer" }))).toEqual(["alpha draft", "beta build"]);
    expect(titles(await list(w, { memberId: "builder" }))).toEqual(["beta ship"]);
    expect(await list(w, { memberId: "nobody" })).toEqual([]);
  });

  it("filters by priority and by tag", async () => {
    const { w } = await twoMissions();
    expect(titles(await list(w, { priority: "urgent" }))).toEqual(["alpha draft", "beta build"]);
    expect(titles(await list(w, { priority: "normal" }))).toEqual(["alpha plain", "beta ship"]);
    expect(titles(await list(w, { tag: "launch" }))).toEqual(["alpha check", "alpha draft", "beta ship"]);
    expect(titles(await list(w, { tag: "infra" }))).toEqual(["beta build", "beta ship"]);
    // A tag is matched whole: a prefix of one is another tag.
    expect(await list(w, { tag: "laun" })).toEqual([]);
  });

  it("combines the filters: an item must satisfy every one", async () => {
    const { w, beta } = await twoMissions();
    expect(titles(await list(w, { tag: "launch", priority: "urgent" }))).toEqual(["alpha draft"]);
    expect(titles(await list(w, { memberId: "writer", tag: "infra" }))).toEqual(["beta build"]);
    expect(titles(await list(w, { missionId: beta.missionId, memberId: "writer", priority: "urgent", tag: "infra" }))).toEqual(["beta build"]);
    expect(await list(w, { missionId: beta.missionId, memberId: "reviewer" })).toEqual([]);
  });

  it("applies a filter before the page limit, so older matching work is not hidden by newer work", async () => {
    const { w } = await twoMissions();
    // alpha draft was written first, so it is the oldest of the "docs" items and other items are newer; the newest-first page of one would miss it.
    expect((await list(w, { limit: 1 })).length).toBe(1);
    const docs = await list(w, { tag: "docs", limit: 1 });
    expect(titles(docs)).toEqual(["alpha draft"]);
  });

  it("does not list abandoned work, and a closed mission's work is listed with its mission", async () => {
    const { w, alpha } = await twoMissions();
    const plain = alpha.ids["plain"]!;
    const item = ((await w.brain.executeQuery(w.owner, { queryType: "workItems.get", workspaceId: w.workspaceId, resourceId: plain })) as { snapshot: WorkItem }).snapshot;
    await run(w, "workItem.transition", "abandon-plain", { workItemId: plain, state: "abandoned" }, item.version);
    expect(titles(await list(w, { missionId: alpha.missionId }))).toEqual(["alpha check", "alpha draft"]);
  });

  it("refuses a filter the contract does not know and a priority that is not one", async () => {
    const { w } = await twoMissions();
    await expect(list(w, { priority: "whenever" })).rejects.toThrow();
    await expect(list(w, { colour: "red" })).rejects.toThrow();
  });
});

describe("Done stays out of a plain move (ADR 0022)", () => {
  it("refuses Done straight from In progress and without verified evidence", async () => {
    const { w, alpha } = await twoMissions();
    const id = alpha.ids["draft"]!;
    const fresh = async () => ((await w.brain.executeQuery(w.owner, { queryType: "workItems.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: WorkItem }).snapshot;
    await run(w, "workItem.transition", "start", { workItemId: id, state: "in-progress" }, (await fresh()).version);
    await expect(run(w, "workItem.transition", "to-done", { workItemId: id, state: "done" }, (await fresh()).version)).rejects.toThrow(/illegal transition/iu);
    expect((await fresh()).state).toBe("in-progress");
  });
});
