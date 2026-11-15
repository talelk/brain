import { afterEach, describe, expect, it } from "vitest";
import type { TeamMember, UsageSeries, UsageView, VerifiedCostReport } from "@brain/contracts";
import { DIGEST_A } from "../helpers";
import { advance, closeWorlds, currentTimeMs, running, startedMission, task, type Offer, type Runner, type World } from "../support/machine-session";

// Spend history (#112, ADR 0053): a daily series per scope read from the same ledger rows as every total, and cost per verified task by agent
// and Play with the Quality summary's arithmetic. Spend is reached through the runner protocol, never by writing ledger rows.
const DAY = 86_400_000;
const team: TeamMember[] = [
  { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  { memberId: "reviewer", role: "Reviewer", agentId: "operations-assistant", engine: "fixture" },
];
const assigned = (id: string, memberId: string) => task(id, { assignment: { kind: "agent", id: memberId, role: "specialist" }, ...(memberId === "reviewer" ? { workflowId: "operations-triage" } : {}) });
const query = async <T>(w: World, queryType: string, resourceId?: string, limit?: number): Promise<T> =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}), ...(limit ? { limit } : {}) } as never)) as unknown as { snapshot: T }).snapshot;

/** The engine's usage report; the attempt settles into the ledger the first time anything reads it after the runner releases it. */
function send(w: World, runner: Runner, offer: Offer, microUsd: number, tokens: number): void {
  const payload = { usageId: offer.attemptId, inputTokens: tokens, outputTokens: 0, microUsd, accounting: "final-total" };
  const events = [{ sequence: 1, kind: "engine", payload: { contractVersion: "brain.engine-event/v1", eventId: "e0", sessionId: "s", attemptId: offer.attemptId, sequence: 1, occurredAt: new Date().toISOString(), kind: "usage", payload } }];
  w.brain.jobProtocol.events(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "pi", model: "m", adapterDigest: DIGEST_A, features: [] }, events });
}
const release = (w: World, offer: Offer): void => w.brain.jobProtocol.releaseReservation(offer.attemptId);
function report(w: World, runner: Runner, offer: Offer, microUsd: number, tokens: number): void { send(w, runner, offer, microUsd, tokens); release(w, offer); }
const memberOf = (w: World, runner: Runner, offer: Offer): string | undefined => w.brain.jobProtocol.sessionCredential(runner, offer.attemptId).memberId;

describe("spend history at the query seam", () => {
  afterEach(closeWorlds);

  it("series days add up to the ledger totals of each scope, and days with no spend are present as zero", async () => {
    const { w, missionId, runner } = await startedMission({ tasks: [assigned("a", "writer"), assigned("b", "reviewer")], team });
    const first = running(w, runner, "one");
    const second = running(w, runner, "two");
    const byMember = new Map([first, second].map((offer) => [memberOf(w, runner, offer), offer] as const));
    // The writer settles today; the reviewer settles three days later, with two days of nothing between.
    const writer = byMember.get("writer")!, reviewer = byMember.get("reviewer")!;
    send(w, runner, writer, 4000, 1500);
    send(w, runner, reviewer, 2500, 700);
    release(w, writer);
    const start = currentTimeMs();
    await query<UsageView>(w, "usage.workspace");
    advance(3 * DAY);
    release(w, reviewer);

    const workspace = await query<UsageSeries>(w, "usage.series", "workspace", 7);
    expect(workspace.days).toHaveLength(7);
    expect(workspace.window.days).toBe(7);
    const today = new Date(currentTimeMs()).toISOString().slice(0, 10);
    expect(workspace.days.at(-1)!.day).toBe(today);
    expect(workspace.days.map((day) => day.day)).toEqual([...workspace.days.map((day) => day.day)].sort());
    const writerDay = new Date(start).toISOString().slice(0, 10);
    const spendByDay = Object.fromEntries(workspace.days.filter((day) => day.settledMicroUsd > 0).map((day) => [day.day, day.settledMicroUsd]));
    expect(spendByDay).toEqual({ [writerDay]: 4000, [today]: 2500 });
    // The days between are present and zero.
    expect(workspace.days.filter((day) => day.settledMicroUsd === 0 && day.attempts === 0).length).toBe(5);

    const sum = (series: UsageSeries) => series.days.reduce((total, day) => total + day.settledMicroUsd, 0);
    const usage = (view: UsageView) => view.usage.settledMicroUsd;
    expect(sum(workspace)).toBe(workspace.totalMicroUsd);
    expect(workspace.totalMicroUsd).toBe(usage(await query<UsageView>(w, "usage.workspace")));
    const mission = await query<UsageSeries>(w, "usage.series", `mission:${missionId}`, 7);
    expect(mission).toMatchObject({ scope: "mission", id: missionId, totalMicroUsd: usage(await query<UsageView>(w, "usage.mission", missionId)), totalTokens: 2200 });
    const agent = await query<UsageSeries>(w, "usage.series", "agent:operations-assistant", 7);
    expect(agent).toMatchObject({ scope: "agent", id: "operations-assistant", totalMicroUsd: 2500, totalTokens: 700 });
    expect(agent.totalMicroUsd).toBe(usage(await query<UsageView>(w, "usage.agent", "operations-assistant")));
    expect(agent.days.at(-1)).toMatchObject({ day: today, settledMicroUsd: 2500, attempts: 1 });
    // A window shorter than the history drops the older day: the series only covers its own days.
    expect(sum(await query<UsageSeries>(w, "usage.series", "workspace", 2))).toBe(2500);
    expect(workspace.definition.length).toBeGreaterThan(20);
  });

  it("refuses an unknown scope, a mission that does not exist and a missing agent id", async () => {
    const { w } = await startedMission({ tasks: [assigned("a", "writer")], team });
    await expect(query(w, "usage.series", "member:x")).rejects.toThrow();
    await expect(query(w, "usage.series", "mission:nope")).rejects.toThrow();
    await expect(query(w, "usage.series", "agent:")).rejects.toThrow();
    expect((await query<UsageSeries>(w, "usage.series", "agent:nobody", 3)).days.map((day) => day.settledMicroUsd)).toEqual([0, 0, 0]);
  });

  it("cost per verified task: spend in the window over tasks that reached Done, by agent and by Play", async () => {
    const { w, missionId, runner } = await startedMission({ tasks: [assigned("a", "writer"), assigned("b", "reviewer")], team });
    const offers = [running(w, runner, "one"), running(w, runner, "two")];
    const byMember = new Map(offers.map((offer) => [memberOf(w, runner, offer), offer] as const));
    report(w, runner, byMember.get("writer")!, 6000, 100);
    report(w, runner, byMember.get("reviewer")!, 3000, 100);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    // Tasks reach Done through the Governor's own events; here the two work items are recorded as verified.
    const items = db.prepare("SELECT id FROM work_items WHERE mission_id=? ORDER BY id").all(missionId) as Array<{ id: string }>;
    let seq = 9000;
    for (const item of items) db.prepare("INSERT INTO events(event_id,aggregate_type,aggregate_id,aggregate_seq,event_type,payload_json,payload_digest,created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
      .run(`seed-${seq}`, "workItem", item.id, seq++, "workItem.transitioned", JSON.stringify({ workItemId: item.id, state: "done" }), "sha256:seed", w.brain.store.now());

    const none = await query<VerifiedCostReport>(w, "usage.verifiedCost");
    expect(none.byAgentDefinition).toMatch(/divided by tasks that reached Done/u);
    expect(none.byPlayDefinition).toMatch(/divided by tasks/u);
    const byAgent = Object.fromEntries(none.byAgent.map((row) => [row.id, row]));
    expect(byAgent["task-worker"]).toEqual({ id: "task-worker", spendMicroUsd: 6000, verifiedTasks: 1, costPerVerifiedMicroUsd: 6000 });
    expect(byAgent["operations-assistant"]).toEqual({ id: "operations-assistant", spendMicroUsd: 3000, verifiedTasks: 1, costPerVerifiedMicroUsd: 3000 });
    // No Play started this mission: its spend and tasks are grouped without an id.
    expect(none.byPlay).toEqual([{ spendMicroUsd: 9000, verifiedTasks: 2, costPerVerifiedMicroUsd: 4500 }]);

    db.prepare("UPDATE missions SET play_id='release-notes' WHERE id=?").run(missionId);
    expect((await query<VerifiedCostReport>(w, "usage.verifiedCost")).byPlay).toEqual([{ id: "release-notes", spendMicroUsd: 9000, verifiedTasks: 2, costPerVerifiedMicroUsd: 4500 }]);

    // Spend older than the window stops counting, and with nothing verified there is no per-task figure, never a zero or a guess.
    advance(40 * DAY);
    const later = await query<VerifiedCostReport>(w, "usage.verifiedCost");
    expect(later.byAgent).toEqual([]);
    expect(later.byPlay).toEqual([]);
  });
});
