import type { JobOffer, Queue, QueueItem, Wait } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step, testClock } from "./work";

/** The queue (docs/model.md, "The queue"): the order work starts in, why a task waits, what pauses and limits do, and what a person is told when a limit stops work. */
const clock = testClock();
const one = (agent: string) => `title = "One step"\n[[step]]\nid = "work"\nagent = "${agent}"\ngoal = "Do the work."\n`;
const two = 'title = "Two steps"\n[[step]]\nid = "first"\nagent = "dev"\ngoal = "First."\n[[step]]\nid = "second"\nagent = "dev"\nafter = ["first"]\ngoal = "Second."\n';
const docker = 'description = "Lists containers."\neffect = "read"\nneeds = ["docker"]\n';

let harness: Harness;
let driver: Driver | undefined;
let alpha: { workspaceId: string };
let beta: { workspaceId: string };
let ann: Client;
let bob: Client;

const goal = async (client: Client, workspaceId: string, play = "one"): Promise<string> => step(await getTask(client, workspaceId, (await client.command("task.create", { workspaceId, play })).taskId), "work").id;
const waiting = async (client: Client, workspaceId?: string): Promise<Queue> => client.query("queue", workspaceId === undefined ? {} : { workspaceId });
const itemOf = (queue: Queue, taskId: string): QueueItem => queue.waiting.find((item) => item.taskId === taskId) as QueueItem;
const waitOf = async (client: Client, taskId: string): Promise<Wait> => itemOf(await waiting(client), taskId).wait;
/** The tasks the runner is offered, in order, one after the other with none finished; then they are all run to their end. */
const claimed = async (): Promise<string[]> => {
  const offers: JobOffer[] = [];
  for (let offer = await (driver as Driver).claim(); offer; offer = await (driver as Driver).claim()) offers.push(offer);
  for (const offer of offers) { await (driver as Driver).ack(offer); await (driver as Driver).finish(offer); }
  await (driver as Driver).drain();
  return offers.map((offer) => offer.task.id);
};

beforeAll(async () => {
  harness = await createHarness({ clock });
  const agents = { dev: {}, needy: { tools: ["docker.ps"] }, costly: { spend: 0.6 } };
  const plays = { one: one("dev"), two, needy: one("needy"), costly: one("costly") };
  alpha = await makeWorkspace(harness, "Alpha", { agents, plays, tools: { "docker.ps": docker } });
  beta = await makeWorkspace(harness, "Beta", { agents, plays, tools: { "docker.ps": docker } });
  ann = await harness.member(alpha.workspaceId, "ann@example.com", "member");
  bob = await harness.member(beta.workspaceId, "bob@example.com", "member");
});
afterAll(() => harness.close());

describe("the queue", () => {
  it("says no runner is online when none is, and gives no estimated start it cannot know", async () => {
    const task = await goal(ann, alpha.workspaceId);
    const item = itemOf(await waiting(ann), task);
    expect(item).toMatchObject({ wait: { kind: "no-runner" }, rank: 1, startsAt: null, priority: "normal", canSteer: true });
    driver = await enrolRunner(harness, { checker: () => pass(), dev: () => "Done.", costly: () => "Done." });
    await (driver as Driver).drain();
  });

  it("starts work by priority, then lets the workspaces take turns, then oldest first", async () => {
    const a = [await goal(ann, alpha.workspaceId), await goal(ann, alpha.workspaceId), await goal(ann, alpha.workspaceId)];
    const b = await goal(bob, beta.workspaceId);
    // Fair share: Beta's one task goes before Alpha's second, although it is younger.
    expect(await claimed()).toEqual([a[0], b, a[1], a[2]]);
    await (driver as Driver).drain();

    const c = [await goal(ann, alpha.workspaceId), await goal(ann, alpha.workspaceId), await goal(ann, alpha.workspaceId)];
    await ann.command("task.steer", { workspaceId: alpha.workspaceId, taskId: c[2] as string, priority: "high" });
    await ann.command("task.steer", { workspaceId: alpha.workspaceId, taskId: c[0] as string, priority: "low" });
    const queue = await waiting(ann);
    expect(c.map((id) => itemOf(queue, id))).toMatchObject([{ rank: 3, priority: "low" }, { rank: 2, priority: "normal" }, { rank: 1, priority: "high", wait: { kind: "slot", ahead: 0 } }]);
    expect(await claimed()).toEqual([c[2], c[1], c[0]]);
    await (driver as Driver).drain();

    // Of two `high` tasks the one promoted last goes first.
    const d = [await goal(ann, alpha.workspaceId), await goal(ann, alpha.workspaceId)];
    for (const id of d) await ann.command("task.steer", { workspaceId: alpha.workspaceId, taskId: id, priority: "high" });
    expect(await claimed()).toEqual([d[1], d[0]]);
    await (driver as Driver).drain();
  });

  it("holds a paused task and a paused workspace, and starts them again when resumed", async () => {
    const task = await goal(ann, alpha.workspaceId);
    await ann.command("task.steer", { workspaceId: alpha.workspaceId, taskId: task, paused: true });
    expect(await waitOf(ann, task)).toEqual({ kind: "paused-task" });
    expect(await claimed()).toEqual([]);
    await ann.command("task.steer", { workspaceId: alpha.workspaceId, taskId: task, paused: false });
    expect(await claimed()).toEqual([task]);
    await (driver as Driver).drain();

    const brain = (await harness.admin.query("file.read", { workspaceId: beta.workspaceId, path: "brain.toml" })).content;
    const write = (content: string) => harness.admin.command("file.write", { workspaceId: beta.workspaceId, files: [{ path: "brain.toml", content }] });
    await write(`${brain}\n[limits]\npaused = true\n`);
    const held = await goal(bob, beta.workspaceId);
    expect(await waitOf(bob, held)).toEqual({ kind: "paused-workspace" });
    expect((await waiting(bob, beta.workspaceId)).paused).toMatchObject([{ slug: "beta" }]);
    expect(await claimed()).toEqual([]);
    await write(brain);
    expect(await claimed()).toEqual([held]);
    await (driver as Driver).drain();
  });

  it("says why a task waits: a capability no runner has, the daily cap, the tasks at once, another task, a retry later", async () => {
    const needy = await goal(ann, alpha.workspaceId, "needy");
    expect(await waitOf(ann, needy)).toEqual({ kind: "capability", missing: "the capability docker" });
    await ann.command("task.stop", { workspaceId: alpha.workspaceId, taskId: needy });

    const brain = (await harness.admin.query("file.read", { workspaceId: beta.workspaceId, path: "brain.toml" })).content;
    await harness.admin.command("file.write", { workspaceId: beta.workspaceId, files: [{ path: "brain.toml", content: `${brain}\n[limits]\ndaily_spend_usd = 0.5\nrunning_tasks = 1\n` }] });
    const costly = await goal(bob, beta.workspaceId, "costly");
    expect(await waitOf(bob, costly)).toEqual({ kind: "daily-cap", spentMicroUsd: 0, capMicroUsd: 500_000 });
    await bob.command("task.stop", { workspaceId: beta.workspaceId, taskId: costly });
    const first = await goal(bob, beta.workspaceId);
    const second = await goal(bob, beta.workspaceId);
    const offer = (await (driver as Driver).claim()) as JobOffer;
    expect(offer.task.id).toBe(first);
    expect(await waitOf(bob, second)).toEqual({ kind: "running-tasks", used: 1, limit: 1 });
    expect(await (driver as Driver).claim()).toBeNull();
    await (driver as Driver).ack(offer);
    await (driver as Driver).finish(offer);
    await (driver as Driver).drain();
    await harness.admin.command("file.write", { workspaceId: beta.workspaceId, files: [{ path: "brain.toml", content: brain }] });

    const chained = (await ann.command("task.create", { workspaceId: alpha.workspaceId, play: "two" })).taskId;
    const detail = await getTask(ann, alpha.workspaceId, chained);
    const blocked = (await waiting(ann)).blocked.find((item) => item.taskId === step(detail, "second").id);
    expect(blocked).toMatchObject({ rank: null, wait: { kind: "task", title: "first" } });
    await (driver as Driver).drain();

    // A failure of the infrastructure is retried later, and the queue says when.
    (driver as Driver).script({ dev: () => ({ outcome: "failed", result: "", failure: { reason: "runner", detail: "The runner was lost", infrastructure: true } }) });
    const flaky = await goal(ann, alpha.workspaceId);
    await (driver as Driver).step();
    expect(await waitOf(ann, flaky)).toMatchObject({ kind: "backoff", tries: 1, until: clock.now + 5_000 });
    (driver as Driver).script({ dev: () => "Done." });
    clock.advance(5_000);
    await (driver as Driver).drain();
  });

  it("shows a person only their workspaces' tasks, and counts the others", async () => {
    await goal(ann, alpha.workspaceId);
    const mine = await waiting(bob);
    expect(mine.waiting.every((item) => item.workspaceSlug === "beta")).toBe(true);
    expect(mine.hidden).toBeGreaterThan(0);
    expect((await waiting(harness.admin)).hidden).toBe(0);
    await expect(waiting(bob, alpha.workspaceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await (driver as Driver).drain();
  });
});

describe("a limit that stops work", () => {
  it("names the limit, its value and what was used, and where the agent's limits are set", async () => {
    await harness.admin.command("file.write", { workspaceId: alpha.workspaceId, files: [
      { path: "agents/frugal/agent.toml", content: 'description = "Frugal."\nengine = ["fixture"]\n[limits]\nturns = 5\ntokens = 1000\n' }, { path: "agents/frugal/prompt.md", content: "You are frugal.\n" },
      { path: "plays/frugal.toml", content: one("frugal") },
    ] });
    (driver as Driver).script({ frugal: () => ({ outcome: "failed", result: "", failure: { reason: "limit", detail: "stopped", infrastructure: false }, usage: { inputTokens: 900, outputTokens: 80, microUsd: 0 } }) } as never);
    const task = await goal(ann, alpha.workspaceId, "frugal");
    await (driver as Driver).step();
    const attempt = (await getTask(ann, alpha.workspaceId, task)).attempts[0];
    expect(attempt?.failure).toMatchObject({ reason: "limit", limit: { name: "agent.tokens", value: 1000, used: 980, agent: "frugal" } });
    (driver as Driver).script({ frugal: () => ({ outcome: "failed", result: "", failure: { reason: "limit", detail: "stopped", infrastructure: false } }) } as never);
    await ann.command("task.retry", { workspaceId: alpha.workspaceId, taskId: task });
    await (driver as Driver).step();
    expect((await getTask(ann, alpha.workspaceId, task)).attempts.at(-1)?.failure).toMatchObject({ limit: { name: "agent.turns", value: 5, agent: "frugal" } });
  });
});
