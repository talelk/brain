import { type Approval, type BrainToolResponse, type JsonValue } from "@brain/contracts";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repeatsOf } from "../../apps/governor/src/tools/repeats";
import { runSchedules } from "../../apps/governor/src/tasks/triggers";
import { enrolRunner, type Driver, type Turn } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, testClock } from "./work";

/** The platform workspace (docs/model.md): one workspace that reads every other and proposes changes to them, each approved by an admin. */
const PACKS = fileURLToPath(new URL("../../packs", import.meta.url));
const DAY = 86_400_000;
const clock = testClock();
let harness: Harness;
let driver: Driver;
let platformId: string;
let alpha: { workspaceId: string; admin: Client; member: Client };
let beta: { workspaceId: string; admin: Client };

const lint = 'description = "Lints the repository."\neffect = "read"\nneeds = ["bash"]\n';
const job = 'title = "Job"\n[inputs.what]\ntype = "string"\nrequired = true\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "{{what}}"\n';
const scribeJob = job.replace('agent = "dev"', 'agent = "scribe"');
const agents = { dev: { tools: ["lint.run"] }, scribe: {} };
const start = (workspaceId: string, what: string, play = "job") => harness.admin.command("task.create", { workspaceId, play, inputs: { what } });
const answerOf = (response: BrainToolResponse): JsonValue => (response as { output: JsonValue }).output;
const act = async ({ offer, post }: Turn): Promise<string> => {
  const approved = offer.act as NonNullable<typeof offer.act>;
  expect(await post<BrainToolResponse>("brain-tool", { callId: approved.callId, tool: approved.tool, input: approved.input })).toMatchObject({ state: "done" });
  return "Committed.";
};
const decide = (client: Client, workspaceId: string, approval: Approval, decision: "approve" | "reject") => client.command("approval.decide", { workspaceId, approvalId: approval.id, decision, subjectDigest: approval.subjectDigest, reason: "" });
const events = (type: string, workspaceId: string): Array<{ payload: Record<string, JsonValue> }> =>
  (harness.governor.gov.db.prepare("SELECT payload_json AS payload FROM events WHERE type=? AND workspace_id=? ORDER BY seq").all(type, workspaceId) as Array<{ payload: string }>).map((row) => ({ payload: JSON.parse(row.payload) as Record<string, JsonValue> }));

beforeAll(async () => {
  harness = await createHarness({ clock, packsDir: PACKS });
  driver = await enrolRunner(harness, { checker: () => pass(), dev: async ({ tool }) => { await tool("lint.run", {}, { ok: true }); return "Linted."; }, scribe: () => "Written.", spy: () => "Nothing." });
  const make = async (name: string) => {
    const { workspaceId } = await makeWorkspace(harness, name, { packs: ["base"], agents, tools: { "lint.run": lint }, plays: { job, scribe: scribeJob } });
    return { workspaceId, admin: await harness.member(workspaceId, `${name.toLowerCase()}-admin@example.com`, "admin") };
  };
  const a = await make("Alpha");
  alpha = { ...a, member: await harness.member(a.workspaceId, "alpha-member@example.com", "member") };
  beta = await make("Beta");
  ({ workspaceId: platformId } = await makeWorkspace(harness, "Brain admin", { platform: true, packs: ["base", "platform"], brain: 'timezone = "Africa/Tunis"\n' }));
});
afterAll(() => harness.close());

describe("the platform setting", () => {
  it("is set only by an instance admin, and a Brain has one platform workspace", async () => {
    const setting = async (client: Client, workspaceId: string, on: boolean) => {
      const { content } = await harness.admin.query("file.read", { workspaceId, path: "brain.toml" });
      return client.command("file.write", { workspaceId, files: [{ path: "brain.toml", content: on ? `platform = true\n${content}` : content.replace("platform = true\n", "") }] });
    };
    // A workspace admin, however it is written, cannot make their workspace the platform.
    await expect(setting(alpha.admin, alpha.workspaceId, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(alpha.admin.command("file.write", { workspaceId: alpha.workspaceId, files: [{ path: "brain.toml", content: 'name = "Alpha"\nplatform = true\npacks = ["base"]\n' }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An instance admin may, but not for a second one, and a pack of the platform needs the setting.
    await expect(setting(harness.admin, alpha.workspaceId, true)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(harness.createWorkspace({ name: "Another", packs: ["base"], platform: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(harness.createWorkspace({ name: "Sneaky", packs: ["base", "platform"] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
    expect((await harness.admin.query("workspace.get", { workspaceId: platformId })).platform).toBe(true);
    expect((await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).platform).toBe(false);
  });

  it("makes the workspace invisible to anyone who is not an instance admin, a member or not", async () => {
    const insider = await harness.member(platformId, "insider@example.com", "admin");
    await expect(insider.query("workspace.get", { workspaceId: platformId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(insider.command("file.write", { workspaceId: platformId, files: [{ path: "brain.toml", content: 'name = "Brain admin"\npacks = ["base", "platform"]\n' }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await insider.query("me", {})).workspaces.map((workspace) => workspace.id)).not.toContain(platformId);
    expect((await harness.admin.query("me", {})).workspaces.find((workspace) => workspace.id === platformId)).toMatchObject({ platform: true });
  });
});

describe("the platform tools", () => {
  it("answer only the platform workspace's tasks, and are audited with source and target; a secret never shows", async () => {
    await harness.admin.command("secret.set", { workspaceId: alpha.workspaceId, name: "github", value: "ghp-supersecret-123" });
    await start(alpha.workspaceId, "Lint the repository, the token is ghp-supersecret-123");
    // The same tool in a workspace that is not the platform is refused when the task calls it.
    await harness.admin.command("file.write", { workspaceId: beta.workspaceId, files: [
      { path: "tools/platform.workspaces/tool.toml", content: 'description = "Lists."\nruns = "brain"\neffect = "read"\n' },
      { path: "agents/spy/agent.toml", content: 'description = "Spy."\nengine = ["fixture"]\nnative = "none"\ntools = ["platform.workspaces"]\n[limits]\nspend_usd = 0\n' }, { path: "agents/spy/prompt.md", content: "You are the spy.\n" },
    ] });
    const refused: unknown[] = [];
    driver.script({ spy: async ({ brain }) => { refused.push(await brain("platform.workspaces", {})); return "Nothing."; } });
    await harness.admin.command("file.write", { workspaceId: beta.workspaceId, files: [{ path: "plays/spy.toml", content: 'title = "Spy"\n[[step]]\nid = "look"\nagent = "spy"\ngoal = "Look around."\n' }] });
    await harness.admin.command("task.create", { workspaceId: beta.workspaceId, play: "spy" });
    await driver.drain();
    expect(refused).toMatchObject([{ state: "failed", error: expect.stringContaining("only for the tasks of the platform workspace") }]);
    expect(events("platform.read", alpha.workspaceId)).toEqual([]);

    const seen: JsonValue[] = [];
    driver.script({
      capitalizer: async ({ brain }) => {
        const list = answerOf(await brain("platform.workspaces", {})) as { workspaces: Array<{ slug: string; platform: boolean; tasks: { done: number } }> };
        expect(list.workspaces.map((workspace) => workspace.slug)).toEqual(["alpha", "beta", "brain-admin", "starter"]);
        expect(list.workspaces.find((workspace) => workspace.slug === "brain-admin")?.platform).toBe(true);
        const tasks = answerOf(await brain("platform.tasks", { workspace: "alpha", state: "done" })) as { tasks: Array<{ id: string; workspace: string; goal: string }> };
        const detail = answerOf(await brain("platform.task", { workspace: "alpha", id: (tasks.tasks[0] as { id: string }).id }));
        const file = answerOf(await brain("platform.file", { workspace: "alpha", path: "brain.toml" }));
        seen.push(list, tasks, detail, file, await brain("platform.file", { workspace: "alpha", path: "../beta/brain.toml" }), await brain("platform.task", { workspace: "beta", id: (tasks.tasks[0] as { id: string }).id }));
        return "Read.";
      },
    });
    const goal = await harness.admin.command("task.create", { workspaceId: platformId, play: "capitalize" });
    await driver.drain();
    expect(await getTask(harness.admin, platformId, goal.taskId)).toMatchObject({ state: "done" });
    const everything = JSON.stringify(seen);
    expect(everything).not.toContain("ghp-supersecret-123");
    expect(everything).toContain("[secret]");
    expect(seen.at(-2)).toMatchObject({ state: "failed" });
    expect(seen.at(-1)).toMatchObject({ state: "failed", error: expect.stringContaining("has no task") });
    // Each read of another workspace is in the audit chain with both workspaces, written with the call.
    const reads = events("platform.read", alpha.workspaceId).map((event) => event.payload);
    expect(reads.map((read) => read["tool"])).toEqual(expect.arrayContaining(["platform.workspaces", "platform.tasks", "platform.task", "platform.file"]));
    expect(reads[0]).toMatchObject({ source: "brain-admin", target: "alpha" });
  });
});

describe("repeated work", () => {
  it("is found when done four times or more in 30 days across workspaces, not three, and not when older", async () => {
    // Four runs of an agent, older than 30 days by the time of the search.
    for (const week of ["one", "two", "three", "four"]) await start(alpha.workspaceId, `Write the weekly summary of the week ${week}`, "scribe");
    await driver.drain();
    clock.advance(31 * DAY);
    // The same job twice in each of two workspaces; and another job only three times.
    for (const workspaceId of [alpha.workspaceId, beta.workspaceId]) for (const release of [1, 2]) await start(workspaceId, `Lint the repository for release ${release} and report the style problems`);
    for (const server of [1, 2, 3]) await start(alpha.workspaceId, `Write the weekly summary of server ${server}`, "scribe");
    await driver.drain();
    const found = repeatsOf(harness.governor.gov, 30) as { days: number; min: number; candidates: Array<{ agent: string; tools: string[]; count: number; workspaces: Array<{ slug: string; count: number }> }> };
    expect(found.min).toBe(4);
    expect(found.candidates).toMatchObject([{ agent: "dev", tools: ["lint.run"], count: 4, workspaces: [{ slug: "alpha", count: 2 }, { slug: "beta", count: 2 }] }]);
    // A longer look finds the older runs too, and one more of the three makes four.
    const longer = repeatsOf(harness.governor.gov, 90) as typeof found;
    expect(longer.candidates.map((candidate) => [candidate.agent, candidate.count])).toEqual([["dev", 4], ["scribe", 4]]);
    await start(alpha.workspaceId, "Write the weekly summary of server 4", "scribe");
    await driver.drain();
    expect((repeatsOf(harness.governor.gov, 30) as typeof found).candidates.map((candidate) => [candidate.agent, candidate.count])).toEqual([["dev", 4], ["scribe", 4]]);
  });
});

describe("the capitalizer's proposals", () => {
  it("change another workspace only when an admin of it, or an instance admin, approves each one; the commit and the audit are in the target", async () => {
    const tool = (name: string): JsonValue[] => [
      { path: `tools/${name}/tool.toml`, content: `description = "Lints the repository and reports the style problems."\neffect = "read"\nneeds = ["bash"]\n[inputs.path]\ntype = "string"\nrequired = false\n` },
      { path: `tools/${name}/run.sh`, content: "#!/bin/sh\ncat >/dev/null\necho '{\"ok\": true}'\n" }, { path: `tools/${name}/test.sh`, content: `#!/bin/sh\necho "${name}: ok"\n` },
      { path: "agents/dev/agent.toml", content: `description = "The dev."\nengine = ["fixture"]\nnative = "none"\ntools = ["lint.run", "${name}"]\n[limits]\nspend_usd = 0\n` },
    ];
    const proposals: Array<{ state: string; error?: string }> = [];
    driver.script({
      capitalizer: async (turn) => {
        if (turn.offer.act) return act(turn);
        if (turn.offer.task.findings.length > 0) return "Proposed two changes.";
        const send = async (input: JsonValue) => { const answer = await turn.brain("workspace.fix", input); proposals.push(answer as { state: string }); return answer; };
        await send({ workspace: "alpha", files: tool("style.lint"), message: "Add the style.lint tool", why: "dev ran lint.run four times in alpha and beta." });
        await send({ workspace: "beta", files: [{ path: "memory/lint-lesson.md", content: "# Lint lesson\n\nRun the linter before the review.\n" }], message: "Note the lint lesson", why: "Lint was done the same way four times." });
        // Refused at once: the platform setting, a workspace that does not exist, and a heal's task input.
        await send({ workspace: "alpha", files: [{ path: "brain.toml", content: 'name = "Alpha"\nplatform = true\npacks = ["base"]\n' }], message: "Make it the platform", why: "No." });
        await send({ workspace: "nowhere", files: [{ path: "memory/x.md", content: "# X\n" }], message: "x", why: "x" });
        await send({ workspace: "alpha", task: "t_x", files: [{ path: "memory/x.md", content: "# X\n" }], message: "x", why: "x" });
        return { outcome: "held", result: "I proposed two changes and stopped." };
      },
    });
    const goal = await harness.admin.command("task.create", { workspaceId: platformId, play: "capitalize" });
    await driver.drain();
    expect(proposals.map((proposal) => proposal.state)).toEqual(["pending", "pending", "failed", "failed", "failed"]);
    expect(proposals[2]?.error).toContain("platform");
    expect(proposals[3]?.error).toContain("no workspace");

    // The approver sees the diff; the target's admin finds the approval in their own workspace, a member who is no admin cannot decide it.
    const pendingIn = async (client: Client, workspaceId: string): Promise<Approval[]> => [...(await client.query("approvals.list", { workspaceId, state: "pending" })).approvals];
    const [forAlpha] = await pendingIn(alpha.admin, alpha.workspaceId);
    const [forBeta] = await pendingIn(beta.admin, beta.workspaceId);
    expect(forAlpha).toMatchObject({ tool: "workspace.fix", workspaceId: alpha.workspaceId, subject: { input: { workspace: "alpha" }, patchDigest: expect.any(String) } });
    expect((await alpha.admin.fetch(`/v1/artifacts/${forAlpha?.subject.patchDigest as string}`)).status).toBe(200);
    expect(await pendingIn(alpha.member, alpha.workspaceId)).toHaveLength(1);
    await expect(decide(alpha.member, alpha.workspaceId, forAlpha as Approval, "approve")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decide(alpha.admin, alpha.workspaceId, forBeta as Approval, "approve")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(decide(beta.admin, beta.workspaceId, forAlpha as Approval, "approve")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const before = (await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).snapshotDigest;
    await decide(alpha.admin, alpha.workspaceId, forAlpha as Approval, "approve");
    // The instance admin decides the other one from the platform workspace.
    expect(await pendingIn(harness.admin, platformId)).toHaveLength(1);
    await decide(harness.admin, platformId, forBeta as Approval, "approve");
    await driver.drain();

    const after = await alpha.admin.query("workspace.get", { workspaceId: alpha.workspaceId });
    expect(after.snapshotDigest).not.toBe(before);
    expect(Object.keys(after.snapshot.tools)).toContain("style.lint");
    expect(after.snapshot.agents["dev"]?.tools).toEqual(["lint.run", "style.lint"]);
    const file = await alpha.admin.query("file.read", { workspaceId: alpha.workspaceId, path: "tools/style.lint/test.sh" });
    expect(file.lastCommit?.message).toContain("Add the style.lint tool");
    expect((await beta.admin.query("file.read", { workspaceId: beta.workspaceId, path: "memory/lint-lesson.md" })).content).toContain("Run the linter");
    // The audit log of the target says which platform task proposed the change, and the platform's own folder did not change.
    expect(events("platform.fix", alpha.workspaceId)).toMatchObject([{ payload: { taskId: expect.any(String), commit: expect.any(String) } }]);
    expect(events("workspace.changed", alpha.workspaceId).at(-1)?.payload["paths"]).toContain("tools/style.lint/run.sh");
    const platformTask = events("platform.fix", alpha.workspaceId)[0]?.payload["taskId"] as string;
    expect((await getTask(harness.admin, platformId, platformTask)).toolCalls.map((call) => call.tool)).toContain("workspace.fix");
    expect((await harness.admin.query("tasks.list", { workspaceId: platformId, rootsOnly: true, limit: 10 })).tasks.some((task) => task.id === goal.taskId)).toBe(true);
    // The platform workspace is still invisible to the people of the others.
    await expect(alpha.admin.query("approvals.list", { workspaceId: platformId, state: "pending" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the weekly Play", () => {
  it("is scheduled on Monday at 07:00 in the platform workspace's time zone", async () => {
    const row = harness.governor.gov.db.prepare("SELECT spec, next_run_at_ms AS next FROM triggers WHERE workspace_id=? AND play='capitalize'").get(platformId) as { spec: string; next: number };
    expect(row.spec).toBe("0 7 * * 1");
    const next = new Date(row.next);
    expect(next.getUTCDay()).toBe(1);
    // 07:00 in Tunis (UTC+1) is 06:00 UTC.
    expect(next.getUTCHours()).toBe(6);
    expect(next.getUTCMinutes()).toBe(0);
    // When its time comes the Governor starts it, like a person would.
    clock.now = row.next + 1000;
    runSchedules(harness.governor.gov);
    const started = harness.governor.gov.db.prepare("SELECT title, created_by AS by FROM tasks WHERE workspace_id=? AND parent_id IS NULL ORDER BY rowid DESC LIMIT 1").get(platformId) as { title: string; by: string };
    expect(started.by).toBe("trigger:capitalize");
    expect(started.title).toContain("Capitalize");
  });
});
