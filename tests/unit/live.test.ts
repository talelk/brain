import { describe, expect, it } from "vitest";
import type { Overview, Queue, TaskSummary } from "@brain/contracts";
import { activityBuckets, feedEvents, flowLinks, goalStates, groupFeed, newlyDone, pushSamples, stageCounts, successRate, type Placed } from "../../apps/web/src/lib/live";

const NOW = 10 * 3_600_000;
const task = (id: string, over: Partial<TaskSummary> = {}): Placed => ({
  slug: "shop", name: "Shop",
  task: { id, workspaceId: "w", parentId: "g", rootId: "g", title: id, goalTitle: "Ship it", agent: "dev", state: "done", needs: null, play: null, stepId: null, round: 1, microUsd: 0, createdAt: NOW - 60_000, updatedAt: NOW - 30_000, finishedAt: NOW - 30_000, waitingForYou: 0, ...over } as unknown as TaskSummary,
});
const queue = (running: number, kinds: string[], waiting: number): Queue => ({
  now: NOW, running, waiting: Array.from({ length: waiting }, () => ({}) as never), blocked: [], hidden: 0, paused: [], admin: true,
  runners: [{ id: "r", name: "r", online: true, slots: 2, freeSlots: 0, engines: [], capabilities: [], hiddenOccupied: 0, occupied: kinds.map((kind, index) => ({ attemptId: `a${index}`, kind, tokens: 10 }) as never) }],
});
const overview = (needs: number[]): Overview => ({ workspaces: needs.map((needsYou) => ({ needsYou }) as never), needsYou: [], running: [], health: null });

describe("Live: the flow", () => {
  it("counts the queue now, what needs a person, and what ended in the last hour", () => {
    const tasks = [task("a"), task("b", { state: "failed" }), task("c", { finishedAt: NOW - 2 * 3_600_000, updatedAt: NOW - 2 * 3_600_000 }), task("g", { parentId: null })];
    expect(stageCounts(queue(2, ["work", "check"], 3), overview([1, 2]), tasks, NOW)).toEqual({ queued: 3, running: 1, checking: 1, needs: 3, done: 1, failed: 1 });
  });
  it("draws a ribbon only into a stage something reached, as wide as it is", () => {
    const links = flowLinks({ queued: 4, running: 1, checking: 0, needs: 2, done: 3, failed: 0 });
    expect(links.map((link) => `${link.from}>${link.to}:${link.value}`)).toEqual(["queued>running:6", "running>needs:2", "running>done:3"]);
  });
});

describe("Live: the feed", () => {
  it("makes one event per task that did something and none for one that waits", () => {
    const events = feedEvents([task("a"), task("b", { state: "waiting" }), task("c", { state: "needs_you", needs: { kind: "approval", approvalId: "x" } }), task("g", { parentId: null, state: "needs_you", needs: { kind: "sign-off" } })]);
    expect(events.map((event) => event.kind).sort()).toEqual(["approval", "task-done"]);
  });
  it("shows a hundred equal events as one line with a count, and the same event seen twice once", () => {
    const many = Array.from({ length: 100 }, (_, index) => task(`t${index}`, { title: "build", finishedAt: NOW - index * 1000 }));
    const events = feedEvents([...many, ...many]);
    const groups = groupFeed(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(100);
  });
  it("keeps different goals and kinds apart, newest first, and at most the limit", () => {
    const events = feedEvents([task("a", { goalTitle: "One", finishedAt: NOW - 1000 }), task("b", { goalTitle: "Two", finishedAt: NOW - 2000 }), task("c", { goalTitle: "One", state: "failed", finishedAt: NOW - 3000 })]);
    expect(groupFeed(events).map((group) => group.id)).toEqual(["a:done", "b:done", "c:failed"]);
    expect(groupFeed(events, 2)).toHaveLength(2);
  });
  it("counts events per five minutes of the last hour, oldest first", () => {
    const events = feedEvents([task("a", { finishedAt: NOW - 1000 }), task("b", { finishedAt: NOW - 6 * 60_000 }), task("c", { finishedAt: NOW - 61 * 60_000 })]);
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
  it("finds the goals that finished between two looks, never on the first", () => {
    const before = goalStates([task("g", { parentId: null, state: "running" }), task("h", { parentId: null, state: "done" })]);
    const after = [task("g", { parentId: null, state: "done" }), task("h", { parentId: null, state: "done" })];
    expect(newlyDone(undefined, after)).toEqual([]);
    expect(newlyDone(before, after)).toEqual(["g"]);
  });
  it("gives a success rate only when something ended", () => {
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(3, 1)).toBe(0.75);
  });
});
