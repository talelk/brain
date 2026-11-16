import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step } from "./work";

/** What the Tasks, Today and Task screens read: who started a goal, its title, what waits for a person, search, and the plan as one edit. */
let harness: Harness;
let member: Client;
let workspaceId: string;
let driver: Driver;
const restart = 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n';
const plays = {
  fix: 'title = "Fix an issue"\n[inputs.issue]\ntype = "string"\nrequired = true\n[[step]]\nid = "fix"\nagent = "writer"\ngoal = "Fix: {{issue}}"\n',
  signed: 'title = "Signed"\n[[step]]\nid = "write"\nagent = "writer"\napprove = true\ngoal = "Write."\n',
  operate: 'title = "Operate"\n[[step]]\nid = "restart"\nagent = "operator"\ngoal = "Restart."\n',
};

beforeAll(async () => {
  harness = await createHarness();
  ({ workspaceId } = await makeWorkspace(harness, "Views", { agents: { writer: {}, editor: {}, planner: {}, operator: { tools: ["deploy.restart"] } }, tools: { "deploy.restart": restart }, plays }));
  member = await harness.member(workspaceId, "max@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass(), planner: () => ({ output: { summary: "One part.", tasks: [{ title: "Only", goal: "Do it.", agent: "writer", after: [] }] } }) });
});
afterAll(() => harness.close());

describe("task views", () => {
  it("a goal says who started it, and a goal started from a Play is titled by the Play and its first text input", async () => {
    const { taskId } = await member.command("task.create", { workspaceId, play: "fix", inputs: { issue: "The login page  shows\nan error after a reset, always." } });
    const task = await getTask(member, workspaceId, taskId);
    expect(task).toMatchObject({ title: "Fix an issue: The login page shows", createdByName: "max", goalTitle: "Fix an issue: The login page shows" });
    expect(task.subtasks[0]).toMatchObject({ createdByName: "max", goalTitle: task.title, goal: "Fix: The login page  shows\nan error after a reset, always.", waitsFor: [] });
    const long = (await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "fix", inputs: { issue: "x".repeat(100) } })).taskId)).title;
    expect(long).toBe(`Fix an issue: ${"x".repeat(39)}…`);
    expect((await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "fix", inputs: { issue: "The login page does not load after the last deploy" } })).taskId)).title).toBe("Fix an issue: The login page does not load after the…");
    expect((await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "signed" })).taskId)).title).toBe("Signed");
    expect((await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, goal: "\nWrite the report\nin two parts" })).taskId)).title).toBe("Write the report");
    expect((await member.query("tasks.list", { workspaceId, rootsOnly: true, limit: 1 })).tasks[0]?.createdByName).toBe("max");
  });

  it("a goal counts the tasks under it that wait for a person; Today lists it as waiting, not as running", async () => {
    driver.script({ writer: () => "A draft." });
    const { taskId } = await member.command("task.create", { workspaceId, play: "signed" });
    await driver.drain();
    const task = await getTask(member, workspaceId, taskId);
    expect(task).toMatchObject({ state: "running", waitingForYou: 1 });
    expect(step(task, "write")).toMatchObject({ state: "needs_you", waitingForYou: 1, goalTitle: "Signed" });
    const today = await member.query("today", { workspaceId });
    expect(today.running.map((goal) => goal.id)).not.toContain(taskId);
    expect(today.needsYou.filter((entry) => entry.rootId === taskId)).toMatchObject([{ goalTitle: "Signed", needs: { kind: "sign-off" } }]);
    // The Tasks filters agree with Today: such a goal is found under "needs you", not under "running".
    expect((await member.query("tasks.list", { workspaceId, rootsOnly: true, state: "needs_you" })).tasks.map((goal) => goal.id)).toContain(taskId);
    expect((await member.query("tasks.list", { workspaceId, rootsOnly: true, state: "running" })).tasks.map((goal) => goal.id)).not.toContain(taskId);
    await member.command("task.check", { workspaceId, taskId: step(task, "write").id, pass: true });
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "done", waitingForYou: 0 });
  });

  it("an approval and a note say which goal and which task they belong to", async () => {
    driver.script({ operator: async ({ tool }) => { await tool("deploy.restart", { container: "db" }); return { outcome: "held", result: "Waiting." }; } });
    const { taskId } = await member.command("task.create", { workspaceId, play: "operate" });
    await driver.drain();
    const task = await getTask(member, workspaceId, taskId);
    const [approval] = (await member.query("approvals.list", { workspaceId, state: "pending" })).approvals;
    expect(approval).toMatchObject({ taskId: step(task, "restart").id, rootTaskId: taskId, goalTitle: "Operate", taskTitle: "restart" });
    expect(task.approvals[0]).toMatchObject({ rootTaskId: taskId, goalTitle: "Operate" });
  });

  it("search matches the title or the goal text in SQL, with paging that counts only the matches", async () => {
    for (const goal of ["Tidy the garden shed", "Plan 50% off week", "Plan a_b test", "Plan the picnic"]) await member.command("task.create", { workspaceId, goal });
    const find = async (search: string, limit = 50, rootsOnly = true): Promise<string[]> => (await member.query("tasks.list", { workspaceId, search, rootsOnly, limit })).tasks.map((task) => task.title);
    expect(await find("GARDEN")).toEqual(["Tidy the garden shed"]);
    expect(await find("50%")).toEqual(["Plan 50% off week"]);
    expect(await find("a_b")).toEqual(["Plan a_b test"]);
    expect(await find("plan")).toHaveLength(3);
    // A match in the goal text, not the title; and the page holds the newest matches, not the newest tasks filtered afterwards.
    expect(await find("Restart.", 50, false)).toEqual(["restart"]);
    expect(await find("plan", 2)).toEqual(["Plan the picnic", "Plan a_b test"]);
    const older = (await member.query("tasks.list", { workspaceId, search: "plan", rootsOnly: true, limit: 2, before: Date.now() + 1 })).tasks;
    expect(older).toHaveLength(2);
    expect((await member.query("tasks.list", { workspaceId, rootsOnly: true })).tasks.every((task) => task.parentId === null)).toBe(true);
    expect((await member.query("tasks.list", { workspaceId })).tasks.some((task) => task.parentId !== null)).toBe(true);
  });

  it("a plan is edited as one edit in any order, and sub-tasks carry what the plan editor shows", async () => {
    driver.script({ planner: () => ({ output: { summary: "Three parts.", tasks: [{ title: "One", goal: "First.", agent: "writer", after: [] }, { title: "Two", goal: "Second.", agent: "writer", after: ["One"] }, { title: "Three", goal: "Third.", agent: "editor", after: ["Two"] }] } }) });
    const { taskId } = await member.command("task.create", { workspaceId, goal: "Do three things" });
    await driver.drain();
    const planned = await getTask(member, workspaceId, taskId);
    expect(planned.notes).toMatchObject([{ author: "planner", taskId }]);
    const [one, two, three] = planned.subtasks;
    expect(three).toMatchObject({ goal: "Third.", waitsFor: [two?.id], agent: "editor" });
    // Swap Two and Three: each change is valid only together with the other, and the order they are listed in does not matter.
    const swap = [{ op: "change" as const, id: two?.id ?? "", after: [three?.id ?? ""] }, { op: "change" as const, id: three?.id ?? "", after: [one?.id ?? ""] }];
    await member.command("task.edit", { workspaceId, taskId, changes: swap });
    expect((await getTask(member, workspaceId, taskId)).subtasks.map((task) => [task.title, task.waitsFor])).toEqual([["One", []], ["Two", [three?.id]], ["Three", [one?.id]]]);
    await member.command("task.edit", { workspaceId, taskId, changes: [...swap].reverse().map((change) => ({ ...change, after: change.id === two?.id ? [one?.id ?? ""] : [two?.id ?? ""] })) });
    // A circle is refused as a whole, and nothing of the edit stays; a removed sub-task cannot be waited for.
    const before = (await getTask(member, workspaceId, taskId)).subtasks.map((task) => task.waitsFor);
    await expect(member.command("task.edit", { workspaceId, taskId, changes: [{ op: "change", id: one?.id ?? "", after: [three?.id ?? ""] }, { op: "change", id: three?.id ?? "", title: "Renamed" }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(member.command("task.edit", { workspaceId, taskId, changes: [{ op: "change", id: three?.id ?? "", after: [two?.id ?? ""] }, { op: "remove", id: two?.id ?? "" }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const after = await getTask(member, workspaceId, taskId);
    expect(after.subtasks.map((task) => task.waitsFor)).toEqual(before);
    expect(after.subtasks.map((task) => task.title)).toEqual(["One", "Two", "Three"]);
  });
});
