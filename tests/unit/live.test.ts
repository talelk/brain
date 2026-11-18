import { describe, expect, it } from "vitest";
import type { Overview, OverviewEvent, Queue } from "@brain/contracts";
import { activityBuckets, feedEvents, flowLinks, groupFeed, mergeEvents, newGoals, pushSamples, stageCounts, successRate } from "../../apps/web/src/lib/live";

const NOW = 10 * 3_600_000;
const PLACES = new Map([["w", { slug: "shop", name: "Shop" }]]);
let next = 1;
const event = (over: Partial<OverviewEvent> = {}): OverviewEvent => ({ id: next++, at: NOW - 30_000, type: "task.done", workspaceId: "w", taskId: "t", rootId: "g", goalTitle: "Ship it", title: "build", agent: "dev", goal: false, need: null, pass: null, ...over });
const queue = (running: number, kinds: string[], waiting: number): Queue => ({
  now: NOW, running, waiting: Array.from({ length: waiting }, () => ({}) as never), blocked: [], hidden: 0, paused: [], admin: true,
  runners: [{ id: "r", name: "r", online: true, slots: 2, freeSlots: 0, engines: [], capabilities: [], hiddenOccupied: 0, occupied: kinds.map((kind, index) => ({ attemptId: `a${index}`, kind, tokens: 10 }) as never) }],
});
const overview = (workspaces: Array<{ needsYou: number; done?: number; failed?: number }>): Overview => ({
  workspaces: workspaces.map((workspace) => ({ needsYou: workspace.needsYou, lastHour: { done: workspace.done ?? 0, failed: workspace.failed ?? 0 } }) as never), needsYou: [], running: [], events: [], goalsDone: [], health: null,
});

describe("Live: the flow", () => {
  it("counts the queue now, what needs a person, and what ended in the last hour as the Governor counted it", () => {
    expect(stageCounts(queue(2, ["work", "check"], 3), overview([{ needsYou: 1, done: 40, failed: 2 }, { needsYou: 2, done: 300 }]))).toEqual({ queued: 3, running: 1, checking: 1, needs: 3, done: 340, failed: 2 });
  });
  it("draws a ribbon only into a stage something reached, as wide as it is", () => {
    const links = flowLinks({ queued: 4, running: 1, checking: 0, needs: 2, done: 3, failed: 0 });
    expect(links.map((link) => `${link.from}>${link.to}:${link.value}`)).toEqual(["queued>running:6", "running>needs:2", "running>done:3"]);
  });
});

describe("Live: the feed", () => {
  it("makes a line for a task that finished, failed, was checked, needs a person or had a call approved, and none for a goal that merely waits", () => {
    const events = feedEvents([
      event({ type: "task.done" }), event({ type: "task.failed", goal: true }), event({ type: "task.checked", pass: true }), event({ type: "task.checked", pass: false }),
      event({ type: "task.needs_you", need: "approval" }), event({ type: "task.needs_you", need: "sign-off", goal: true }), event({ type: "approval.approved" }), event({ workspaceId: "elsewhere" }),
    ], PLACES);
    expect(events.map((line) => line.kind).sort()).toEqual(["approval", "approved", "check-failed", "check-passed", "goal-failed", "task-done"]);
  });
  it("shows a hundred equal events as one line with a count, by their ids: the same id told again adds nothing, a new id adds one", () => {
    const told = Array.from({ length: 100 }, (_, index) => event({ id: 1000 + index, at: NOW - index * 1000 }));
    const lines = groupFeed(feedEvents([...told, ...told], PLACES));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.count).toBe(100);
    expect(groupFeed(feedEvents([...told, event({ id: 2000, at: NOW })], PLACES))[0]?.count).toBe(101);
  });
  it("keeps what was told between answers, each id once, forgets what is old, and bounds the list", () => {
    const first = [event({ id: 1, at: NOW - 1000 }), event({ id: 2, at: NOW - 2000 })];
    let kept = mergeEvents(new Map(), first, NOW);
    kept = mergeEvents(kept, [event({ id: 2, at: NOW - 2000 }), event({ id: 3, at: NOW }), event({ id: 4, at: NOW - 7 * 3_600_000 })], NOW);
    expect([...kept.keys()]).toEqual([3, 1, 2]);
    expect(mergeEvents(kept, [event({ id: 9, at: NOW })], NOW, undefined, 2).size).toBe(2);
  });
  it("keeps different goals and kinds apart, newest first, and at most the limit", () => {
    const events = feedEvents([event({ id: 11, goalTitle: "One", at: NOW - 1000 }), event({ id: 12, goalTitle: "Two", at: NOW - 2000 }), event({ id: 13, goalTitle: "One", type: "task.failed", at: NOW - 3000 })], PLACES);
    expect(groupFeed(events).map((group) => group.id)).toEqual([11, 12, 13]);
    expect(groupFeed(events, 2)).toHaveLength(2);
  });
  it("counts events per five minutes of the last hour, oldest first", () => {
    const events = feedEvents([event({ at: NOW - 1000 }), event({ at: NOW - 6 * 60_000 }), event({ at: NOW - 61 * 60_000 })], PLACES);
    const buckets = activityBuckets(events, NOW);
    expect(buckets).toHaveLength(12);
    expect(buckets.slice(-2)).toEqual([1, 1]);
    expect(buckets.reduce((sum, n) => sum + n, 0)).toBe(2);
  });
});

describe("Live: samples and goals", () => {
  it("keeps a bounded token history per running attempt and forgets one that ended", () => {
    let samples = pushSamples(new Map(), [{ attemptId: "a", tokens: 1 }, { attemptId: "b", tokens: 5 }], 3);
    for (const tokens of [2, 3, 4]) samples = pushSamples(samples, [{ attemptId: "a", tokens }], 3);
    expect([...samples]).toEqual([["a", [2, 3, 4]]]);
  });
  it("finds the goals that finished between two looks, never on the first, however many there were before", () => {
    const before = new Set(Array.from({ length: 50 }, (_, index) => `old${index}`));
    const after = [...before, "g"].map((id) => ({ id }));
    expect(newGoals(undefined, after)).toEqual([]);
    expect(newGoals(before, after)).toEqual(["g"]);
  });
  it("gives a success rate only when something ended", () => {
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(3, 1)).toBe(0.75);
  });
});
