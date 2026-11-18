import type { Attempt, Task } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { buildTimeline, criticalPath, fractionOf, packLanes, pan, ticks, zoom } from "../../apps/web/src/lib/timeline";

/** The Timeline's own arithmetic (docs/model.md, "The timeline and Insights"): lanes for attempts that overlap, the critical path, and the time axis. */
describe("timeline lanes", () => {
  it("puts overlapping attempts in their own lanes and reuses a lane once it is free", () => {
    expect(packLanes([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 10, end: 20 }, { start: 12, end: 14 }])).toEqual([0, 1, 0, 2]);
    expect(packLanes([])).toEqual([]);
    // Two attempts too short to see are given room, so one does not hide the other.
    expect(packLanes([{ start: 0, end: 0 }, { start: 1, end: 1 }, { start: 100, end: 100 }], 10)).toEqual([0, 1, 0]);
    // Attempts that follow each other (a retry, the next round) share a lane.
    expect(packLanes([{ start: 0, end: 5 }, { start: 5, end: 9 }, { start: 9, end: 9 }])).toEqual([0, 0, 0]);
  });
});

describe("timeline critical path", () => {
  const node = (id: string, end: number | null, waitsFor: string[] = [], parentId: string | null = null) => ({ id, parentId, waitsFor, end });
  it("follows, from the task that ends last, the task it waited for that ended last", () => {
    const path = criticalPath([node("a", 10), node("b", 30), node("c", 20, ["a"]), node("d", 40, ["b", "c"]), node("e", 15)]);
    expect([...path].sort()).toEqual(["b", "d"]);
  });
  it("reads a task that waits for a step as waiting for its copies, and a copy as waiting for what its step waits for", () => {
    const path = criticalPath([node("setup", 10), node("each", null, ["setup"]), node("copy1", 25, [], "each"), node("copy2", 35, [], "each"), node("merge", 50, ["each"])]);
    expect([...path].sort()).toEqual(["copy2", "merge", "setup"]);
  });
  it("is empty when nothing ended", () => {
    expect(criticalPath([node("a", null)]).size).toBe(0);
  });
});

describe("timeline axis", () => {
  const whole = { from: 0, to: 100_000 };
  it("places a time in the view from 0 to 1", () => {
    expect(fractionOf({ from: 100, to: 300 }, 200)).toBe(0.5);
  });
  it("zooms around a place and never leaves the whole span or goes below one second", () => {
    expect(zoom(whole, whole, 2, 0.5)).toEqual({ from: 25_000, to: 75_000 });
    expect(zoom({ from: 25_000, to: 75_000 }, whole, 2, 0)).toEqual({ from: 25_000, to: 50_000 });
    expect(zoom({ from: 25_000, to: 75_000 }, whole, 0.1, 0.5)).toEqual(whole);
    const small = zoom({ from: 0, to: 3000 }, { from: 0, to: 3000 }, 1000, 0.5);
    expect(small.to - small.from).toBe(1000);
    expect(pan({ from: 25_000, to: 75_000 }, whole, 1)).toEqual({ from: 50_000, to: 100_000 });
    expect(pan({ from: 0, to: 50_000 }, whole, -1)).toEqual({ from: 0, to: 50_000 });
  });
  it("makes whole steps, from the person's midnight", () => {
    const hour = 3_600_000;
    expect(ticks({ from: 0, to: 4 * hour }, 4)).toEqual([0, hour, 2 * hour, 3 * hour, 4 * hour]);
    // Two hours east of UTC: a step of a day starts at 22:00 UTC the day before.
    expect(ticks({ from: 0, to: 3 * 86_400_000 }, 4, 2 * hour)[0]).toBe(86_400_000 - 2 * hour);
  });
});

describe("timeline of a goal", () => {
  const attempt = (id: string, taskId: string, over: Partial<Attempt>): Attempt => ({
    id, taskId, kind: "work", agent: "writer", state: "succeeded", round: 1, runner: null, engine: null, model: null, result: null, failure: null, usage: { microUsd: 100, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }, priced: true,
    createdAt: 0, startedAt: 0, finishedAt: 0, ...over,
  });
  const task = (id: string, extra: object = {}) => ({ id, parentId: "root", title: id, agent: "writer", state: "done", needs: null, waitsFor: [], ...extra });
  const record = {
    ...task("root", { parentId: null, agent: null }), subtasks: [task("one"), task("two", { waitsFor: ["one"], agent: "checker" }), task("later", { state: "waiting" })],
    attempts: [
      attempt("a1", "one", { createdAt: 1000, startedAt: 2000, finishedAt: 5000, state: "failed" }),
      attempt("a2", "one", { createdAt: 5000, startedAt: 5000, finishedAt: 9000 }),
      attempt("a3", "two", { kind: "check", agent: "checker", createdAt: 9000, startedAt: 9000, finishedAt: 12_000 }),
    ],
    checks: [], approvals: [{ id: "ap", taskId: "one", tool: "deploy", standing: false, state: "approved", requestedAt: 6000, decidedAt: 8000 }],
    toolCalls: [{ id: "c1", attemptId: "a2", tool: "bash", outcome: "succeeded", at: 7000, output: null }],
  } as unknown as Task;

  it("draws a row for each task that ran, grouped by agent, a retry after its failed attempt, the wait for a person, the ticks, and counts what has not started", () => {
    const line = buildTimeline(record, 20_000);
    expect(line.groups.map((group) => [group.agent, group.rows.map((row) => row.taskId)])).toEqual([["writer", ["one"]], ["checker", ["two"]]]);
    const one = line.groups[0]?.rows[0];
    expect(one?.bars.map((bar) => [bar.id, bar.queuedAt, bar.start, bar.end, bar.lane, bar.retry])).toEqual([["a1", 1000, 2000, 5000, 0, false], ["a2", 5000, 5000, 9000, 0, true]]);
    expect(one?.waits).toEqual([{ id: "ap", taskId: "one", kind: "approval", tool: "deploy", from: 6000, to: 8000, open: false }]);
    expect(one?.ticks).toEqual([{ at: 7000, attemptId: "a2", tool: "bash", failed: false }]);
    expect(line.notStarted).toBe(1);
    expect(line.start).toBeLessThanOrEqual(1000);
    expect(line.end).toBeGreaterThanOrEqual(12_000);
    expect([...line.critical].sort()).toEqual(["one", "two"]);
  });
});
