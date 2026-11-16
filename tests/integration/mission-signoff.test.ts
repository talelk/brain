import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, AttentionItem, CommandReceipt, KnowledgeAsset, Mission, MissionEvidenceBundle, NotificationEntry, PlanTask, WorkItem } from "@brain/contracts";
import { notifyAttention, type Sender } from "../../apps/governor/src/modules/operations/index";
import { setupWorld, workView, type TestWorld } from "../helpers";
import { achievedMission } from "../support/reuse";

// Spec #90, ticket #92: a mission that enters verifying with a complete bundle waits for a person's verdict.
// Everything below reaches state through commands and queries; the one direct write marks the mission's task Done,
// because Done needs a full run-and-evidence chain that these tests do not exercise.
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const run = async (w: TestWorld, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> =>
  (await w.brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
const query = async <T>(w: TestWorld, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const fails = async (fn: () => Promise<unknown>, pattern: RegExp) => await expect(Promise.resolve().then(fn)).rejects.toThrow(pattern);
const getMission = (w: TestWorld, id: string) => query<Mission>(w, "missions.get", id);
const latestBundle = (w: TestWorld, id: string) => query<MissionEvidenceBundle>(w, "missionBundles.latest", id);
const attention = async (w: TestWorld): Promise<AttentionItem[]> => (await query<{ items: AttentionItem[] }>(w, "attention.list")).items;

/** A confirmed one-task mission whose task is Done, so finishing it submits a complete bundle. */
async function finishedMission(w: TestWorld, key: string): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: `Mission ${key}`, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";
  const task: PlanTask = { id: "only", title: `Task ${key}`, criteria: ["only-done"], dependsOn: [] };
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks: [task] })).resourceId ?? "";
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await getMission(w, id)).version);
  const item = (await workView(w)).items.find((entry: WorkItem) => entry.missionId === id) as WorkItem;
  w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, item.workItemId);
  return id;
}
const finish = async (w: TestWorld, id: string, key: string) => {
  await run(w, w.owner, "mission.proposeCompletion", key, { missionId: id }, (await getMission(w, id)).version);
  return latestBundle(w, id);
};
const signOffItems = async (w: TestWorld) => (await attention(w)).filter((item) => item.kind === "sign-off");

describe("mission sign-off (#92)", () => {
  it("a submitted bundle raises one blocking sign-off item that links to the Outputs tab and notifies once per mission", async () => {
    world = setupWorld();
    const w = world;
    const id = await finishedMission(w, "notify");
    expect(await signOffItems(w)).toEqual([]);
    const bundle = await finish(w, id, "notify-finish");
    expect(bundle).toMatchObject({ state: "submitted", complete: true });
    expect((await getMission(w, id)).state).toBe("verifying");

    const items = await signOffItems(w);
    expect(items).toEqual([expect.objectContaining({ id: `signoff:${bundle.digest}`, kind: "sign-off", tier: 4, missionId: id, resourceId: id, title: "Mission notify is ready for sign-off" })]);
    // Blocking: it counts as something a person must act on and sorts above the non-blocking result-ready item.
    const all = await attention(w);
    expect(all.indexOf(items[0]!)).toBeLessThan(all.findIndex((item) => item.kind === "result-ready"));
    expect((await attention(w)).some((item) => item.kind === "verdict-ready")).toBe(false);

    const sent: Array<{ title: string; url: string; kind: string }> = [];
    const send: Sender = async (_org, _principal, message) => { sent.push({ title: message.title, url: message.url, kind: message.kind }); return 1; };
    expect(notifyAttention(w.brain.store, send)).toBe(1);
    expect(notifyAttention(w.brain.store, send)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([{ title: "Mission notify is ready for sign-off", url: `/missions/${id}/outputs?w=${w.workspaceId}`, kind: "sign-off" }]);
    const history = await query<{ items: NotificationEntry[] }>(w, "notifications.list");
    expect(history.items.map((entry) => entry.itemId)).toEqual([`signoff:${bundle.digest}`]);
  });

  it("no item while the bundle is incomplete: the mission returns to work instead", async () => {
    world = setupWorld();
    const w = world;
    const id = (await run(w, w.owner, "mission.create", "early-create", { title: "Early", intent: "Deliver early", successCriteria: ["delivered"] })).resourceId ?? "";
    const planId = (await run(w, w.owner, "plan.propose", "early-plan", { missionId: id, origin: "manual", tasks: [{ id: "a", title: "Task a", criteria: ["a-done"], dependsOn: [] }] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "early-confirm", { planVersionId: planId }, (await getMission(w, id)).version);
    await run(w, w.owner, "mission.proposeCompletion", "early-finish", { missionId: id }, (await getMission(w, id)).version);
    expect(await getMission(w, id)).toMatchObject({ state: "active" });
    expect(await signOffItems(w)).toEqual([]);
  });

  it("only a person records the verdict: an agent and a workflow principal are refused, and the bundle stays submitted", async () => {
    world = setupWorld();
    const w = world;
    const id = await finishedMission(w, "forbid");
    const bundle = await finish(w, id, "forbid-finish");
    for (const kind of ["agent", "workflow", "service"] as const) {
      await fails(async () => await run(w, { ...w.owner, kind }, "mission.verdict.record", `forbid-${kind}`, { missionId: id, bundleDigest: bundle.digest, outcome: "verified" }), /cannot run/);
    }
    expect(await latestBundle(w, id)).toMatchObject({ state: "submitted" });
    expect(await signOffItems(w)).toHaveLength(1);
  });

  it("a rejected verdict needs findings, routes them to the coordinator and sends the mission back to active; a resubmitted bundle raises a new item", async () => {
    world = setupWorld();
    const w = world;
    const id = await finishedMission(w, "reject");
    const first = await finish(w, id, "reject-finish");
    for (const [index, findings] of [undefined, [], ["   "]].entries()) {
      await fails(async () => await run(w, w.owner, "mission.verdict.record", `reject-bare-${index}`, { missionId: id, bundleDigest: first.digest, outcome: "rejected", ...(findings ? { findings } : {}) }), /needs findings/);
    }
    expect(await getMission(w, id)).toMatchObject({ state: "verifying" });
    expect(await latestBundle(w, id)).toMatchObject({ state: "submitted" });

    await run(w, w.owner, "mission.verdict.record", "reject-ok", { missionId: id, bundleDigest: first.digest, outcome: "rejected", findings: ["The summary leaves out the refund lines", "  Cite the export  "] });
    expect(await getMission(w, id)).toMatchObject({ state: "active" });
    expect(await latestBundle(w, id)).toMatchObject({ state: "rejected", independence: "L3", findings: ["The summary leaves out the refund lines", "Cite the export"] });
    expect(await signOffItems(w)).toEqual([]);
    const messages = (await query<{ items: Array<{ senderId: string; body: string; recipient: { kind: string } }> }>(w, "missionMessages.list", id)).items;
    expect(messages.at(-1)).toMatchObject({ senderId: "governor", recipient: { kind: "mission" }, body: expect.stringContaining("The summary leaves out the refund lines") });

    // The same bundle is not judged twice; finishing again assembles a new bundle and a new item.
    await fails(async () => await run(w, w.owner, "mission.verdict.record", "reject-twice", { missionId: id, bundleDigest: first.digest, outcome: "verified" }), /only a verifying mission/);
    const second = await finish(w, id, "reject-finish-2");
    expect(second.digest).not.toBe(first.digest);
    expect((await signOffItems(w)).map((item) => item.id)).toEqual([`signoff:${second.digest}`]);
  });

  it("a verified verdict is independence L3, swaps the item for ready-to-close, and lets the owner close as achieved with the write-up still extracted", async () => {
    world = setupWorld();
    const w = world;
    const id = await achievedMission(w, "signoff-achieved", { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report", criteria: ["delivered"], rejectedFindings: ["Name the three biggest causes"] });
    expect(await getMission(w, id)).toMatchObject({ state: "closed", outcome: "achieved" });
    expect(await latestBundle(w, id)).toMatchObject({ state: "verified", independence: "L3" });
    expect((await attention(w)).filter((item) => item.kind === "sign-off" || item.kind === "verdict-ready")).toEqual([]);
    const assets = (await query<{ items: KnowledgeAsset[] }>(w, "knowledgeAssets.list")).items;
    expect(assets.filter((asset) => asset.missionId === id)).toHaveLength(1);

    const other = await finishedMission(w, "close");
    const bundle = await finish(w, other, "close-finish");
    await fails(async () => await run(w, w.owner, "mission.close", "close-early", { missionId: other, outcome: "achieved" }, (await getMission(w, other)).version), /verified mission verdict/);
    await run(w, w.owner, "mission.verdict.record", "close-verdict", { missionId: other, bundleDigest: bundle.digest, outcome: "verified" });
    expect(await signOffItems(w)).toEqual([]);
    expect((await attention(w)).filter((item) => item.kind === "verdict-ready")).toEqual([expect.objectContaining({ missionId: other, tier: 4, title: "Mission close is verified and ready to close" })]);
    await run(w, w.owner, "mission.close", "close-ok", { missionId: other, outcome: "achieved" }, (await getMission(w, other)).version);
    expect(await getMission(w, other)).toMatchObject({ state: "closed", outcome: "achieved" });
  });

  it("the Governor's hands-off verdict stays a workflow act and claims no independence", async () => {
    world = setupWorld();
    const w = world;
    const id = await achievedMission(w, "hands-off-signoff", { title: "Pricing review", intent: "Review the pricing plans and recommend which to keep", handsOff: true });
    expect(await getMission(w, id)).toMatchObject({ state: "closed", outcome: "achieved" });
    const bundle = await latestBundle(w, id);
    expect(bundle.state).toBe("verified");
    expect(bundle.independence).toBeUndefined();
    // Nobody signed this off: the verdict is the Governor's own principal's, never the owner's, and the owner still owns the mission.
    expect(bundle.verdictBy).toBe("system:governor");
    expect(bundle.verdictBy).not.toBe(w.owner.actorId);
    expect(await getMission(w, id)).toMatchObject({ ownerId: w.owner.actorId });
    const timeline = await query<{ items: Array<{ event: string; actorId?: string; independence?: string }> }>(w, "missions.timeline", id);
    const entry = timeline.items.find((item) => item.event === "verdict.mission");
    expect(entry).toMatchObject({ actorId: "system:governor" });
    expect(entry?.independence).toBeUndefined();
    // The state changes the Governor made on its own (verifying, closed) and the verdict event name a system principal acting for the owner, never the owner.
    const events = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT event_type, actor_id, acting_for FROM events WHERE aggregate_type='mission' AND aggregate_id=? AND event_type IN ('mission.stateChanged','mission.verdictRecorded') ORDER BY cursor").all(id) as Array<{ event_type: string; actor_id: string; acting_for: string | null }>;
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events.slice(-3)) expect(event.actor_id).toMatch(/^system:/);
  });

  it("a person's sign-off records the person and independence L3, in the bundle and on the timeline", async () => {
    world = setupWorld();
    const w = world;
    const id = await achievedMission(w, "person-signoff", { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report" });
    expect(await latestBundle(w, id)).toMatchObject({ independence: "L3", verdictBy: w.owner.actorId });
    const timeline = await query<{ items: Array<{ event: string; actorId?: string; independence?: string }> }>(w, "missions.timeline", id);
    expect(timeline.items.find((item) => item.event === "verdict.mission")).toMatchObject({ actorId: w.owner.actorId, independence: "L3" });
  });
});
