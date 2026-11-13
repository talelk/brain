import { afterEach, describe, expect, it } from "vitest";
import type { QualitySummary } from "@brain/contracts";
import { seedWorkItem, setupWorld, type TestWorld } from "../helpers";

// The quality dashboard read model (Phase 4): per workspace and per practice, a daily trend, and the same denominators as the Quality
// page, so parked work can never raise a rate.
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

interface Row { figures: Record<string, number>; rates: { verifiedUnaided?: number; stall?: number }; daily: Array<{ day: string; verified: number; parked: number }> }
interface Breakdown { window: { days: number }; total: Row; workspaces: Array<Row & { workspaceId: string; name: string; practice: string }>; practices: Array<Row & { practice: string; workspaces: number }> }
const breakdown = async (w: TestWorld, actor = w.owner) => ((await w.brain.executeQuery(actor, { queryType: "quality.breakdown" })) as unknown as { snapshot: Breakdown }).snapshot;
const summary = async (w: TestWorld) => ((await w.brain.executeQuery(w.owner, { queryType: "quality.summary" })) as unknown as { snapshot: QualitySummary }).snapshot;

let seq = 5000;
function event(w: TestWorld, workspaceId: string, type: string, id: string, payload: object, at: number): void {
  w.brain.store.workspaceDb(workspaceId, w.org).prepare("INSERT INTO events(event_id,aggregate_type,aggregate_id,aggregate_seq,event_type,payload_json,payload_digest,created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(`qb-${seq}`, "workItem", id, seq++, type, JSON.stringify(payload), "sha256:seed", at);
}
function done(w: TestWorld, workspaceId: string, id: string, by: string, at: number): void {
  seedWorkItem(w.brain, w.org, workspaceId, id, "ready", ["x"]);
  w.brain.store.workspaceDb(workspaceId, w.org).prepare("UPDATE work_items SET state='done', evidence_digest=? WHERE id=?").run(`sha256:${"9".repeat(64)}`, id);
  event(w, workspaceId, "workItem.transitioned", id, { workItemId: id, state: "done" }, at);
  w.brain.store.workspaceDb(workspaceId, w.org).prepare("INSERT INTO handoffs(id,mission_id,work_item_id,version,notes_json,submitted_by,created_at_ms) VALUES (?,?,?,1,'{}',?,?)").run(`h-${id}`, `mission-${id}`, id, by, at);
}
function parked(w: TestWorld, workspaceId: string, id: string, at: number): void {
  seedWorkItem(w.brain, w.org, workspaceId, id, "blocked", ["x"]);
  w.brain.store.workspaceDb(workspaceId, w.org).prepare("UPDATE work_items SET parked=1, parked_diagnostic='gave up' WHERE id=?").run(id);
  event(w, workspaceId, "workItem.parked", id, { workItemId: id, missionId: `mission-${id}`, state: "blocked" }, at);
}

describe("quality breakdown: per workspace, per practice, with a daily trend", () => {
  it("counts parked work in every denominator, groups by the practice tag and matches the Quality page in total", async () => {
    world = setupWorld();
    const w = world;
    w.brain.createWorkspace(w.owner, { workspaceId: "ws-support", slug: "support" });
    w.brain.createWorkspace(w.owner, { workspaceId: "ws-plain", slug: "plain" });
    w.brain.store.control.prepare("UPDATE workspaces SET tags_json=? WHERE id=?").run(JSON.stringify(["practice:operations"]), w.workspaceId);
    w.brain.store.control.prepare("UPDATE workspaces SET tags_json=? WHERE id=?").run(JSON.stringify(["practice:support", "team"]), "ws-support");
    const now = w.brain.store.now(); const HOUR = 3_600_000;
    // Operations: three verified (two by the Governor alone), one parked and still parked.
    done(w, w.workspaceId, "ops-a", "governor", now - 2 * HOUR);
    done(w, w.workspaceId, "ops-b", "governor", now - 3 * HOUR);
    done(w, w.workspaceId, "ops-c", "owner-1", now - 26 * HOUR);
    parked(w, w.workspaceId, "ops-d", now - HOUR);
    // Support: one verified alone, two parked.
    done(w, "ws-support", "sup-a", "governor", now - HOUR);
    parked(w, "ws-support", "sup-b", now - 2 * HOUR);
    parked(w, "ws-support", "sup-c", now - 5 * HOUR);
    // An untagged workspace with nothing in it.

    const view = await breakdown(w);
    expect(view.window.days).toBe(30);
    const ops = view.practices.find((entry) => entry.practice === "operations")!;
    const support = view.practices.find((entry) => entry.practice === "support")!;
    expect(view.practices.map((entry) => entry.practice)).toEqual(["operations", "support", "untagged"]);
    expect(ops.figures).toMatchObject({ verified: 3, verifiedUnaided: 2, parkedOpen: 1, stalled: 1, activeTasks: 4 });
    expect(support.figures).toMatchObject({ verified: 1, verifiedUnaided: 1, parkedOpen: 2, stalled: 2, activeTasks: 3 });
    // Parked work sits in the denominator: 2 unaided of 3 done plus 1 parked, not 2 of 3.
    expect(ops.rates.verifiedUnaided).toBeCloseTo(2 / 4);
    expect(ops.rates.stall).toBeCloseTo(1 / 4);
    expect(support.rates.verifiedUnaided).toBeCloseTo(1 / 3);
    expect(support.rates.stall).toBeCloseTo(2 / 3);
    expect(view.workspaces.map((entry) => [entry.name, entry.practice])).toEqual([["plain", "untagged"], ["support", "support"], ["test", "operations"]]);
    // The daily trend: today holds the recent items, and the days add up to the figures.
    const today = new Date(now).toISOString().slice(0, 10);
    expect(ops.daily).toHaveLength(30);
    expect(ops.daily.reduce((sum, day) => sum + day.verified, 0)).toBe(3);
    expect(ops.daily.reduce((sum, day) => sum + day.parked, 0)).toBe(1);
    expect(support.daily.reduce((sum, day) => sum + day.parked, 0)).toBe(2);
    expect(ops.daily.some((day) => day.day === today)).toBe(true);
    // The total agrees with the Quality page's own figure.
    const unaided = (await summary(w)).metrics.find((entry) => entry.id === "verified-unaided")!;
    expect(view.total.figures["verified"]! + view.total.figures["parkedOpen"]!).toBe(unaided.denominator);
    expect(view.total.rates.verifiedUnaided).toBeCloseTo(unaided.value!);
    const stall = (await summary(w)).metrics.find((entry) => entry.id === "stall-rate")!;
    expect(view.total.rates.stall).toBeCloseTo(stall.value!);
  });

  it("is owner-only, like the Quality page", async () => {
    world = setupWorld();
    const w = world;
    const approver = await w.grantApprover("member-q");
    await expect(breakdown(w, approver.actor)).rejects.toThrow(/quality:read/u);
    const own = await breakdown(w);
    expect(own.practices.map((entry) => entry.practice)).toEqual(["untagged"]);
    expect(own.workspaces).toHaveLength(1);
  });
});
