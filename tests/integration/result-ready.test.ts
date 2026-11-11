import { describe, expect, it } from "vitest";
import type { ActorContext, AttentionItem, CommandReceipt, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [] });
const query = async <T>(w: World, queryType: string, resourceId?: string) => ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as { snapshot: T }).snapshot;
const getMission = (w: World, id: string) => query<Mission>(w, "missions.get", id);

async function mission(w: World, key: string, tasks: PlanTask[], confirm = true): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  if (confirm) await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await getMission(w, id)).version);
  return id;
}
const attention = async (w: World) => (await query<{ items: AttentionItem[] }>(w, "attention.list")).items;

describe("result-ready attention item (#52, ADR 0005)", () => {
  it("appears when a task is Done, sits below every blocking tier and never blocks closing", async () => {
    const w = setupWorld();
    const proposal = await mission(w, "waiting", [task("p")], false);
    const id = await mission(w, "finish", [task("a")]);
    expect((await attention(w)).some((item) => item.kind === "result-ready")).toBe(false);
    const a = (await workView(w)).items.find((item) => item.missionId === id) as WorkItem;
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    db.prepare("UPDATE work_items SET state='done', evidence_digest=?, updated_at_ms=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, w.brain.store.now(), a.workItemId);
    const items = await attention(w);
    expect(items.map((item) => [item.kind, item.tier, item.missionId])).toEqual([["plan-proposal", 3, proposal], ["result-ready", 6, id]]);
    expect(items[1]).toMatchObject({ title: expect.stringContaining("Result ready"), resourceId: a.workItemId });

    // The item is not consulted by any command: the mission still goes through verdict and close.
    await run(w, w.owner, "mission.proposeCompletion", "finish-propose", { missionId: id }, (await getMission(w, id)).version);
    const bundle = await query<{ digest: string }>(w, "missionBundles.latest", id);
    await run(w, w.owner, "mission.verdict.record", "finish-verdict", { missionId: id, bundleDigest: bundle.digest, outcome: "verified" });
    await run(w, w.owner, "mission.close", "finish-close", { missionId: id, outcome: "achieved" }, (await getMission(w, id)).version);
    expect(await getMission(w, id)).toMatchObject({ state: "closed", outcome: "achieved" });
    const after = await attention(w);
    expect(after.filter((item) => item.kind === "result-ready").map((item) => [item.resourceId, item.title])).toEqual([[id, "Result ready: finish"]]);
    expect(after.at(-1)?.kind).toBe("result-ready");

    // Derived and time-limited: a day later it is gone.
    db.prepare("UPDATE missions SET updated_at_ms=updated_at_ms-?").run(25 * 3_600_000);
    expect((await attention(w)).some((item) => item.kind === "result-ready")).toBe(false);
    w.brain.close();
  });

  it("notifies in-app once, throttled per mission, without delaying a blocking item; progress never notifies", async () => {
    const w = setupWorld();
    const id = await mission(w, "notify", [task("a"), task("b"), task("c")]);
    // Progress: a brief edit and a budget change are events, not attention items.
    await run(w, w.owner, "mission.brief.edit", "notify-brief", { missionId: id, baseVersion: 1, constraints: ["Stay in the EU"] });
    expect(w.brain.notifyAttention()).toBe(0);
    const [a, b] = (await workView(w)).items.filter((item) => item.missionId === id).sort((x, y) => x.planTaskId.localeCompare(y.planTaskId)) as [WorkItem, WorkItem];
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const finish = (item: WorkItem) => db.prepare("UPDATE work_items SET state='done', evidence_digest=?, updated_at_ms=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, w.brain.store.now(), item.workItemId);
    finish(a);
    expect(w.brain.notifyAttention()).toBe(1);
    const inbox = async () => (await query<{ items: Array<{ title: string; itemId: string }> }>(w, "notifications.list")).items;
    expect((await inbox()).map((entry) => entry.title)).toEqual(["Result ready: Task a is verified and done"]);
    // A second result within 15 minutes is throttled; the inbox does not grow.
    finish(b);
    expect(w.brain.notifyAttention()).toBe(0);
    // A blocking item right after good news still gets through.
    const parkedItem = (await workView(w)).items.find((item) => item.missionId === id && item.planTaskId === "c") as WorkItem;
    for (const runId of ["n1", "n2", "n3"]) {
      w.brain.missions.linkExecution(w.owner, w.workspaceId, parkedItem.workItemId, runId);
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, `tests failed in ${runId}`);
    }
    expect(w.brain.notifyAttention()).toBe(1);
    expect((await inbox()).map((entry) => entry.itemId.split(":")[0])).toEqual(expect.arrayContaining(["result", "stuck"]));
    expect(w.brain.notifyAttention()).toBe(0);
    w.brain.close();
  });
});
