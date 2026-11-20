import { MAX_ATTEMPTS, type TaskNeed } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import {
  afterCheck, afterPersonCheck, afterWork, repeats, backoffMs, checkerOf, doers, forEachItems, groupOutcome, promote, readJudgement, readPlan, readVerdict, renderGoal, resultObject, retryOf, whenHolds,
  type Scope, type StepSettings, type WorkFacts,
} from "../../apps/governor/src/tasks/decide";

const step: StepSettings = { agent: "writer", reviewBy: null, maxRounds: 2, targetScore: null, approve: false, candidates: null, judge: null };
const facts = (attempts: WorkFacts["attempts"], more: Partial<WorkFacts> = {}): WorkFacts => ({ attempts, question: null, openSubtasks: false, pendingApproval: null, acting: false, ...more });
const scope: Scope = {
  inputs: { issue: "Login fails", delivery: { pull_request: { number: 7 } } },
  steps: { route: { result: '```json\n{"category": "billing", "healthy": false, "tasks": [{"title": "a"}, {"title": "b"}]}\n```' }, plain: { result: "just text" }, gone: { result: "skipped" } },
  item: { title: "a" },
};

describe("results and templates", () => {
  it("a result is a JSON object when the whole answer parses as one, with or without a code fence", () => {
    expect(resultObject('{"pass": true}')).toEqual({ pass: true });
    expect(resultObject('```json\n{"pass": true}\n```')).toEqual({ pass: true });
    expect(resultObject("The answer is {\"pass\": true}")).toBeUndefined();
    expect(resultObject("[1, 2]")).toBeUndefined();
  });
  it("a goal's placeholders become inputs, earlier results, fields of them and the item; what does not resolve becomes nothing", () => {
    expect(renderGoal("Fix {{issue}} (#{{delivery.pull_request.number}}) as {{steps.route.result.category}}: {{item.title}}; {{steps.plain.result}}; [{{steps.gone.result}}{{steps.plain.result.x}}{{nope}}]", scope))
      .toBe("Fix Login fails (#7) as billing: a; just text; []");
    expect(renderGoal("{{issue}} then {{steps.route.result.category}}", scope, true)).toBe("Login fails then {{steps.route.result.category}}");
    // Text that came out of a placeholder is not read for placeholders again.
    expect(renderGoal("{{issue}}", { ...scope, inputs: { issue: "{{steps.plain.result}}" } })).toBe("{{steps.plain.result}}");
  });
  it("when compares one earlier value with a literal; a value that does not resolve makes == false and != true", () => {
    expect(whenHolds('steps.route.result.category == "billing"', scope)).toBe(true);
    expect(whenHolds('steps.route.result.category != "billing"', scope)).toBe(false);
    expect(whenHolds("steps.route.result.healthy == false", scope)).toBe(true);
    expect(whenHolds('steps.plain.result.category == "billing"', scope)).toBe(false);
    expect(whenHolds('steps.gone.result.category != "billing"', scope)).toBe(true);
  });
  it("for_each names a list in an earlier result; anything else is no items", () => {
    expect(forEachItems("steps.route.result.tasks", scope)).toEqual([{ title: "a" }, { title: "b" }]);
    expect(forEachItems("steps.route.result.category", scope)).toEqual([]);
    expect(forEachItems("steps.plain.result.tasks", scope)).toEqual([]);
  });
});

describe("a waiting task whose prerequisites are done", () => {
  it("becomes ready, or is skipped when its when is false", () => {
    expect(promote({ agent: "writer", when: null, forEach: null }, scope)).toEqual({ to: "ready" });
    expect(promote({ agent: "writer", when: 'steps.route.result.category == "technical"', forEach: null }, scope)).toEqual({ to: "skipped" });
  });
  it("becomes one copy per item of its for_each, or is skipped when the list is empty or missing", () => {
    expect(promote({ agent: null, when: null, forEach: "steps.route.result.tasks" }, scope)).toEqual({ to: "copies", items: [{ title: "a" }, { title: "b" }] });
    expect(promote({ agent: null, when: null, forEach: "steps.plain.result.tasks" }, scope)).toEqual({ to: "skipped" });
  });
  it("starts running when it only groups sub-tasks", () => expect(promote({ agent: null, when: null, forEach: null }, scope)).toEqual({ to: "running" }));
});

describe("after the work", () => {
  it("a result goes to its check; while an attempt still runs nothing is decided", () => {
    expect(afterWork(step, facts([{ id: "a1", state: "succeeded" }]))).toEqual({ next: "check", attemptId: "a1" });
    expect(afterWork(step, facts([{ id: "a1", state: "active" }]))).toEqual({ next: "wait" });
  });
  it("a question, an open sub-task or a held call comes before the check", () => {
    expect(afterWork(step, facts([{ id: "a1", state: "succeeded" }], { question: "Which region?" }))).toEqual({ next: "needs", need: { kind: "answer", question: "Which region?" } });
    expect(afterWork(step, facts([{ id: "a1", state: "succeeded" }], { openSubtasks: true }))).toEqual({ next: "subtasks" });
    expect(afterWork(step, facts([{ id: "a1", state: "held" }], { pendingApproval: "ap_1" }))).toEqual({ next: "needs", need: { kind: "approval", approvalId: "ap_1" } });
    expect(afterWork(step, facts([{ id: "a1", state: "held" }], { acting: true }))).toEqual({ next: "wait" });
    expect(afterWork(step, facts([{ id: "a1", state: "held" }]))).toEqual({ next: "again" });
  });
  it("a failed attempt fails the task", () => expect(afterWork(step, facts([{ id: "a1", state: "failed", detail: "out of turns" }]))).toEqual({ next: "failed", detail: "out of turns" }));
  it("candidates go to their judge once all have ended, and fail only when none produced a result", () => {
    const debate: StepSettings = { ...step, candidates: ["alpha", "beta"], judge: "judge" };
    expect(doers(debate)).toEqual(["alpha", "beta"]);
    expect(doers({ ...step, candidates: 3 })).toEqual(["writer", "writer", "writer"]);
    expect(afterWork(debate, facts([{ id: "a1", state: "succeeded" }, { id: "a2", state: "active" }]))).toEqual({ next: "wait" });
    expect(afterWork(debate, facts([{ id: "a1", state: "succeeded" }, { id: "a2", state: "failed" }]))).toEqual({ next: "judge", by: "judge", attemptIds: ["a1"] });
    expect(afterWork({ ...debate, judge: "person" }, facts([{ id: "a1", state: "succeeded" }, { id: "a2", state: "succeeded" }]))).toEqual({ next: "needs", need: { kind: "judge", attemptIds: ["a1", "a2"] } });
    expect(afterWork(debate, facts([{ id: "a1", state: "failed" }, { id: "a2", state: "held" }]))).toMatchObject({ next: "failed" });
  });
  it("the checker is the step's reviewer, else the checker agent, and never the agent that produced the result", () => {
    const agents = new Set(["writer", "critic", "checker"]);
    expect(checkerOf({ ...step, reviewBy: "critic" }, "writer", agents)).toBe("critic");
    expect(checkerOf(step, "writer", agents)).toBe("checker");
    expect(checkerOf(step, "checker", agents)).toBeNull();
    expect(checkerOf(step, "writer", new Set(["writer"]))).toBeNull();
  });
});

describe("the check", () => {
  const task = { maxRounds: 2, targetScore: null, approve: false, round: 1 };
  it("reads {pass, score, findings} from the output or the result text", () => {
    expect(readVerdict("", { pass: true, score: 0.9, findings: "ok" })).toEqual({ pass: true, score: 0.9, findings: "ok" });
    expect(readVerdict('{"pass": false, "findings": "no test"}', null)).toEqual({ pass: false, score: null, findings: "no test" });
    expect(readVerdict("Looks good to me", null)).toBeUndefined();
  });
  it("a pass is done, or a sign-off when the step asks for one", () => {
    expect(afterCheck(task, { pass: true, score: 0.9, findings: "" })).toEqual({ next: "done" });
    expect(afterCheck({ ...task, approve: true }, { pass: true, score: 0.9, findings: "" })).toEqual({ next: "needs", need: { kind: "sign-off" } });
  });
  it("a failure is another round while rounds remain, then a person", () => {
    expect(afterCheck(task, { pass: false, score: 0.2, findings: "no test" })).toEqual({ next: "again", round: 2 });
    expect(afterCheck({ ...task, round: 2 }, { pass: false, score: 0.2, findings: "no test" })).toEqual({ next: "needs", need: { kind: "check", findings: "no test" } });
    // A verdict that says again what the one before said ends the rounds at once, whatever round it is.
    const asked = "Section 1 claims six platform calls were made, but no such call appears in the recorded tool calls; invoke each platform tool once and show the real output.";
    expect(afterCheck(task, { pass: false, score: 0.2, findings: `${asked} Also fix the table.` }, asked)).toEqual({ next: "needs", need: { kind: "check", findings: `${asked} Also fix the table.`, repeated: true } });
    expect(afterCheck(task, { pass: false, score: 0.2, findings: "The summary leaves out the second migration and its rollback plan entirely, so the checker cannot verify the claim." }, asked)).toEqual({ next: "again", round: 2 });
    expect(afterCheck(task, { pass: true, score: 0.9, findings: asked }, asked)).toEqual({ next: "done" });
    expect([repeats(undefined, asked), repeats("no test", "no test"), repeats(asked, asked)]).toEqual([false, false, true]);
  });
  it("with a target score, a pass below it is not a pass", () => {
    expect(afterCheck({ ...task, targetScore: 0.8 }, { pass: true, score: 0.7, findings: "nearly" })).toEqual({ next: "again", round: 2 });
    expect(afterCheck({ ...task, targetScore: 0.8 }, { pass: true, score: 0.8, findings: "" })).toEqual({ next: "done" });
    expect(afterCheck({ ...task, targetScore: 0.8 }, { pass: true, score: null, findings: "" })).toEqual({ next: "again", round: 2 });
  });
  it("a person's pass is final, their no is another round, and a judging person names the candidate they keep", () => {
    const waiting = (needs: TaskNeed | null) => ({ round: 2, needs });
    expect(afterPersonCheck(waiting({ kind: "check", findings: "" }), { pass: true })).toEqual({ next: "done" });
    expect(afterPersonCheck(waiting({ kind: "sign-off" }), { pass: false })).toEqual({ next: "again", round: 3 });
    expect(afterPersonCheck(waiting({ kind: "judge", attemptIds: ["a1", "a2"] }), { pass: true, keep: "a2" })).toEqual({ next: "done", attemptId: "a2" });
    expect(afterPersonCheck(waiting({ kind: "judge", attemptIds: ["a1", "a2"] }), { pass: true, keep: "a9" })).toHaveProperty("refused");
    expect(afterPersonCheck(waiting({ kind: "approval", approvalId: "ap" }), { pass: true })).toHaveProperty("refused");
    expect(afterPersonCheck(waiting(null), { pass: true })).toHaveProperty("refused");
  });
  it("a judge keeps a candidate by position or by attempt id", () => {
    expect(readJudgement("", { keep: 2, findings: "clearer" }, ["a1", "a2"])).toEqual({ keep: "a2", findings: "clearer" });
    expect(readJudgement('{"keep": "a1"}', null, ["a1", "a2"])).toEqual({ keep: "a1", findings: "" });
    expect(readJudgement('{"keep": 3}', null, ["a1", "a2"])).toBeUndefined();
  });
});

describe("a plan", () => {
  const caps = (tools: string[], writes = false) => ({ tools, writes });
  const agents = new Map([["analyst", caps(["task.note", "memory.search"])], ["developer", caps(["task.note"], true)], ["syncer", caps(["platform.tasks", "platform.workspaces"])], ["syncer-writer", caps(["platform.tasks", "platform.workspaces"], true)]]);
  const tools = ["task.note", "platform.task", "platform.tasks", "platform.workspaces"];
  const plan = (tasks: unknown) => JSON.stringify({ summary: "Two steps.", tasks });
  it("is a list of tasks for agents of the workspace, each waiting for earlier titles", () => {
    expect(readPlan(plan([{ title: "Look", goal: "Find it.", agent: "analyst", after: [] }, { title: "Fix", goal: "Fix it.", agent: "developer", after: ["Look"] }]), null, agents)).toEqual({
      summary: "Two steps.", moved: [], tasks: [{ title: "Look", goal: "Find it.", agent: "analyst", after: [] }, { title: "Fix", goal: "Fix it.", agent: "developer", after: ["Look"] }],
    });
  });
  it("is refused with the reason when it names an unknown agent or need, a later task, a repeated title or nothing", () => {
    expect(readPlan(plan([{ title: "Look", goal: "x", agent: "ghost" }]), null, agents)).toMatchObject({ problem: expect.stringContaining("ghost") });
    expect(readPlan(plan([{ title: "Fix", goal: "x", agent: "developer", after: ["Look"] }, { title: "Look", goal: "x", agent: "analyst" }]), null, agents)).toMatchObject({ problem: expect.stringContaining("Look") });
    expect(readPlan(plan([{ title: "Look", goal: "x", agent: "analyst" }, { title: "Look", goal: "y", agent: "analyst" }]), null, agents)).toMatchObject({ problem: expect.stringContaining("repeats") });
    expect(readPlan(plan([{ title: "Look", goal: "x", agent: "analyst", needs: ["made.up"] }]), null, agents, tools)).toMatchObject({ problem: expect.stringContaining("made.up") });
    expect(readPlan(plan([]), null, agents)).toEqual({ problem: "The plan has no tasks" });
    expect(readPlan("I would start by looking around.", null, agents)).toHaveProperty("problem");
  });
  it("gives a task to the agent that can do it when the one chosen cannot: the needs it declares, the tools its goal names and the files it saves", () => {
    // A tool the goal names, or the plan declares, moves the task to the agent that has it.
    const moved = readPlan(plan([{ title: "Look", goal: "Use platform.workspaces and platform.tasks to list what exists.", agent: "analyst" }]), null, agents, tools);
    expect(moved).toMatchObject({ tasks: [{ agent: "syncer" }], moved: ['"Look" goes to syncer instead of analyst: it has platform.tasks, platform.workspaces'] });
    expect(readPlan(plan([{ title: "Look", goal: "List what exists.", agent: "analyst", needs: ["platform.tasks"] }]), null, agents, tools)).toMatchObject({ tasks: [{ agent: "syncer" }] });
    // A file under /work or /out needs an agent that writes; with the tools too, the one agent that has both is chosen.
    expect(readPlan(plan([{ title: "Save", goal: "Write the list to /out/improvements.md.", agent: "analyst" }]), null, agents, tools)).toMatchObject({ tasks: [{ agent: "developer" }] });
    expect(readPlan(plan([{ title: "Save", goal: "Write what platform.tasks returns to /out/tasks.md.", agent: "developer" }]), null, agents, tools)).toMatchObject({ tasks: [{ agent: "syncer-writer" }] });
    // A task whose agent has everything is left alone, and a name is read whole: platform.tasks is not a mention of platform.task.
    expect(readPlan(plan([{ title: "Look", goal: "Summarise what platform.tasks returns.", agent: "syncer" }]), null, agents, ["platform.task", "platform.tasks"])).toMatchObject({ tasks: [{ agent: "syncer" }], moved: [] });
  });
  it("is refused when its goal names a file under /work in a workspace with no project, where it would be lost", () => {
    const lost = readPlan(plan([{ title: "Save", goal: "Write the list to /work/improvements.md.", agent: "developer" }]), null, agents, tools, 0);
    expect(lost).toMatchObject({ problem: expect.stringContaining("name a file under /out instead") });
    expect(readPlan(plan([{ title: "Save", goal: "Write the list to /work/improvements.md.", agent: "developer" }]), null, agents, tools, 1)).toHaveProperty("tasks");
    expect(readPlan(plan([{ title: "Save", goal: "Write the list to /out/improvements.md.", agent: "developer" }]), null, agents, tools, 0)).toHaveProperty("tasks");
  });
  it("is refused only when no agent has all that a task needs", () => {
    expect(readPlan(plan([{ title: "Look", goal: "Never call platform.repeats here.", agent: "developer" }]), null, agents, ["platform.repeats"]))
      .toMatchObject({ problem: expect.stringContaining("platform.repeats (agents that have it: none)") });
    expect(readPlan(plan([{ title: "Look", goal: "Use task.note and platform.tasks.", agent: "analyst" }]), null, agents, tools)).toMatchObject({ problem: expect.stringContaining("no one agent has all") });
  });
});

describe("a task with sub-tasks", () => {
  const child = (id: string, state: "done" | "running" | "failed" | "stopped" | "waiting", result: string | null = null) => ({ id, state, result });
  it("is done when all are done, with the result of its last sub-task that was not skipped", () => {
    expect(groupOutcome([child("a", "done", "first"), child("b", "done", "second"), child("c", "done", "skipped")], false)).toEqual({ state: "done", result: "second" });
    expect(groupOutcome([child("a", "done", "skipped")], false)).toEqual({ state: "done", result: "skipped" });
    expect(groupOutcome([child("a", "done", "first"), child("b", "running")], false)).toEqual({ state: "running" });
  });
  it("gives the list of its copies' results when it is a for_each step", () => expect(groupOutcome([child("a", "done", "x"), child("b", "done", "y")], true)).toEqual({ state: "done", result: '["x","y"]' }));
  it("needs a person when a sub-task failed or was stopped", () => {
    expect(groupOutcome([child("a", "done", "x"), child("b", "failed"), child("c", "waiting")], false)).toEqual({ state: "needs_you", need: { kind: "failed-subtask", taskId: "b" } });
    expect(groupOutcome([child("a", "stopped")], false)).toEqual({ state: "needs_you", need: { kind: "failed-subtask", taskId: "a" } });
  });
});

describe("an attempt that fails", () => {
  it("is tried again for about six hours with a growing wait when the reason is the infrastructure, and never otherwise", () => {
    expect(retryOf({ infrastructure: true }, 0)).toEqual({ retry: true, tries: 1, delayMs: 5_000 });
    expect(retryOf({ infrastructure: true }, 2)).toEqual({ retry: true, tries: 3, delayMs: 80_000 });
    expect(retryOf({ infrastructure: true }, 3)).toEqual({ retry: true, tries: 4, delayMs: 300_000 });
    expect(retryOf({ infrastructure: true }, MAX_ATTEMPTS - 2)).toEqual({ retry: true, tries: MAX_ATTEMPTS - 1, delayMs: 3_600_000 });
    expect(retryOf({ infrastructure: true }, MAX_ATTEMPTS - 1)).toEqual({ retry: false });
    expect(retryOf({ infrastructure: false }, 0)).toEqual({ retry: false });
    expect(retryOf(null, 0)).toEqual({ retry: false });
    expect([1, 2, 3, 4, 5, 6, 7, 12, 40].map(backoffMs)).toEqual([5_000, 20_000, 80_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000]);
    // About six hours in all, 13 tries.
    expect([MAX_ATTEMPTS, Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => backoffMs(i + 1)).reduce((a, b) => a + b, 0) / 3_600_000]).toEqual([13, expect.closeTo(6.9, 0)]);
  });
});
