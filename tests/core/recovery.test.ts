import type { JsonValue } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, fail, step, testClock } from "./work";

/**
 * What Brain does by itself so that nobody has to retry or work around (docs/model.md, "How work runs" and "When a task fails"): a plan that cannot work is made
 * again, a reviewer that says the same thing twice stops the rounds, a failure of the infrastructure is tried again for hours, and a heal task ends when its task is done.
 */
const clock = testClock();
const inventory = 'description = "Lists what exists."\neffect = "read"\n';
const agents = { planner: {}, analyst: {}, lister: { tools: ["inventory.list"] }, dev: {}, "workspace-healer": { tools: ["task.ask"] } };
const play = 'title = "Job"\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "Do the job."\nmax_rounds = 3\n';
let harness: Harness;
let driver: Driver;
let member: Client;
let workspaceId: string;

const plan = (agent: string): JsonValue => ({ summary: "One task.", tasks: [{ title: "List it", goal: "Use inventory.list to list what exists and report it.", agent, after: [] }] });

beforeAll(async () => {
  harness = await createHarness({ clock });
  ({ workspaceId } = await makeWorkspace(harness, "Recovery", { agents, tools: { "inventory.list": inventory }, plays: { job: play } }));
  member = await harness.member(workspaceId, "max@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass() });
});
afterAll(() => harness.close());

describe("a plan", () => {
  it("that gives a goal naming a tool to an agent without it is made again with the reason, and a person only sees the one that works", async () => {
    const findingsSeen: string[][] = [];
    driver.script({
      planner: ({ offer }) => { findingsSeen.push([...offer.task.findings]); return { output: plan(offer.task.findings.length === 0 ? "analyst" : "lister") }; },
      lister: () => "Listed.",
    });
    const { taskId } = await member.command("task.create", { workspaceId, goal: "Use inventory.list to see what exists" });
    await driver.drain();
    expect(findingsSeen[0]).toEqual([]);
    expect(findingsSeen[1]).toEqual(['Your earlier plan was refused: Task 1 of the plan gives a goal that names the tool inventory.list to the agent "analyst", which does not have it (agents that have it: lister). Make a plan that deals with it.']);
    const goal = await getTask(member, workspaceId, taskId);
    expect(goal.state).toBe("needs_you");
    expect(goal.needs).toMatchObject({ kind: "confirm-plan" });
    expect(goal.subtasks.map((subtask) => subtask.agent)).toEqual(["lister"]);
  });

  it("that cannot be mended after two more tries fails the goal with the last reason", async () => {
    driver.script({ planner: () => ({ output: plan("analyst") }), "workspace-healer": () => "no configuration cause" });
    const { taskId } = await member.command("task.create", { workspaceId, goal: "Use inventory.list again" });
    await driver.drain();
    const goal = await getTask(member, workspaceId, taskId);
    expect([goal.state, goal.result]).toEqual(["failed", expect.stringContaining("The plan could not be used: Task 1 of the plan gives a goal that names the tool inventory.list")]);
    expect(goal.attempts.filter((attempt) => attempt.kind === "plan")).toHaveLength(3);
  });
});

describe("a reviewer", () => {
  it("that says the same thing again stops the rounds, and the person is told why", async () => {
    const wanted = "The report claims six platform calls were made but none appears in the recorded tool calls; invoke each platform tool and show the real output.";
    driver.script({ dev: () => "Done, with a table.", reviewer: () => fail(wanted), checker: () => fail(`${wanted} Also fix the table.`) });
    const goal = await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "job" })).taskId);
    await driver.drain();
    const done = step(await getTask(member, workspaceId, goal.id), "do");
    // Round 1 failed, round 2 said the same: no round 3 although the step allows three.
    expect(done).toMatchObject({ state: "needs_you", round: 2, needs: { kind: "check", repeated: true } });
  });
});

describe("a failure of the infrastructure", () => {
  it("is tried again with a growing wait for about six hours instead of failing the task", async () => {
    let tries = 0;
    driver.script({ dev: () => { tries += 1; return tries < 8 ? { outcome: "failed" as const, result: "", failure: { reason: "engine" as const, detail: "model endpoint: Connection error.", infrastructure: true } } : "Done at last."; }, checker: () => pass() });
    const goal = await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "job" })).taskId);
    for (let i = 0; i < 12 && tries < 8; i += 1) { await driver.drain(); clock.advance(3_700_000); await harness.governor.gov.registry; }
    await driver.drain();
    const finished = step(await getTask(member, workspaceId, goal.id), "do");
    expect([tries, finished.state]).toEqual([8, "done"]);
  });
});

describe("a heal task", () => {
  it("ends by itself when the task it heals is done", async () => {
    let healed = false;
    driver.script({
      dev: () => (healed ? "Fine now." : { outcome: "failed" as const, result: "", failure: { reason: "limit" as const, detail: "Out of turns", infrastructure: false } }),
      "workspace-healer": async (turn) => { await turn.brain("task.ask", { question: "Is it the log?" }); return "I asked and wait."; },
    });
    const goal = await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "job" })).taskId);
    await driver.drain();
    const failed = step(await getTask(member, workspaceId, goal.id), "do");
    expect(failed.state).toBe("failed");
    const before = (await member.query("tasks.list", { workspaceId, rootsOnly: true, limit: 50 })).tasks.find((task) => task.heals?.id === failed.id);
    expect(before?.state).not.toBe("stopped");
    healed = true;
    await member.command("task.retry", { workspaceId, taskId: failed.id });
    await driver.drain();
    expect(step(await getTask(member, workspaceId, goal.id), "do").state).toBe("done");
    const after = (await member.query("tasks.list", { workspaceId, rootsOnly: true, limit: 50 })).tasks.find((task) => task.heals?.id === failed.id);
    expect(after?.state).toBe("stopped");
  });
});
