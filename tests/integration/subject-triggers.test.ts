import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AttentionItem, Automation, AutomationOccurrence, CommandReceipt, Mission } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

/**
 * A subject trigger set up the way the Schedules screen does it (the `automation.upsert` and `automation.control` commands) fires on a
 * subject event: a ticket the GitLab connector discovers starts one mission from the Play, and the trigger's safety conditions (ADR 0017) decide
 * whether the plan waits for a person.
 */
type World = TestWorld;
let world: World | undefined;
let server: Server | undefined;
afterEach(async () => {
  world?.brain.close(); world = undefined;
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
});

const PLAY = "support-reply-draft";
let counter = 0;
async function run(w: World, commandType: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  const key = `st-${++counter}`;
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const read = async <T>(w: World, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const db = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
const automation = async (w: World, id: string) => (await read<{ items: Automation[] }>(w, "automations.list")).items.find((item) => item.automationId === id)!;
const occurrences = async (w: World, id: string) => (await read<{ items: AutomationOccurrence[] }>(w, "automations.occurrences", id)).items;
const events = (w: World, type: string) => (db(w).prepare("SELECT payload_json FROM events WHERE event_type=? ORDER BY cursor").all(type) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);

function worldWithPlays(): World {
  const w = setupWorld();
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  world = w;
  return w;
}

/** A GitLab project whose open issues the test controls; the connector reads it read-only. */
async function gitlab(issues: Array<Record<string, unknown>>): Promise<(w: World) => Promise<{ discovered: number; created: number }>> {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/api/v4/projects/7") { res.end(JSON.stringify({ id: 7 })); return; }
      if (req.method === "GET" && req.url?.startsWith("/api/v4/projects/7/issues")) { res.end(JSON.stringify(issues)); return; }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return (w) => w.brain.discoverGitLabFacts({ actor: w.owner, workspaceId: w.workspaceId, baseUrl, projectId: 7, token: "t" });
}
const issue = (iid: number) => ({ iid, title: `Customer cannot sign in (${iid})`, state: "opened", updated_at: `2026-10-0${iid}T00:00:00Z` });

const subjectTrigger = (subjectKind: "ticket" | "incident", extra: Record<string, unknown> = {}) => ({ title: "Every new ticket", target: { kind: "play", id: PLAY }, trigger: { kind: "subject", subjectKind }, ...extra });
const started = async (w: World, id: string) => (await occurrences(w, id)).filter((occurrence) => occurrence.state === "dispatched");

describe("a subject trigger created from the Schedules screen (ticket #122)", () => {
  it("starts one mission per new ticket, and pause, resume and retire gate it", async () => {
    const w = worldWithPlays();
    const discover = await gitlab([issue(1)]);
    const created = await run(w, "automation.upsert", subjectTrigger("ticket"));
    expect(created.accepted).toBe(true);
    const id = created.resourceId ?? "";
    expect(await automation(w, id)).toMatchObject({ state: "active", target: { kind: "play", id: PLAY }, trigger: { kind: "subject", subjectKind: "ticket" } });

    // A new ticket starts one mission about it; seeing the same ticket again starts nothing.
    expect(await discover(w)).toMatchObject({ created: 1 });
    expect(await discover(w)).toMatchObject({ created: 0 });
    const first = await started(w, id);
    expect(first).toHaveLength(1);
    const ticket = (db(w).prepare("SELECT id FROM tickets WHERE remote_id='1'").get() as { id: string }).id;
    const forTicket = await read<{ items: Mission[] }>(w, "missions.forSubject", ticket);
    expect(forTicket.items.map((mission) => mission.missionId)).toEqual([first[0]!.dispatchRef]);
    expect(forTicket.items[0]).toMatchObject({ playId: PLAY, subjects: [{ pack: "support", kind: "ticket", id: ticket }] });

    // Paused: a new ticket starts nothing. Resumed: the next new ticket does.
    const current = async () => (await automation(w, id)).version;
    expect((await run(w, "automation.control", { automationId: id, action: "pause" }, await current())).accepted).toBe(true);
    expect((await automation(w, id)).state).toBe("paused");
    const next = await gitlab([issue(1), issue(2)]);
    expect(await next(w)).toMatchObject({ created: 1 });
    expect(await started(w, id)).toHaveLength(1);
    expect((await run(w, "automation.control", { automationId: id, action: "resume" }, await current())).accepted).toBe(true);
    const later = await gitlab([issue(1), issue(2), issue(3)]);
    expect(await later(w)).toMatchObject({ created: 1 });
    expect(await started(w, id)).toHaveLength(2);

    // Retired: kept for history, never fires again.
    expect((await run(w, "automation.control", { automationId: id, action: "retire", reason: "Handled by hand now" }, await current())).accepted).toBe(true);
    const last = await gitlab([issue(1), issue(2), issue(3), issue(4)]);
    expect(await last(w)).toMatchObject({ created: 1 });
    expect(await started(w, id)).toHaveLength(2);
    expect((await automation(w, id)).state).toBe("retired");
  });

  it("a ticket arriving while an earlier mission is still open still gets its own mission", async () => {
    const w = worldWithPlays();
    const id = (await run(w, "automation.upsert", subjectTrigger("ticket", { overlap: "skip" }))).resourceId ?? "";
    expect((await automation(w, id)).overlap).toBe("queue-one");
    await (await gitlab([issue(1), issue(2)]))(w);
    expect(await started(w, id)).toHaveLength(2);
    expect(await occurrences(w, id)).toHaveLength(2);
  });

  it("editing a trigger changes which subject kind it listens for, and a trigger changed to a timer stops listening", async () => {
    const w = worldWithPlays();
    const id = (await run(w, "automation.upsert", subjectTrigger("ticket"))).resourceId ?? "";
    const revised = await run(w, "automation.upsert", { ...subjectTrigger("incident"), automationId: id }, (await automation(w, id)).version);
    expect(revised.accepted).toBe(true);
    expect((await automation(w, id)).trigger).toEqual({ kind: "subject", subjectKind: "incident" });
    await (await gitlab([issue(1)]))(w);
    expect(await started(w, id)).toHaveLength(0);

    await run(w, "automation.upsert", { title: "Nightly", target: { kind: "play", id: PLAY }, trigger: { kind: "manual" }, automationId: id }, (await automation(w, id)).version);
    expect((await automation(w, id)).trigger).toEqual({ kind: "manual" });
    await (await gitlab([issue(1), issue(2)]))(w);
    expect(await started(w, id)).toHaveLength(0);
  });

  it("refuses a subject trigger that starts anything but a Play, and refuses Run now (it needs a subject)", async () => {
    const w = worldWithPlays();
    const bad = await run(w, "automation.upsert", { title: "Bad", target: { kind: "workflow", id: "general-task" }, trigger: { kind: "subject", subjectKind: "ticket" } }).catch((cause: unknown) => cause);
    expect(bad).toMatchObject({ message: expect.stringMatching(/subject trigger starts a play/u) });
    const id = (await run(w, "automation.upsert", subjectTrigger("ticket"))).resourceId ?? "";
    const now = await run(w, "automation.control", { automationId: id, action: "runNow" }, (await automation(w, id)).version).catch((cause: unknown) => cause);
    expect(now).toMatchObject({ message: expect.stringMatching(/needs a new ticket or incident/u) });
    expect(await occurrences(w, id)).toHaveLength(0);
  });

  it("the plan of a triggered mission waits in Needs you and says why, unless the trigger repeats an achieved mission under ADR 0017's conditions", async () => {
    const w = worldWithPlays();
    const attention = async () => (await read<{ items: AttentionItem[] }>(w, "attention.list")).items;
    const alone = (await run(w, "automation.upsert", subjectTrigger("ticket"))).resourceId ?? "";
    await (await gitlab([issue(1)]))(w);
    const [held] = await started(w, alone);
    expect(db(w).prepare("SELECT state FROM plan_versions WHERE mission_id=?").get(held!.dispatchRef)).toEqual({ state: "proposed" });
    expect(events(w, "plan.heldBySchedule").at(-1)?.["reason"]).toMatch(/new ticket started this mission/u);
    expect((await attention()).find((item) => item.kind === "plan-proposal" && item.missionId === held!.dispatchRef)?.title).toMatch(/needs your OK: .*new ticket/u);
    await run(w, "automation.control", { automationId: alone, action: "retire", reason: "Replaced" }, (await automation(w, alone)).version);

    // The trigger names an earlier mission from the same Play that closed as achieved: its confirmed plan is what each new ticket repeats.
    const source = (await run(w, "mission.create", { title: "Reply to the first customer", playId: PLAY })).resourceId ?? "";
    const proposed = db(w).prepare("SELECT id FROM plan_versions WHERE mission_id=?").get(source) as { id: string };
    await run(w, "plan.confirm", { planVersionId: proposed.id }, (await read<Mission>(w, "missions.get", source)).version);
    db(w).prepare("INSERT INTO mission_evidence_bundles(digest,mission_id,state,manifest_json,findings_json,created_at_ms) VALUES (?,?,'verified','{}','[]',?)").run(`sha256:${"a".repeat(64)}`, source, Date.now());
    db(w).prepare("UPDATE missions SET state='closed', outcome='achieved' WHERE id=?").run(source);
    const repeating = (await run(w, "automation.upsert", { ...subjectTrigger("ticket", { title: "Repeat the first reply" }), input: { sourceMissionId: source, autoConfirm: true } })).resourceId ?? "";
    await (await gitlab([issue(1), issue(2)]))(w);
    const [second] = await started(w, repeating);
    expect(db(w).prepare("SELECT state FROM plan_versions WHERE mission_id=?").get(second!.dispatchRef)).toEqual({ state: "confirmed" });
    expect(events(w, "plan.confirmedBySchedule").at(-1)?.["note"]).toMatch(new RegExp(`confirmed by schedule ${repeating}`, "u"));

    // The person's switch off: the same trigger asks each time.
    await run(w, "automation.upsert", { ...subjectTrigger("ticket", { title: "Repeat the first reply" }), automationId: repeating, input: { sourceMissionId: source, autoConfirm: false } }, (await automation(w, repeating)).version);
    await (await gitlab([issue(1), issue(2), issue(3)]))(w);
    const asking = (await started(w, repeating)).find((occurrence) => occurrence.dispatchRef !== second!.dispatchRef)!;
    expect(db(w).prepare("SELECT state FROM plan_versions WHERE mission_id=?").get(asking.dispatchRef)).toEqual({ state: "proposed" });
    expect(events(w, "plan.heldBySchedule").at(-1)?.["reason"]).toMatch(/ask you each time/u);
  });
});
