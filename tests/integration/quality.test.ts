import { describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, PlanTask, QualitySummary } from "@brain/contracts";
import { setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const task = (id: string): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [] });
const quality = async (w: World, actor: ActorContext) => ((await w.brain.executeQuery(actor, { queryType: "quality.summary" })) as { snapshot: QualitySummary }).snapshot;
const metric = (summary: QualitySummary, id: string) => summary.metrics.find((entry) => entry.id === id)!;

async function mission(w: World, key: string, tasks: PlanTask[]): Promise<string> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, 1);
  return id;
}

describe("Quality summary (#63)", () => {
  it("is owner-only: a member without quality:read is refused", async () => {
    const w = setupWorld();
    const approver = await w.grantApprover("member-1");
    await expect(quality(w, approver.actor)).rejects.toThrow(/quality:read/);
    expect(approver.actor.scopes).not.toContain("quality:read");
    expect((await quality(w, w.owner)).window.days).toBe(30);
    w.brain.close();
  });

  it("says no data instead of a number when nothing happened", async () => {
    const w = setupWorld();
    const summary = await quality(w, w.owner);
    expect(summary.metrics.map((entry) => entry.id)).toEqual(["verified-unaided", "stall-rate", "reopen-rate", "cost-per-verified-task", "time-to-first-result"]);
    for (const entry of summary.metrics) { expect(entry.value).toBeUndefined(); expect(entry.definition.length).toBeGreaterThan(20); }
    expect(summary.failureReasons.items).toEqual([]);
    w.brain.close();
  });

  it("computes every figure from a seeded store with known answers", async () => {
    const w = setupWorld();
    const m1 = await mission(w, "q-one", ["a", "b", "c", "d", "e"].map(task));
    const m2 = await mission(w, "q-two", [task("x")]);
    const items = (await workView(w)).items;
    const id = (mission: string, planTaskId: string) => items.find((item) => item.missionId === mission && item.planTaskId === planTaskId)!.workItemId;
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const now = w.brain.store.now();
    const HOUR = 3_600_000, MIN = 60_000;
    let seq = 1000;
    const event = (type: string, aggregateType: string, aggregateId: string, payload: object, at: number) => db.prepare(
      "INSERT INTO events(event_id,aggregate_type,aggregate_id,aggregate_seq,event_type,payload_json,payload_digest,created_at_ms) VALUES (?,?,?,?,?,?,?,?)",
    ).run(`seed-${seq}`, aggregateType, aggregateId, seq++, type, JSON.stringify(payload), "sha256:seed", at);
    const handoff = (missionId: string, workItemId: string, by: string) => db.prepare(
      "INSERT INTO handoffs(id,mission_id,work_item_id,version,notes_json,submitted_by,created_at_ms) VALUES (?,?,?,1,'{}',?,?)",
    ).run(`handoff-${workItemId}`, missionId, workItemId, by, now);
    // m1: a and b verified by the Governor, c signed off by a person; first result 90 minutes after creation.
    db.prepare("UPDATE missions SET created_at_ms=? WHERE id=?").run(now - 4 * HOUR - 90 * MIN, m1);
    for (const [planTaskId, hoursAgo, by] of [["a", 4, "governor"], ["b", 3, "governor"], ["c", 2, "owner-1"]] as const) {
      event("workItem.transitioned", "workItem", id(m1, planTaskId), { workItemId: id(m1, planTaskId), state: "done" }, now - hoursAgo * HOUR);
      handoff(m1, id(m1, planTaskId), by);
    }
    // m2: x verified by the Governor 30 minutes after creation.
    db.prepare("UPDATE missions SET created_at_ms=? WHERE id=?").run(now - 3 * HOUR - 30 * MIN, m2);
    event("workItem.transitioned", "workItem", id(m2, "x"), { workItemId: id(m2, "x"), state: "done" }, now - 3 * HOUR);
    handoff(m2, id(m2, "x"), "governor");
    // d and e parked with two runs' failures of the same kind.
    for (const [planTaskId, run] of [["d", 7], ["e", 12]] as const) {
      db.prepare("UPDATE work_items SET parked=1, parked_diagnostic=? WHERE id=?").run(`tests failed in run ${run}`, id(m1, planTaskId));
      event("workItem.parked", "workItem", id(m1, planTaskId), { workItemId: id(m1, planTaskId), missionId: m1, state: "blocked" }, now - HOUR);
    }
    // m1 entered Verifying and was sent back; m2 entered Verifying and stayed.
    event("mission.stateChanged", "mission", m1, { missionId: m1, missionState: "verifying" }, now - 100 * MIN);
    event("mission.stateChanged", "mission", m1, { missionId: m1, missionState: "active" }, now - 90 * MIN);
    event("mission.stateChanged", "mission", m2, { missionId: m2, missionState: "verifying" }, now - 80 * MIN);
    // Settled spend of 3 USD, plus 5 USD settled long before the window that must not count.
    const spend = db.prepare("INSERT INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,settled_micro_usd,created_at_ms,settled_at_ms) VALUES (?,?,?,?,?,?,?)");
    spend.run("att-1", m1, "r1", 1_000_000, 1_000_000, now - 2 * HOUR, now - 2 * HOUR);
    spend.run("att-2", m1, "r2", 2_000_000, 2_000_000, now - HOUR, now - HOUR);
    spend.run("att-old", m1, "r0", 5_000_000, 5_000_000, now - 60 * 86_400_000, now - 60 * 86_400_000);

    const summary = await quality(w, w.owner);
    expect(metric(summary, "verified-unaided")).toMatchObject({ value: 3 / 4, numerator: 3, denominator: 4 });
    expect(metric(summary, "stall-rate")).toMatchObject({ value: 2 / 6, numerator: 2, denominator: 6 });
    expect(metric(summary, "reopen-rate")).toMatchObject({ value: 1 / 2, numerator: 1, denominator: 2 });
    expect(metric(summary, "cost-per-verified-task")).toMatchObject({ value: 750_000, numerator: 3_000_000, denominator: 4 });
    expect(metric(summary, "time-to-first-result")).toMatchObject({ value: 60 * MIN, denominator: 2 });
    expect(summary.failureReasons.items).toEqual([{ reason: "tests failed in run N", count: 2 }]);
    expect(Date.parse(summary.window.to) - Date.parse(summary.window.from)).toBe(30 * 86_400_000);
    w.brain.close();
  });
});
