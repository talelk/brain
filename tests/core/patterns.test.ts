import type { JobOffer } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver, type Turn } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { fail, getTask, makeWorkspace, pass, states, step } from "./work";

/** Each way of organising agents that the model supports, written as a Play (or a goal) and run by scripted agents over the real protocol. */
let harness: Harness;
let member: Client;
let workspaceId: string;
let driver: Driver;
const start = async (play: string, inputs: Record<string, string> = {}): Promise<string> => (await member.command("task.create", { workspaceId, play, inputs })).taskId;
const of = (offers: JobOffer[], agent: string, kind = "work"): JobOffer[] => offers.filter((offer) => offer.agent.name === agent && offer.kind === kind);

const plays = {
  pipeline: `title = "Pipeline"
[inputs.topic]
type = "string"
required = true
[[step]]
id = "draft"
agent = "writer"
goal = "Draft a text about {{topic}}."
[[step]]
id = "polish"
agent = "editor"
after = ["draft"]
goal = "Polish this draft: {{steps.draft.result}}"
`,
  fanout: `title = "Fan out and in"
[[step]]
id = "split"
agent = "writer"
goal = "Split the job."
[[step]]
id = "each"
agent = "editor"
after = ["split"]
for_each = "steps.split.result.parts"
goal = "Handle the part {{item.name}}."
[[step]]
id = "join"
agent = "writer"
after = ["each"]
goal = "Join the parts."
`,
  delegate: `title = "Orchestrator and workers"
[[step]]
id = "lead"
agent = "lead"
goal = "Get the report written."
`,
  route: `title = "Router"
[[step]]
id = "route"
agent = "router"
goal = "Classify the request."
[[step]]
id = "billing"
agent = "writer"
after = ["route"]
when = 'steps.route.result.category == "billing"'
goal = "Answer the billing request: {{steps.route.result.summary}}"
[[step]]
id = "technical"
agent = "editor"
after = ["route"]
when = 'steps.route.result.category == "technical"'
goal = "Answer the technical request."
[[step]]
id = "send"
agent = "editor"
after = ["route", "billing", "technical"]
goal = "Send the answer."
`,
  critic: `title = "Generator and critic"
[[step]]
id = "write"
agent = "writer"
review_by = "critic"
max_rounds = 3
goal = "Write the summary."
`,
  optimize: `title = "Evaluator and optimizer"
[[step]]
id = "write"
agent = "writer"
review_by = "critic"
max_rounds = 2
target_score = 0.8
goal = "Write the answer."
`,
  debate: `title = "Debate"
[[step]]
id = "argue"
candidates = ["alpha", "beta"]
judge = "judge"
goal = "Argue your side."
`,
  contest: `title = "Contest"
[[step]]
id = "propose"
agent = "writer"
candidates = 2
judge = "person"
goal = "Propose a name."
`,
  table: `title = "Round table"
[[step]]
id = "first"
agent = "alpha"
goal = "Give your view."
[[step]]
id = "second"
agent = "beta"
after = ["first"]
goal = "Give your view, having read the board."
[[step]]
id = "close"
agent = "writer"
after = ["second"]
goal = "Conclude from the board."
`,
  board: `title = "Blackboard"
[[step]]
id = "facts"
agent = "alpha"
goal = "Post what you know."
[[step]]
id = "risks"
agent = "beta"
goal = "Post what you know."
[[step]]
id = "solve"
agent = "writer"
after = ["facts", "risks"]
goal = "Solve it from the board."
`,
  signoff: `title = "Sign-off"
[[step]]
id = "release"
agent = "writer"
approve = true
goal = "Prepare the release."
`,
};

beforeAll(async () => {
  harness = await createHarness();
  ({ workspaceId } = await makeWorkspace(harness, "Patterns", {
    agents: { writer: { tools: ["task.note"] }, editor: {}, critic: {}, planner: {}, lead: { tools: ["task.create"] }, router: {}, judge: {}, alpha: { tools: ["task.note"] }, beta: { tools: ["task.note"] } },
    plays,
  }));
  member = await harness.member(workspaceId, "max@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass() });
});
afterAll(() => harness.close());

describe("patterns", () => {
  it("pipeline: each step starts when the one before it is done and is given its result", async () => {
    driver.script({ writer: () => "A draft about tides.", editor: ({ offer }) => `Polished: ${offer.context.results[0]?.result}` });
    const taskId = await start("pipeline", { topic: "tides" });
    expect(states(await getTask(member, workspaceId, taskId))).toEqual({ draft: "ready", polish: "waiting" });
    const offers = await driver.drain();
    expect(offers.map((offer) => `${offer.kind}:${offer.agent.name}`)).toEqual(["work:writer", "check:checker", "work:editor", "check:checker"]);
    expect(offers[0]?.task.goal).toBe("Draft a text about tides.");
    expect(offers[2]?.task.goal).toBe("Polish this draft: A draft about tides.");
    expect(offers[2]?.context.results).toMatchObject([{ title: "draft", result: "A draft about tides." }]);
    const task = await getTask(member, workspaceId, taskId);
    expect(task).toMatchObject({ state: "done", result: "Polished: A draft about tides.", play: "pipeline" });
    expect(states(task)).toEqual({ draft: "done", polish: "done" });
  });

  it("fan-out and fan-in: one copy per item runs in parallel, and the step after them is given every copy's result", async () => {
    driver.script({
      writer: ({ offer }) => (offer.task.title === "split" ? { output: { parts: [{ name: "north" }, { name: "south" }, { name: "west" }] } } : `Joined ${offer.context.results.map((result) => result.result).join(" + ")}`),
      editor: ({ offer }) => `done ${offer.task.goal}`,
    });
    const taskId = await start("fanout");
    const split = await driver.step();
    expect(split?.task.title).toBe("split");
    await driver.step();
    // The three copies are queued together, before any of them has run.
    const during = await getTask(member, workspaceId, taskId);
    expect(during.subtasks.filter((subtask) => subtask.stepId === "each" && subtask.parentId !== taskId).map((subtask) => subtask.state)).toEqual(["ready", "ready", "ready"]);
    const offers = await driver.drain();
    expect(of(offers, "editor").map((offer) => offer.task.goal)).toEqual(["Handle the part north.", "Handle the part south.", "Handle the part west."]);
    const join = of(offers, "writer")[0];
    expect(join?.context.results.map((result) => result.result)).toEqual(["done Handle the part north.", "done Handle the part south.", "done Handle the part west."]);
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "done", result: "Joined done Handle the part north. + done Handle the part south. + done Handle the part west." });
  });

  it("planner and executor: a goal without a Play is planned, a person confirms the plan, and the sub-tasks run in its order", async () => {
    driver.script({
      planner: ({ offer }) => {
        expect(offer.context.catalog.agents.map((agent) => agent.name)).toContain("writer");
        return { output: { summary: "Research, then write.", tasks: [{ title: "Research", goal: "Find the facts.", agent: "editor", after: [] }, { title: "Write", goal: "Write it up.", agent: "writer", after: ["Research"] }] } };
      },
      editor: () => "The facts.", writer: ({ offer }) => `Written from: ${offer.context.results[0]?.result}`,
    });
    const { taskId } = await member.command("task.create", { workspaceId, goal: "Explain how tides work\nfor a school magazine." });
    expect((await driver.drain()).map((offer) => offer.kind)).toEqual(["plan"]);
    const proposed = await getTask(member, workspaceId, taskId);
    expect(proposed).toMatchObject({ title: "Explain how tides work", state: "needs_you", needs: { kind: "confirm-plan" } });
    expect(proposed.subtasks.map((subtask) => [subtask.title, subtask.agent, subtask.state])).toEqual([["Research", "editor", "waiting"], ["Write", "writer", "waiting"]]);
    expect(proposed.notes).toMatchObject([{ author: "planner", text: "Plan: Research, then write." }]);
    // Nothing of a plan runs before it is confirmed; a person may still change it.
    const [research, write] = proposed.subtasks;
    await member.command("task.edit", { workspaceId, taskId, changes: [{ op: "change", id: write?.id ?? "", goal: "Write it up in 200 words." }, { op: "add", title: "Proofread", goal: "Proofread it.", agent: "editor", after: [write?.id ?? ""] }] });
    await expect(member.command("task.edit", { workspaceId, taskId, changes: [{ op: "change", id: research?.id ?? "", after: [write?.id ?? ""] }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await member.command("task.confirm", { workspaceId, taskId });
    const offers = await driver.drain();
    expect(offers.filter((offer) => offer.kind === "work").map((offer) => [offer.task.title, offer.task.goal])).toEqual([["Research", "Find the facts."], ["Write", "Write it up in 200 words."], ["Proofread", "Proofread it."]]);
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "done", result: "The facts." });
    await expect(member.command("task.confirm", { workspaceId, taskId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("orchestrator and workers: an agent hands parts to others with task.create and is run again with their results", async () => {
    let runs = 0;
    driver.script({
      lead: async ({ offer, brain }) => {
        runs += 1;
        if (offer.context.results.length > 0) return `Report: ${offer.context.results.map((result) => result.result).join(", ")}`;
        const first = await brain("task.create", { title: "Figures", goal: "Collect the figures.", agent: "editor" });
        if (first.state !== "done") throw new Error(JSON.stringify(first));
        expect(await brain("task.create", { title: "Text", goal: "Write the text.", agent: "writer", after: [(first.output as { id: string }).id] })).toMatchObject({ state: "done" });
        expect(await brain("task.create", { title: "Ghost", goal: "x", agent: "nobody" })).toMatchObject({ state: "failed", error: expect.stringContaining("no agent") });
        return "Delegated.";
      },
      editor: () => "the figures", writer: () => "the text",
    });
    const taskId = await start("delegate");
    const offers = await driver.drain();
    expect(offers.filter((offer) => offer.kind === "work").map((offer) => offer.agent.name)).toEqual(["lead", "editor", "writer", "lead"]);
    expect(runs).toBe(2);
    const task = await getTask(member, workspaceId, taskId);
    const lead = step(task, "lead");
    expect(task.subtasks.filter((subtask) => subtask.parentId === lead.id).map((subtask) => [subtask.title, subtask.state])).toEqual([["Figures", "done"], ["Text", "done"]]);
    expect(task).toMatchObject({ state: "done", result: "Report: the figures, the text" });
    // One check of the lead's result: the one it gave after its workers were done.
    expect(task.checks.filter((check) => check.taskId === lead.id)).toHaveLength(1);
  });

  it("router: a step whose `when` is false is skipped, and the step after the branches still runs", async () => {
    driver.script({ router: () => ({ output: { category: "billing", summary: "a refund" } }), writer: ({ offer }) => `Billing answer to: ${offer.task.goal}`, editor: ({ offer }) => `Sent ${offer.context.results.map((result) => result.result).join(" | ")}` });
    const taskId = await start("route");
    const offers = await driver.drain();
    expect(offers.filter((offer) => offer.kind === "work").map((offer) => offer.task.title)).toEqual(["route", "billing", "send"]);
    const task = await getTask(member, workspaceId, taskId);
    expect(states(task)).toEqual({ route: "done", billing: "done", technical: "done", send: "done" });
    expect((await getTask(member, workspaceId, step(task, "technical").id)).result).toBe("skipped");
    expect(task.result).toBe('Sent {"category":"billing","summary":"a refund"} | Billing answer to: Answer the billing request: a refund | skipped');
  });

  it("generator and critic: the reviewer sends the result back with findings until it passes", async () => {
    const seen: Array<{ round: number; findings: readonly string[] }> = [];
    driver.script({
      writer: ({ offer }) => { seen.push({ round: offer.task.round, findings: offer.task.findings }); return `Summary, round ${offer.task.round}`; },
      critic: ({ offer }) => { expect(offer.context.review).toMatchObject([{ agent: "writer", result: `Summary, round ${offer.task.round}` }]); return offer.task.round === 1 ? fail("The second paragraph has no source.") : pass(); },
    });
    const taskId = await start("critic");
    const offers = await driver.drain();
    expect(offers.map((offer) => `${offer.kind}:${offer.agent.name}`)).toEqual(["work:writer", "check:critic", "work:writer", "check:critic"]);
    expect(seen).toEqual([{ round: 1, findings: [] }, { round: 2, findings: ["Round 1, check by critic: The second paragraph has no source."] }]);
    const task = await getTask(member, workspaceId, step(await getTask(member, workspaceId, taskId), "write").id);
    expect(task).toMatchObject({ state: "done", round: 2, result: "Summary, round 2" });
    expect(task.checks.map((check) => [check.round, check.by.id, check.pass])).toEqual([[1, "critic", false], [2, "critic", true]]);
  });

  it("evaluator and optimizer: a pass under the target score is another round, and when the rounds are used up a person decides", async () => {
    const scores = [0.6, 0.7];
    driver.script({ writer: ({ offer }) => `Answer, round ${offer.task.round}`, critic: () => pass("Closer.", scores.shift() ?? 1) });
    const taskId = await start("optimize");
    await driver.drain();
    const write = step(await getTask(member, workspaceId, taskId), "write");
    const stuck = await getTask(member, workspaceId, write.id);
    expect(stuck).toMatchObject({ state: "needs_you", round: 2, needs: { kind: "check", findings: "Closer." } });
    expect(stuck.checks.map((check) => [check.score, check.pass])).toEqual([[0.6, false], [0.7, false]]);
    // The person sends it back once more; this time the score reaches the target.
    await member.command("task.check", { workspaceId, taskId: write.id, pass: false, findings: "Name the source." });
    const offers = await driver.drain();
    expect(of(offers, "writer")[0]?.task).toMatchObject({ round: 3, findings: ["Round 1, check by critic: Closer.", "Round 2, check by critic: Closer.", "Round 2, check by max: Name the source."] });
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "done", result: "Answer, round 3" });
  });

  it("debate and judge: several agents attempt the step and a judge agent keeps one", async () => {
    driver.script({
      alpha: () => "It should be A.", beta: () => "It should be B.",
      judge: ({ offer }) => { expect(offer.context.review?.map((entry) => [entry.agent, entry.result])).toEqual([["alpha", "It should be A."], ["beta", "It should be B."]]); return { output: { keep: 2, findings: "B answers the objection." } }; },
    });
    const taskId = await start("debate");
    expect((await driver.drain()).map((offer) => `${offer.kind}:${offer.agent.name}`)).toEqual(["work:alpha", "work:beta", "judge:judge"]);
    const task = await getTask(member, workspaceId, taskId);
    expect(task).toMatchObject({ state: "done", result: "It should be B." });
    expect(task.checks).toMatchObject([{ by: { kind: "agent", id: "judge" }, pass: true, findings: "B answers the objection." }]);
  });

  it("debate and judge: with a person as judge, the task waits for them to keep a candidate", async () => {
    let n = 0;
    driver.script({ writer: () => `Name ${(n += 1)}` });
    const taskId = await start("contest");
    await driver.drain();
    const propose = await getTask(member, workspaceId, step(await getTask(member, workspaceId, taskId), "propose").id);
    expect(propose).toMatchObject({ state: "needs_you", needs: { kind: "judge" } });
    const candidates = propose.attempts.map((attempt) => attempt.id);
    expect(propose.needs).toEqual({ kind: "judge", attemptIds: candidates });
    await expect(member.command("task.check", { workspaceId, taskId: propose.id, pass: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await member.command("task.check", { workspaceId, taskId: propose.id, pass: true, keep: candidates[1] ?? "" });
    expect(await getTask(member, workspaceId, taskId)).toMatchObject({ state: "done", result: "Name 2" });
  });

  it("round table: each agent in turn reads the shared notes of the goal and adds to them", async () => {
    const read: string[][] = [];
    const speak = (words: string) => async ({ offer, brain }: Turn) => {
      read.push(offer.context.notes.map((note) => `${note.author}: ${note.text}`));
      expect(await brain("task.note", { text: words })).toMatchObject({ state: "done", output: { id: expect.any(String) } });
      return words;
    };
    driver.script({ alpha: speak("Ship on Friday."), beta: speak("Friday is a holiday."), writer: ({ offer }) => `Concluded from ${offer.context.notes.length} notes` });
    const taskId = await start("table");
    await driver.drain();
    expect(read).toEqual([[], ["alpha: Ship on Friday."]]);
    const task = await getTask(member, workspaceId, taskId);
    expect(task.result).toBe("Concluded from 2 notes");
    expect(task.notes.map((note) => [note.author, note.text])).toEqual([["alpha", "Ship on Friday."], ["beta", "Friday is a holiday."]]);
  });

  it("blackboard: agents working at the same time post to one board, and the step after them solves from it", async () => {
    driver.script({
      alpha: async ({ brain }) => { await brain("task.note", { text: "The disk is full." }); return "posted"; },
      beta: async ({ brain }) => { await brain("task.note", { text: "Logs grow 2 GB a day." }); return "posted"; },
      writer: ({ offer }) => `Solved from: ${offer.context.notes.map((note) => note.text).join(" ")}`,
    });
    const taskId = await start("board");
    expect(states(await getTask(member, workspaceId, taskId))).toEqual({ facts: "ready", risks: "ready", solve: "waiting" });
    await driver.drain();
    expect((await getTask(member, workspaceId, taskId)).result).toBe("Solved from: The disk is full. Logs grow 2 GB a day.");
    // The board belongs to one goal: another goal's agents do not read it.
    driver.script({ alpha: ({ offer }) => `sees ${offer.context.notes.length}`, beta: () => "x" });
    const other = await start("board");
    await driver.drain();
    expect((await getTask(member, workspaceId, step(await getTask(member, workspaceId, other), "facts").id)).result).toBe("sees 0");
  });

  it("human in the loop: a step with `approve` waits for a person's sign-off after its check passed", async () => {
    driver.script({ writer: ({ offer }) => `Release notes, round ${offer.task.round}` });
    const taskId = await start("signoff");
    await driver.drain();
    const release = step(await getTask(member, workspaceId, taskId), "release");
    expect(release).toMatchObject({ state: "needs_you", needs: { kind: "sign-off" } });
    expect((await member.query("today", { workspaceId })).needsYou.map((task) => task.id)).toContain(release.id);
    // A viewer may not sign off; a member's "no" sends it back with their findings.
    const viewer = await harness.member(workspaceId, "vera@example.com", "viewer");
    await expect(viewer.command("task.check", { workspaceId, taskId: release.id, pass: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await member.command("task.check", { workspaceId, taskId: release.id, pass: false, findings: "Mention the breaking change." });
    await driver.drain();
    await member.command("task.check", { workspaceId, taskId: release.id, pass: true });
    const task = await getTask(member, workspaceId, taskId);
    expect(task).toMatchObject({ state: "done", result: "Release notes, round 2" });
    expect(task.checks.map((check) => [check.by.kind, check.pass])).toEqual([["agent", true], ["person", false], ["agent", true], ["person", true]]);
  });

  it("a result is done only after a check by something other than the agent that produced it", async () => {
    // The checker's own work cannot be checked by the checker: a person has to.
    await harness.admin.command("file.write", { workspaceId, files: [{ path: "plays/selfcheck.toml", content: 'title = "Self"\n[[step]]\nid = "audit"\nagent = "checker"\ngoal = "Audit the workspace."\n' }] });
    driver.script({ checker: () => "All fine." });
    const taskId = await start("selfcheck");
    expect((await driver.drain()).map((offer) => offer.kind)).toEqual(["work"]);
    const audit = step(await getTask(member, workspaceId, taskId), "audit");
    expect(audit).toMatchObject({ state: "needs_you", needs: { kind: "check" } });
    await member.command("task.check", { workspaceId, taskId: audit.id, pass: true, findings: "Read it myself." });
    expect((await getTask(member, workspaceId, taskId)).state).toBe("done");
    // Across everything this file ran: every done task with an agent has a passed check, and never by its own agent.
    const { db } = harness.governor.gov;
    const unchecked = db.prepare("SELECT title FROM tasks t WHERE agent IS NOT NULL AND state='done' AND result != 'skipped' AND NOT EXISTS (SELECT 1 FROM checks c WHERE c.task_id = t.id AND c.pass = 1)").all();
    const selfChecked = db.prepare("SELECT c.id FROM checks c JOIN attempts a ON a.id = c.attempt_id WHERE c.by_kind='agent' AND c.by_id = a.agent").all();
    expect([unchecked, selfChecked]).toEqual([[], []]);
    driver.script({ checker: () => pass() });
  });
});
