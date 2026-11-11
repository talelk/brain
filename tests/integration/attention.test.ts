import { describe, expect, it } from "vitest";
import type { ActorContext, AttentionItem, CommandReceipt, Mission, PlanTask, SinceLastVisitSummary } from "@brain/contracts";
import { setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const task = (id: string, dependsOn: string[] = []): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn });
const query = async <T>(w: World, actor: ActorContext, queryType: string, resourceId?: string) => ((await w.brain.executeQuery(actor, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as { snapshot: T }).snapshot;

async function mission(w: World, key: string, tasks: PlanTask[], confirm = true): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  if (confirm) await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await query<Mission>(w, w.owner, "missions.get", id)).version);
  return id;
}

describe("attention and since-last-visit (T59)", () => {
  it("ranks attention in fixed tiers: stopped missions, then proposals and parked work, oldest wait first", async () => {
    const w = setupWorld();
    const parkedMission = await mission(w, "parked", [task("a"), task("b", ["a"])]);
    const a = (await workView(w)).items.find((item) => item.missionId === parkedMission && item.planTaskId === "a")!;
    for (const runId of ["r1", "r2", "r3"]) {
      w.brain.missions.linkExecution(w.owner, w.workspaceId, a.workItemId, runId);
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, `tests failed in ${runId}`);
    }
    const proposalMission = await mission(w, "proposal", [task("x")], false);
    const pausedMission = await mission(w, "paused", [task("y")]);
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE missions SET state='paused', pause_reason='budget' WHERE id=?").run(pausedMission);
    const items = (await query<{ items: AttentionItem[] }>(w, w.owner, "attention.list")).items;
    expect(items.map((item) => [item.kind, item.missionId])).toEqual([
      ["needs-attention", parkedMission],
      ["budget-pause", pausedMission],
      ["parked", parkedMission],
      ["plan-proposal", proposalMission],
    ]);
    expect(items.find((item) => item.kind === "parked")?.detail).toContain("1 dependent(s) waiting");
    w.brain.close();
  });

  it("parks a task at once, with a one-click Try again, when its agent was interrupted too often", async () => {
    const w = setupWorld();
    const id = await mission(w, "interrupted", [task("a")]);
    const a = (await workView(w)).items.find((item) => item.missionId === id)!;
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    w.brain.missions.linkExecution(w.owner, w.workspaceId, a.workItemId, "run-int");
    db.prepare("INSERT INTO workflow_runs(id, execution_key, config_digest, workflow_digest, adapter_digest, engine_run_id, state, input_digest, created_at_ms) VALUES ('run-int','k','d','d','d','e','failed','d',1)").run();
    db.prepare("INSERT INTO workflow_steps(run_id, step_id, execution_key, state) VALUES ('run-int','respond','sk','failed')").run();
    db.prepare("INSERT INTO step_outputs(run_id, step_id, output_json) VALUES ('run-int','respond',?)").run(JSON.stringify({ code: "AGENT_INTERRUPTED", error: "The agent was interrupted 7 times; try again." }));
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, "run-int", "Step respond failed");
    const item = (await workView(w)).items.find((entry) => entry.workItemId === a.workItemId)!;
    expect(item).toMatchObject({ parked: true, blockedReason: "Stopped: waiting for you to try again", failedAttempts: 0 });
    const parked = (await query<{ items: AttentionItem[] }>(w, w.owner, "attention.list")).items.find((entry) => entry.kind === "parked");
    expect(parked).toMatchObject({ title: "Task a stopped: waiting for you to try again", detail: "The agent was interrupted 7 times; try again." });
    w.brain.close();
  });

  it("shows notable events since the user's last visit once, wherever they look, and counts the rest (E119)", async () => {
    const w = setupWorld();
    const id = await mission(w, "visit", [task("a")]);
    await run(w, w.owner, "mission.brief.edit", "visit-brief", { missionId: id, baseVersion: 1, constraints: ["Stay in the EU"] });
    const first = await query<SinceLastVisitSummary>(w, w.owner, "missions.sinceLastVisit", id);
    expect(first.notable.map((entry) => entry.summary)).toEqual(expect.arrayContaining(["Plan proposal awaiting review", "Plan version confirmed", "Brief updated to version 2"]));
    expect(first.fromCursor).toBe(0);
    await run(w, w.owner, "mission.seen", "visit-seen-laptop", { missionId: id, cursor: first.toCursor });
    const phone = await query<SinceLastVisitSummary>(w, w.owner, "missions.sinceLastVisit", id);
    expect(phone).toMatchObject({ fromCursor: first.toCursor, notable: [] });
    await run(w, w.owner, "mission.seen", "visit-seen-stale", { missionId: id, cursor: 0 });
    expect((await query<SinceLastVisitSummary>(w, w.owner, "missions.sinceLastVisit", id)).fromCursor).toBe(first.toCursor);
    await run(w, w.owner, "mission.pause", "visit-pause", { missionId: id }, (await query<Mission>(w, w.owner, "missions.get", id)).version);
    const later = await query<SinceLastVisitSummary>(w, w.owner, "missions.sinceLastVisit", id);
    expect(later.notable.map((entry) => entry.summary)).toEqual(["Mission is now paused"]);
    w.brain.close();
  });

  it("notifies the starter and watchers once per item and at most once per mission every 15 minutes; revoked access stops it (T65)", async () => {
    const w = setupWorld();
    const id = await mission(w, "notify", [task("a"), task("b", ["a"])]);
    const watcher = await w.grantApprover("watcher-1");
    await run(w, watcher.actor, "mission.watch", "notify-watch", { missionId: id, watch: true });
    const watched = async (actor: typeof watcher.actor) => ((await w.brain.executeQuery(actor, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: { watching: boolean } }).snapshot.watching;
    expect(await watched(watcher.actor)).toBe(true);
    expect(await watched(w.owner)).toBe(false);
    const a = (await workView(w)).items.find((item) => item.missionId === id && item.planTaskId === "a")!;
    for (const runId of ["n1", "n2", "n3"]) {
      w.brain.missions.linkExecution(w.owner, w.workspaceId, a.workItemId, runId);
      w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, `tests failed in ${runId}`);
    }
    expect(w.brain.notifyAttention()).toBe(2);
    expect(w.brain.notifyAttention()).toBe(0);
    const inbox = (await query<{ items: Array<{ missionId: string; title: string }> }>(w, w.owner, "notifications.list")).items;
    expect(inbox).toEqual([expect.objectContaining({ missionId: id, title: expect.stringContaining("needs attention") })]);
    expect((await query<{ items: unknown[] }>(w, watcher.actor, "notifications.list")).items).toHaveLength(1);
    w.brain.store.control.prepare("UPDATE workspace_memberships SET revoked_at_ms=? WHERE principal_id='watcher-1'").run(w.brain.store.now());
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE attention_notifications SET sent_at_ms=sent_at_ms-?").run(16 * 60_000);
    expect(w.brain.notifyAttention()).toBe(1);
    w.brain.close();
  });
});
