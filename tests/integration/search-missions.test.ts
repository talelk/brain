import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, QueryResponse } from "@brain/contracts";
import { seedHuman, setupWorld } from "../helpers";

// Spec #90, stories 24-25: the global search finds Missions and Work items by title, only in workspaces the person can read.
type World = ReturnType<typeof setupWorld>;
type Hit = Extract<QueryResponse, { queryType: "search.global" }>["snapshot"]["items"][number];

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, workspaceId: string, key: string, commandType: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.actor("owner-1", workspaceId), {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}

async function missionWithTask(w: World, workspaceId: string, key: string, title: string, task: string): Promise<{ missionId: string }> {
  const missionId = (await run(w, workspaceId, `${key}-create`, "mission.create", { title, intent: `Deliver ${title}`, successCriteria: ["delivered"], autoStart: false })).resourceId ?? "";
  const planId = (await run(w, workspaceId, `${key}-plan`, "plan.propose", { missionId, origin: "manual", tasks: [{ id: "t1", title: task, criteria: ["done"], dependsOn: [] }] })).resourceId ?? "";
  const mission = ((await w.brain.executeQuery(w.actor("owner-1", workspaceId), { queryType: "missions.get", workspaceId, resourceId: missionId })) as { snapshot: { version: number } }).snapshot;
  await run(w, workspaceId, `${key}-confirm`, "plan.confirm", { planVersionId: planId }, mission.version);
  return { missionId };
}

async function search(w: World, who: ReturnType<World["actor"]>, term: string, workspaceId?: string): Promise<Hit[]> {
  return ((await w.brain.executeQuery(who, { queryType: "search.global", search: term, limit: 30, ...(workspaceId ? { workspaceId } : {}) })) as { snapshot: { items: Hit[] } }).snapshot.items;
}

async function twoWorkspaces() {
  const w = setupWorld();
  worlds.push(w);
  w.brain.createWorkspace(w.actor("owner-1"), { workspaceId: "ws-other", slug: "other" });
  const here = await missionWithTask(w, "ws-test", "here", "Quarterly orbit report", "Draft the orbit chapter");
  const there = await missionWithTask(w, "ws-other", "there", "Orbit budget secrets", "Audit the orbit ledger");
  return { w, here, there };
}

describe("global search finds Missions and Work items", () => {
  it("finds a mission and a work item by title, each carrying the address it opens", async () => {
    const { w, here } = await twoWorkspaces();
    const hits = await search(w, w.owner, "orbit", "ws-test");
    const mission = hits.find((hit) => hit.category === "mission");
    const item = hits.find((hit) => hit.category === "workItem");
    expect(mission).toMatchObject({ title: "Quarterly orbit report", resourceId: here.missionId, missionId: here.missionId, workspaceId: "ws-test" });
    expect(item).toMatchObject({ title: "Draft the orbit chapter", missionId: here.missionId, workspaceId: "ws-test" });
    expect(item?.resourceId).toMatch(/\S/u);
    // A mission is listed before its work, so a page limit never crowds missions out.
    expect(hits.indexOf(mission!)).toBeLessThan(hits.indexOf(item!));
  });

  it("matches case-insensitively and finds nothing for a title that does not exist", async () => {
    const { w } = await twoWorkspaces();
    expect((await search(w, w.owner, "QUARTERLY", "ws-test")).map((hit) => hit.category)).toContain("mission");
    expect((await search(w, w.owner, "zzzz-nothing", "ws-test")).filter((hit) => hit.category === "mission" || hit.category === "workItem")).toEqual([]);
  });

  it("never returns work of a workspace the person is not a member of, even when asked for it", async () => {
    const { w, there } = await twoWorkspaces();
    const { actor } = await w.grantApprover("member-1"); // member of ws-test only
    const mine = await search(w, w.actor("member-1", "ws-test"), "orbit");
    expect(mine.every((hit) => hit.workspaceId === "ws-test")).toBe(true);
    expect(mine.map((hit) => hit.title)).toContain("Quarterly orbit report");
    expect(JSON.stringify(mine)).not.toContain("secrets");
    expect(JSON.stringify(mine)).not.toContain(there.missionId);
    await expect(search(w, w.actor("member-1", "ws-other"), "orbit", "ws-other")).rejects.toThrow();
    expect(actor.actorId).toBe("member-1");
  });

  it("returns nothing at all to a person with no workspace membership", async () => {
    const { w } = await twoWorkspaces();
    seedHuman(w.brain, w.org, "stranger-1");
    const hits = await search(w, w.actor("stranger-1"), "orbit");
    expect(hits).toEqual([]);
  });

  it("spans every readable workspace when no workspace is named", async () => {
    const { w } = await twoWorkspaces();
    const hits = await search(w, w.actor("owner-1"), "orbit");
    expect(new Set(hits.filter((hit) => hit.category === "mission").map((hit) => hit.workspaceId))).toEqual(new Set(["ws-test", "ws-other"]));
  });
});
