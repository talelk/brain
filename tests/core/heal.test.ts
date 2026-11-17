import type { Approval, BrainToolResponse, JsonValue, Task, TaskSummary } from "@brain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver, type Turn } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step, testClock } from "./work";

/** A task that failed all its attempts (docs/model.md, "When a task fails"): one heal task finds why, and a fix is approved by an admin before the task runs again. */
const clock = testClock();
let harness: Harness;
let driver: Driver;
let seen = 0;

const play = 'title = "Job"\n[inputs.what]\ntype = "string"\nrequired = true\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "{{what}}"\n';
const agents = { dev: {}, "workspace-healer": { tools: ["workspace.fix", "task.ask"] } };
const failing = { outcome: "failed" as const, result: "", failure: { reason: "limit" as const, detail: "Out of turns while reading the log", infrastructure: false } };
const newPrompt = "You are the dev. Read the log in pieces of 200 lines.\n";
const fix = (task: string, over: Record<string, JsonValue> = {}): JsonValue => ({ task, files: [{ path: "agents/dev/prompt.md", content: newPrompt }], message: "Tell the dev to read in pieces", why: "It ran out of turns reading whole logs.", ...over });
const call = (turn: Turn, input: JsonValue): Promise<BrainToolResponse> => turn.brain("workspace.fix", input);
/** What a runner does with the approved call of an `act` attempt: ask for exactly that call again. */
const act = async ({ offer, post }: Turn): Promise<string> => {
  const approved = offer.act as NonNullable<typeof offer.act>;
  expect(await post<BrainToolResponse>("brain-tool", { callId: approved.callId, tool: approved.tool, input: approved.input })).toMatchObject({ state: "done" });
  return "Committed.";
};

async function workspace(name: string, brain = ""): Promise<{ workspaceId: string; member: Client }> {
  seen += 1;
  const { workspaceId } = await makeWorkspace(harness, name, { brain, agents, plays: { job: play } });
  return { workspaceId, member: await harness.member(workspaceId, `max${seen}@example.com`, "member") };
}
const start = async (client: Client, workspaceId: string, what = "Summarise the log"): Promise<Task> => getTask(client, workspaceId, (await client.command("task.create", { workspaceId, play: "job", inputs: { what } })).taskId);
const roots = async (client: Client, workspaceId: string): Promise<readonly TaskSummary[]> => (await client.query("tasks.list", { workspaceId, rootsOnly: true, limit: 50 })).tasks;
const heals = async (client: Client, workspaceId: string): Promise<readonly TaskSummary[]> => (await roots(client, workspaceId)).filter((task) => task.heals !== undefined);
const pending = async (client: Client, workspaceId: string): Promise<Approval[]> => [...(await client.query("approvals.list", { workspaceId, state: "pending" })).approvals];
const decide = (client: Client, workspaceId: string, approval: Approval, decision: "approve" | "reject", reason = "") => client.command("approval.decide", { workspaceId, approvalId: approval.id, decision, subjectDigest: approval.subjectDigest, reason });

beforeAll(async () => {
  harness = await createHarness({ clock });
  driver = await enrolRunner(harness, { checker: () => pass() });
});
afterAll(() => harness.close());

describe("a task that failed all its attempts", () => {
  it("gets one heal task with the evidence; an admin approves the fix, the commit is made and the task runs again on it", async () => {
    const { workspaceId, member } = await workspace("Healing");
    let original = "";
    driver.script({
      dev: ({ offer }) => { original ||= offer.snapshotDigest; return offer.snapshotDigest === original ? failing : "The log is summarised."; },
      "workspace-healer": async (turn) => {
        if (turn.offer.act) return act(turn);
        if (turn.offer.task.findings.length > 0) return "The fix was made.";
        const failedId = /\(id (t_\w+)\)/u.exec(turn.offer.task.goal)?.[1] as string;
        expect(await call(turn, fix(failedId))).toMatchObject({ state: "pending", approvalId: expect.any(String) });
        return { outcome: "held", result: "I proposed a change and stopped." };
      },
    });
    const goal = await start(member, workspaceId);
    await driver.drain();
    const failed = step(await getTask(member, workspaceId, goal.id), "do");
    expect(failed.state).toBe("failed");

    const [heal, ...others] = await heals(member, workspaceId);
    expect(others).toEqual([]);
    expect(heal).toMatchObject({ title: "Heal: do", agent: "workspace-healer", state: "needs_you", heals: { id: failed.id, title: "do" } });
    const healTask = await getTask(member, workspaceId, (heal as TaskSummary).id);
    for (const evidence of ["Out of turns while reading the log", "Summarise the log", "agents/dev/prompt.md", "You are the dev.", failed.id]) expect(healTask.goal).toContain(evidence);
    expect((await getTask(member, workspaceId, failed.id)).heal).toEqual({ taskId: healTask.id, state: "needs_you" });

    // The approver reads a diff of the file and the reason; only an admin may decide it.
    const [approval] = await pending(member, workspaceId);
    expect(approval).toMatchObject({ tool: "workspace.fix", effect: "write", taskId: healTask.id, subject: { patchDigest: expect.any(String), baseCommit: expect.any(String), input: { task: failed.id, why: "It ran out of turns reading whole logs." } } });
    await expect(decide(member, workspaceId, approval as Approval, "approve")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = (await harness.admin.query("workspace.get", { workspaceId })).snapshotDigest;
    await decide(harness.admin, workspaceId, approval as Approval, "approve", "Looks right.");
    const offers = await driver.drain();

    const after = await harness.admin.query("workspace.get", { workspaceId });
    expect(after.snapshotDigest).not.toBe(before);
    expect((await harness.admin.query("file.read", { workspaceId, path: "agents/dev/prompt.md" })).content).toBe(newPrompt);
    // The failed task ran again on the commit of the fix, and could finish.
    expect(offers.filter((offer) => offer.agent.name === "dev").map((offer) => offer.snapshotDigest)).toEqual([after.snapshotDigest]);
    expect(await getTask(member, workspaceId, goal.id)).toMatchObject({ state: "done" });
    expect(await getTask(member, workspaceId, failed.id)).toMatchObject({ state: "done", snapshotDigest: after.snapshotDigest, heal: { state: "done" } });
    expect((await getTask(member, workspaceId, healTask.id)).toolCalls).toMatchObject([{ tool: "workspace.fix", outcome: "succeeded", output: { requeued: true } }]);
    // The commit is the fix's, tagged with the failed task, and the change is in the audit chain with the call that made it.
    expect((await harness.admin.query("file.read", { workspaceId, path: "agents/dev/prompt.md" })).lastCommit?.message).toBe("Tell the dev to read in pieces");
    const { db } = harness.governor.gov;
    expect((db.prepare("SELECT payload_json AS payload FROM events WHERE type='workspace.changed' AND workspace_id=? ORDER BY seq DESC LIMIT 1").get(workspaceId) as { payload: string }).payload).toContain("agents/dev/prompt.md");
    expect(db.prepare("SELECT 1 FROM events WHERE type='tool.called' AND subject=? AND payload_json LIKE '%workspace.fix%'").get(`task:${healTask.id}`)).toBeDefined();
  });

  it("rejected, nothing changes: the failed task stays failed beside the healer's analysis", async () => {
    const { workspaceId, member } = await workspace("Rejecting");
    driver.script({
      dev: () => failing,
      "workspace-healer": async (turn) => {
        if (turn.offer.task.findings.length > 0) return "**Cause** reading whole logs. **Proposal** declined by an admin.";
        await call(turn, fix(/\(id (t_\w+)\)/u.exec(turn.offer.task.goal)?.[1] as string));
        return { outcome: "held", result: "I proposed a change and stopped." };
      },
    });
    const goal = await start(member, workspaceId);
    await driver.drain();
    const [approval] = await pending(member, workspaceId);
    const before = (await harness.admin.query("workspace.get", { workspaceId })).snapshotDigest;
    await decide(harness.admin, workspaceId, approval as Approval, "reject", "Not this way.");
    await driver.drain();
    expect((await harness.admin.query("workspace.get", { workspaceId })).snapshotDigest).toBe(before);
    const failed = step(await getTask(member, workspaceId, goal.id), "do");
    expect(await getTask(member, workspaceId, failed.id)).toMatchObject({ state: "failed", heal: { state: "done" } });
    expect((await getTask(member, workspaceId, (await heals(member, workspaceId))[0]?.id as string)).result).toContain("declined by an admin");
  });

  it("a person's answer comes back to the healer, which may then propose the fix", async () => {
    const { workspaceId, member } = await workspace("Asking");
    let round = 0;
    driver.script({
      dev: () => failing,
      "workspace-healer": async (turn) => {
        round += 1;
        if (round === 1) {
          await turn.brain("task.ask", { question: "Is the log meant to be that long?" });
          return "I asked and wait.";
        }
        expect(turn.offer.context.answers).toMatchObject([{ answer: "No, split it." }]);
        await call(turn, fix(/\(id (t_\w+)\)/u.exec(turn.offer.task.goal)?.[1] as string));
        return { outcome: "held", result: "Proposed." };
      },
    });
    await start(member, workspaceId);
    await driver.drain();
    const [heal] = await heals(member, workspaceId);
    expect(heal).toMatchObject({ state: "needs_you", needs: { kind: "answer", question: "Is the log meant to be that long?" } });
    await member.command("task.answer", { workspaceId, taskId: (heal as TaskSummary).id, answer: "No, split it." });
    await driver.drain();
    expect(await pending(member, workspaceId)).toMatchObject([{ tool: "workspace.fix" }]);
  });

  it("a heal task is never healed, and a task is healed once", async () => {
    const { workspaceId, member } = await workspace("Once");
    driver.script({ dev: () => failing, "workspace-healer": () => failing });
    const goal = await start(member, workspaceId);
    await driver.drain();
    const failed = step(await getTask(member, workspaceId, goal.id), "do");
    expect(await heals(member, workspaceId)).toMatchObject([{ state: "failed" }]);
    await member.command("task.retry", { workspaceId, taskId: failed.id });
    await driver.drain();
    expect(await getTask(member, workspaceId, failed.id)).toMatchObject({ state: "failed" });
    expect(await heals(member, workspaceId)).toHaveLength(1);
    expect(await roots(member, workspaceId)).toHaveLength(2);
  });

  it("is limited by healing.per_day and turned off by mode", async () => {
    driver.script({ dev: () => failing, "workspace-healer": () => "Nothing to change." });
    const capped = await workspace("Capped", "[healing]\nper_day = 1\n");
    await start(capped.member, capped.workspaceId, "First");
    const second = await start(capped.member, capped.workspaceId, "Second");
    await driver.drain();
    expect(await heals(capped.member, capped.workspaceId)).toHaveLength(1);
    expect((await getTask(capped.member, capped.workspaceId, second.id)).notes.map((note) => note.text).join(" ")).toContain("heal tasks today");
    const off = await workspace("Off", '[healing]\nmode = "off"\n');
    await start(off.member, off.workspaceId);
    await driver.drain();
    expect(await heals(off.member, off.workspaceId)).toEqual([]);
  });

  it("is not started for a failure only infrastructure caused, and the failed task's goal says so", async () => {
    const { workspaceId, member } = await workspace("Infrastructure");
    driver.script({ dev: () => ({ outcome: "failed", result: "", failure: { reason: "model-refused", detail: "The model server is down", infrastructure: true } }) });
    const goal = await start(member, workspaceId);
    for (let round = 0; round < 6; round += 1) { await driver.drain(); clock.advance(100_000); }
    expect(step(await getTask(member, workspaceId, goal.id), "do").state).toBe("failed");
    expect(await heals(member, workspaceId)).toEqual([]);
    expect((await getTask(member, workspaceId, goal.id)).notes.map((note) => note.text).join(" ")).toContain("only for infrastructure reasons");
  });

  it("refuses a fix that leaves the workspace's files, touches what only an admin decides, names another task or changes nothing", async () => {
    const { workspaceId, member } = await workspace("Refusing");
    const refused: string[] = [];
    driver.script({
      dev: () => failing,
      "workspace-healer": async (turn) => {
        const id = /\(id (t_\w+)\)/u.exec(turn.offer.task.goal)?.[1] as string;
        const file = (path: string, content: string): JsonValue => ({ path, content });
        const brainToml = (await harness.admin.query("file.read", { workspaceId, path: "brain.toml" })).content;
        for (const input of [
          fix(id, { files: [file("src/app.ts", "export {};\n")] }), fix(id, { files: [file(".env", "KEY=1\n")] }), fix(id, { files: [file("agents/../brain.toml", "x")] }),
          fix(id, { files: [file("brain.toml", `${brainToml}[approvals."workspace.fix"]\ntargets = ["x"]\nper_day = 1\nuntil = 2030-01-01\n`)] }),
          fix(id, { files: [file("brain.toml", `${brainToml}[github]\ncredential = "secret:github"\n`)] }), fix(id, { files: [file("agents/dev/agent.toml", "not = valid = toml")] }),
          fix("t_other"), fix(id, { files: [file("agents/dev/prompt.md", "You are the dev.\n")] }), fix(id, { files: [{ path: "agents/dev/prompt.md" }] }),
        ]) {
          const answer = await call(turn, input);
          expect(answer).toMatchObject({ state: "failed" });
          refused.push((answer as { error: string }).error);
        }
        return "Nothing could be changed.";
      },
    });
    await start(member, workspaceId);
    await driver.drain();
    expect(refused).toHaveLength(9);
    expect(refused[0]).toContain("not a file you may change");
    expect(refused[3]).toContain("approvals");
    expect(refused[4]).toContain("github");
    expect(refused[5]).toContain("would not be valid");
    expect(refused[6]).toContain("must be that id");
    expect(refused[7]).toContain("nothing to fix");
    expect(await pending(member, workspaceId)).toEqual([]);
  });
});
