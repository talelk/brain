import type { Insights } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { makeWorkspace, pass, testClock } from "./work";

/** Insights (docs/model.md, "The timeline and Insights"): counts, percentiles and ranges over rows with known times, and only the caller's workspaces. */
const clock = testClock(Date.UTC(2026, 10, 16, 9, 0, 0));
const DAY = 86_400_000;
const MONDAY_NINE = Date.UTC(2026, 10, 16, 9, 0, 0);
const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
const one = (agent: string) => `title = "One step"\n[[step]]\nid = "work"\nagent = "${agent}"\ngoal = "Do the work."\n`;
const plays = { quick: one("fast"), bad: one("broken"), operate: one("operator") };
const agents = { fast: {}, broken: {}, operator: { tools: ["deploy.restart"] } };
/** How long each run of the `fast` agent takes, in order. */
const runs = [50, 10, 20, 30, 40, 5];
const limit = { outcome: "failed" as const, result: "", failure: { reason: "limit" as const, detail: "Out of turns", infrastructure: false } };

let harness: Harness;
let alpha: { workspaceId: string };
let beta: { workspaceId: string };
let ann: Client;
let bob: Client;
let driver: Driver;

/** A goal started now, left waiting for five seconds for a runner, then run. */
async function goal(by: Client, workspaceId: string, play: string): Promise<string> {
  const { taskId } = await by.command("task.create", { workspaceId, play, inputs: {} });
  clock.advance(5000);
  await driver.drain();
  return taskId;
}

beforeAll(async () => {
  harness = await createHarness({ clock });
  const brain = '[healing]\nmode = "off"\n';
  alpha = await makeWorkspace(harness, "Alpha", { agents, plays, brain, tools: { "deploy.restart": restart } });
  beta = await makeWorkspace(harness, "Beta", { agents, plays, brain, tools: { "deploy.restart": restart } });
  ann = await harness.member(alpha.workspaceId, "ann@example.com", "member");
  bob = await harness.member(beta.workspaceId, "bob@example.com", "member");
  let next = 0;
  driver = await enrolRunner(harness, {
    checker: () => pass(),
    fast: () => { clock.advance((runs[next++] as number) * 1000); return "Done."; },
    broken: () => limit,
    operator: ({ tool }) => tool("deploy.restart", { container: "db" }).then(() => ({ outcome: "held" as const, result: "Waiting." })),
  });
  // One run long before the window of 7 or 30 days: 40 days earlier.
  clock.now = MONDAY_NINE - 40 * DAY;
  await goal(ann, alpha.workspaceId, "quick");
  // Monday at nine: two goals that finish, one a limit stops, one that asks for an approval. Tuesday at nine: two more.
  clock.now = MONDAY_NINE;
  await goal(ann, alpha.workspaceId, "quick");
  await goal(ann, alpha.workspaceId, "quick");
  await goal(ann, alpha.workspaceId, "bad");
  await goal(ann, alpha.workspaceId, "operate");
  clock.now = MONDAY_NINE + DAY;
  await goal(ann, alpha.workspaceId, "quick");
  await goal(ann, alpha.workspaceId, "quick");
  await goal(bob, beta.workspaceId, "quick");
  clock.advance(60_000);
});
afterAll(() => harness.close());

const ask = (client: Client, days: 7 | 30 | 90, extra: { workspaceId?: string; tzOffsetMinutes?: number } = {}): Promise<Insights> => client.query("insights", { days, ...extra });
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

describe("insights", () => {
  it("refuses nobody signed in and a workspace the person is not in", async () => {
    await expect(harness.anonymous.query("insights", { days: 7 })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(ann.query("insights", { workspaceId: beta.workspaceId, days: 7 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("counts goals per day and leaves out what is older than the range", async () => {
    const week = await ask(ann, 7);
    expect(week.days).toHaveLength(7);
    expect(week.days.at(-1)).toBe("2026-11-17");
    expect(week.calendar.slice(-2)).toEqual([4, 2]);
    expect(week.totals).toMatchObject({ goals: 6, done: 4, asked: 1 });
    expect(sum((await ask(ann, 30)).calendar)).toBe(6);
    const quarter = await ask(ann, 90);
    expect(quarter.days).toHaveLength(90);
    expect(quarter.totals.goals).toBe(7);
    expect(quarter.calendar[quarter.days.indexOf("2026-10-07")]).toBe(1);
  });

  it("shows only the workspaces the person is in, and one when asked", async () => {
    expect((await ask(bob, 30)).totals.goals).toBe(1);
    expect((await ask(ann, 30, { workspaceId: alpha.workspaceId })).totals.goals).toBe(6);
    expect((await ask(harness.admin, 30)).totals.goals).toBe(7);
    expect((await ask(ann, 30)).byWorkspace.map((rank) => rank.label)).toEqual(["Alpha"]);
  });

  it("reads the hour and the weekday in the person's own day", async () => {
    const utc = await ask(ann, 30);
    // Monday is 0: nine o'clock UTC on a Monday and on a Tuesday.
    expect(utc.load[0 * 24 + 9]).toBeGreaterThan(0);
    expect(utc.load[1 * 24 + 9]).toBeGreaterThan(0);
    expect(sum(utc.load)).toBe(utc.totals.attempts);
    const ahead = await ask(ann, 30, { tzOffsetMinutes: 180 });
    expect(ahead.load[0 * 24 + 12]).toBe(utc.load[0 * 24 + 9]);
    expect(ahead.load[0 * 24 + 9]).toBe(0);
    // Late on Tuesday in a zone behind UTC is still Monday there.
    expect((await ask(ann, 30, { tzOffsetMinutes: -600 })).days.at(-1)).toBe("2026-11-16");
  });

  it("gives p50 and p90 by nearest rank, per Play and per agent", async () => {
    const month = await ask(ann, 30);
    // The fast agent ran 10, 20, 30 and 40 seconds in the window: place ceil(0.5 x 4) = 2 and ceil(0.9 x 4) = 4.
    expect(month.agentDurations.find((row) => row.key === "fast")).toEqual({ key: "fast", label: "fast", n: 4, p50: 20_000, p90: 40_000 });
    // A goal of that Play also waited five seconds to start.
    expect(month.playDurations.find((row) => row.key === "quick")).toMatchObject({ n: 4, p50: 25_000, p90: 45_000 });
    // With the run of 40 days earlier (50 seconds): ceil(0.5 x 5) = 3 and ceil(0.9 x 5) = 5.
    expect((await ask(ann, 90)).agentDurations.find((row) => row.key === "fast")).toMatchObject({ n: 5, p50: 30_000, p90: 50_000 });
  });

  it("ranks where time and money go, with a value for every day", async () => {
    const month = await ask(ann, 30);
    const fast = month.byAgent.find((rank) => rank.key === "fast");
    expect(fast).toMatchObject({ attempts: 4, ms: 100_000 });
    expect(fast?.msPerDay).toHaveLength(30);
    expect(sum(fast?.msPerDay ?? [])).toBe(100_000);
    expect(fast?.msPerDay.at(-1)).toBe(70_000);
    expect(month.byPlay.map((rank) => rank.label)).toEqual(expect.arrayContaining(["One step"]));
    expect(month.byTool.map((row) => row.tool)).toContain("deploy.restart");
  });

  it("measures the wait for a runner by day", async () => {
    const week = await ask(ann, 7);
    // Per day the work waited five seconds and its check none.
    expect(week.queueWait.at(-1)).toMatchObject({ n: 4, p50: 0, p90: 5000 });
    expect(week.queueWait.at(0)).toEqual({ n: 0, p50: 0, p90: 0 });
  });

  it("buckets failures by why they failed, with the failing tasks", async () => {
    const week = await ask(ann, 7);
    expect(week.failures).toHaveLength(1);
    expect(week.failures[0]).toMatchObject({ bucket: "limits", count: 1, tasks: [{ title: "work", workspaceSlug: expect.any(String) }] });
    expect((await ask(ann, 7)).outcomes.at(-2)?.asked).toBe(1);
  });
});
