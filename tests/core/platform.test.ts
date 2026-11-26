import { type Approval, type BrainToolResponse, type JobOffer, type JsonValue } from "@brain/contracts";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repeatsOf } from "../../apps/governor/src/tools/repeats";
import { runSchedules } from "../../apps/governor/src/tasks/triggers";
import { enrolRunner, type Driver, type Turn } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, testClock } from "./work";

/** The platform workspaces (docs/model.md): the one admin workspace keeps the packs and, like any `read` one, reads every other workspace and proposes changes, each approved by an admin. */
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
  ({ workspaceId: platformId } = await makeWorkspace(harness, "Brain admin", { platform: "admin", packs: ["base", "platform"], brain: 'timezone = "Africa/Tunis"\n' }));
});
afterAll(() => harness.close());

describe("the platform setting", () => {
  it("is set only by an instance admin, and a Brain has one admin workspace", async () => {
    const setting = async (client: Client, workspaceId: string, on: boolean) => {
      const { content } = await harness.admin.query("file.read", { workspaceId, path: "brain.toml" });
      return client.command("file.write", { workspaceId, files: [{ path: "brain.toml", content: on ? `platform = "admin"\n${content}` : content.replace('platform = "admin"\n', "") }] });
    };
    // A workspace admin, however it is written, cannot make their workspace the platform.
    await expect(setting(alpha.admin, alpha.workspaceId, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(alpha.admin.command("file.write", { workspaceId: alpha.workspaceId, files: [{ path: "brain.toml", content: 'name = "Alpha"\nplatform = "read"\npacks = ["base"]\n' }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An instance admin may, but not a second admin workspace, and a pack of the platform needs the setting.
    await expect(setting(harness.admin, alpha.workspaceId, true)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(harness.createWorkspace({ name: "Another", packs: ["base"], platform: "admin" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(harness.createWorkspace({ name: "Sneaky", packs: ["base", "platform"] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
    expect((await harness.admin.query("workspace.get", { workspaceId: platformId })).platform).toBe("admin");
    expect((await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).platform).toBeNull();
  });

  it("makes the workspace invisible to anyone who is not an instance admin, a member or not", async () => {
    const insider = await harness.member(platformId, "insider@example.com", "admin");
    await expect(insider.query("workspace.get", { workspaceId: platformId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(insider.command("file.write", { workspaceId: platformId, files: [{ path: "brain.toml", content: 'name = "Brain admin"\npacks = ["base", "platform"]\n' }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await insider.query("me", {})).workspaces.map((workspace) => workspace.id)).not.toContain(platformId);
    expect((await harness.admin.query("me", {})).workspaces.find((workspace) => workspace.id === platformId)).toMatchObject({ platform: "admin" });
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
        const list = answerOf(await brain("platform.workspaces", {})) as { workspaces: Array<{ slug: string; platform: string | null; tasks: { done: number } }> };
        expect(list.workspaces.map((workspace) => workspace.slug)).toEqual(["alpha", "beta", "brain-admin", "starter"]);
        expect(list.workspaces.find((workspace) => workspace.slug === "brain-admin")?.platform).toBe("admin");
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

describe("tool drift", () => {
  it("lists the tools, agents and Plays workspaces hold that differ from the packs or that no pack has, and not the tools Brain runs", async () => {
    const own = (await harness.admin.query("file.read", { workspaceId: beta.workspaceId, path: "tools/web.fetch/run.sh" })).content;
    const files = ["tool.toml", "run.sh", "test.sh"];
    const fetched = await Promise.all(files.map(async (name) => ({ path: `tools/web.fetch/${name}`, content: (await harness.admin.query("file.read", { workspaceId: beta.workspaceId, path: `tools/web.fetch/${name}` })).content })));
    await harness.admin.command("file.write", { workspaceId: beta.workspaceId, files: [
      ...fetched.map((file) => (file.path.endsWith("run.sh") ? { ...file, content: `${own}# retries once\n` } : file)),
      { path: "tools/repo.report/tool.toml", content: lint }, { path: "tools/repo.report/run.sh", content: "#!/bin/sh\ncat\n" }, { path: "tools/repo.report/test.sh", content: "#!/bin/sh\necho 'repo.report: ok'\n" },
    ] });
    let drift: Array<{ kind: string; name: string; status: string; pack: string | null; workspaces: string[]; hasTest: boolean }> = [];
    driver.script({ syncer: async ({ brain }) => { drift = (answerOf(await brain("platform.tool-drift", {})) as { drift: typeof drift }).drift; return "Compared."; } });
    await harness.admin.command("task.create", { workspaceId: platformId, play: "sync-tools" });
    await driver.drain();
    expect(drift.filter((entry) => entry.kind === "tool")).toMatchObject(expect.arrayContaining([expect.objectContaining({ name: "repo.report", status: "new", pack: null, workspaces: ["beta"], hasTest: true }), expect.objectContaining({ name: "web.fetch", status: "differs", pack: "base", workspaces: ["beta"] })]));
    expect(drift.map((entry) => entry.name)).not.toContain("task.create");
    expect(drift.filter((entry) => entry.kind === "agent").map((entry) => entry.name)).toEqual(expect.arrayContaining(["dev", "scribe"]));
  });
});

describe("the capitalizer's proposals", () => {
  it("is offered its eight tools with their schemas, whatever the admin workspace holds under packs/", async () => {
    let offered: JobOffer | undefined;
    driver.script({ capitalizer: ({ offer }) => { offered = offer; return "Looked."; } });
    await harness.admin.command("task.create", { workspaceId: platformId, play: "capitalize" });
    await driver.drain();
    const names = ["platform.repeats", "platform.tasks", "platform.task", "platform.file", "platform.workspaces", "workspace.fix", "memory.search", "task.ask"];
    expect(offered?.agent.tools).toEqual(names);
    expect(offered?.tools.map((tool) => tool.name)).toEqual(names);
    for (const tool of offered?.tools ?? []) expect(tool.inputSchema, tool.name).toMatchObject({ type: "object" });
  });

  it("land only in the admin workspace's pack sources, each approved by an admin of it, and no other workspace is written", async () => {
    const worker = (await harness.admin.query("file.read", { workspaceId: platformId, path: "packs/base/io.github.talelk.brain/agents/worker/agent.toml" })).content;
    const tool = (name: string): JsonValue[] => [
      { path: `packs/base/io.github.talelk.brain/tools/${name}/tool.toml`, content: `description = "Lints the repository and reports the style problems."\neffect = "read"\nneeds = ["bash"]\n[inputs.path]\ntype = "string"\nrequired = false\n` },
      { path: `packs/base/io.github.talelk.brain/tools/${name}/run.sh`, content: "#!/bin/sh\ncat >/dev/null\necho '{\"ok\": true}'\n" }, { path: `packs/base/io.github.talelk.brain/tools/${name}/test.sh`, content: `#!/bin/sh\necho "${name}: ok"\n` },
      { path: "packs/base/io.github.talelk.brain/agents/worker/agent.toml", content: worker.replace(/tools = \[/u, `tools = ["${name}", `) },
    ];
    const proposals: Array<{ state: string; error?: string }> = [];
    driver.script({
      capitalizer: async (turn) => {
        if (turn.offer.act) return act(turn);
        if (turn.offer.task.findings.length > 0) return "Proposed one change.";
        const send = async (input: JsonValue) => { const answer = await turn.brain("workspace.fix", input); proposals.push(answer as { state: string }); return answer; };
        await send({ files: tool("style.lint"), message: "Add the style.lint tool", why: "dev ran lint.run four times in alpha and beta." });
        // Refused at once: another workspace, a file outside packs/, the platform setting, a heal's task input.
        await send({ workspace: "alpha", files: [{ path: "packs/base/io.github.talelk.brain/memory/x.md", content: "# X\n" }], message: "x", why: "x" });
        await send({ files: [{ path: "tools/style.lint/tool.toml", content: lint }], message: "x", why: "x" });
        await send({ files: [{ path: "brain.toml", content: 'name = "Brain admin"\npackages = []\n' }], message: "x", why: "x" });
        await send({ task: "t_x", files: [{ path: "packs/base/io.github.talelk.brain/memory/x.md", content: "# X\n" }], message: "x", why: "x" });
        return { outcome: "held", result: "I proposed a change and stopped." };
      },
    });
    await harness.admin.command("task.create", { workspaceId: platformId, play: "capitalize" });
    await driver.drain();
    expect(proposals.map((proposal) => proposal.state)).toEqual(["pending", "failed", "failed", "failed", "failed"]);
    expect(proposals[1]?.error).toContain("not an input");
    expect(proposals[2]?.error).toContain("packs/");
    expect(proposals[4]?.error).toContain("leave it out");

    const pending = [...(await harness.admin.query("approvals.list", { workspaceId: platformId, state: "pending" })).approvals];
    expect(pending).toMatchObject([{ tool: "workspace.fix", workspaceId: platformId, subject: { patchDigest: expect.any(String) } }]);
    // The people of another workspace see nothing of it, and an admin of the platform workspace decides.
    await expect(alpha.admin.query("approvals.list", { workspaceId: platformId, state: "pending" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const alphaBefore = (await alpha.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).snapshotDigest;
    await decide(harness.admin, platformId, pending[0] as Approval, "approve");
    await driver.drain();
    expect((await harness.admin.query("file.read", { workspaceId: platformId, path: "packs/base/io.github.talelk.brain/tools/style.lint/test.sh" })).content).toContain("style.lint: ok");
    expect((await harness.admin.query("file.read", { workspaceId: platformId, path: "packs/base/io.github.talelk.brain/tools/style.lint/test.sh" })).lastCommit?.message).toContain("Add the style.lint tool");
    expect((await alpha.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).snapshotDigest).toBe(alphaBefore);
    expect(events("workspace.changed", alpha.workspaceId).at(-1)?.payload["paths"]).not.toContain("packs/base/io.github.talelk.brain/tools/style.lint/run.sh");
  });
});

describe("releases and pins", () => {
  const packs = (client: Client, workspaceId: string) => client.query("workspace.get", { workspaceId });
  const setPacks = async (client: Client, workspaceId: string, list: string[]) => {
    const { content } = await harness.admin.query("file.read", { workspaceId, path: "brain.toml" });
    return client.command("file.write", { workspaceId, files: [{ path: "brain.toml", content: content.replace(/^packs = .*$/mu, `packs = ${JSON.stringify(list)}`) }] });
  };

  it("a release freezes a version; a workspace pinned to it resolves exactly it whatever is edited later", async () => {
    expect((await packs(alpha.admin, alpha.workspaceId)).updates).toEqual([]);
    await expect(alpha.admin.command("pack.release", { workspaceId: alpha.workspaceId, name: "base" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(alpha.admin.command("pack.release", { workspaceId: platformId, name: "base" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(harness.admin.command("pack.release", { workspaceId: platformId, name: "no-such" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.admin.command("pack.release", { workspaceId: platformId, name: "base" })).toEqual({ version: 1 });
    const list = (await harness.admin.query("packs.list", {})).packs.find((pack) => pack.name === "base");
    expect(list).toMatchObject({ version: 1, released: [1], working: { changed: false }, usedBy: expect.arrayContaining([{ slug: "alpha", name: "Alpha", pin: 0 }]) });
    expect(events("pack.released", platformId)).toMatchObject([{ payload: { name: "base", version: 1 } }]);

    // Update available: only for a workspace whose release is newer than its pin.
    expect((await packs(alpha.admin, alpha.workspaceId)).updates).toEqual([{ pack: "base", pinned: 0, latest: 1 }]);
    expect((await harness.admin.query("overview", {})).workspaces.find((workspace) => workspace.slug === "alpha")?.updates).toBe(1);
    await expect(setPacks(alpha.admin, alpha.workspaceId, ["base@9"])).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
    await setPacks(alpha.admin, alpha.workspaceId, ["base@1"]);
    const pinned = await packs(alpha.admin, alpha.workspaceId);
    expect(pinned.updates).toEqual([]);
    expect(pinned.snapshot.pins).toEqual({ base: 1 });
    expect(events("workspace.changed", alpha.workspaceId).at(-1)?.payload["paths"]).toEqual(["brain.toml"]);

    // The platform edits its copy and releases again: the pinned workspace keeps what it pinned until its admin updates.
    const before = (await alpha.admin.query("file.read", { workspaceId: alpha.workspaceId, path: "agents/planner/prompt.md" })).content;
    await harness.admin.command("file.write", { workspaceId: platformId, files: [{ path: "packs/base/io.github.talelk.brain/agents/planner/prompt.md", content: `${before}\nAlways answer in French.\n` }] });
    expect((await harness.admin.query("packs.list", {})).packs.find((pack) => pack.name === "base")?.working).toEqual({ changed: true });
    expect((await alpha.admin.query("file.read", { workspaceId: alpha.workspaceId, path: "agents/planner/prompt.md" })).content).toBe(before);
    expect(await harness.admin.command("pack.release", { workspaceId: platformId, name: "base" })).toEqual({ version: 2 });
    expect((await alpha.admin.query("file.read", { workspaceId: alpha.workspaceId, path: "agents/planner/prompt.md" })).content).toBe(before);
    expect((await packs(alpha.admin, alpha.workspaceId)).updates).toEqual([{ pack: "base", pinned: 1, latest: 2 }]);
    // Its admin reads the difference, then the update commits the new pin; the first release is still readable as it was.
    const files = async (version: number) => (await alpha.admin.query("pack.files", { workspaceId: alpha.workspaceId, name: "base", version })).files.find((file) => file.path === "io.github.talelk.brain/agents/planner/prompt.md")?.content;
    expect(await files(1)).toBe(before);
    expect(await files(2)).toContain("Always answer in French.");
    await expect(alpha.admin.query("pack.files", { workspaceId: alpha.workspaceId, name: "base", version: "working" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(alpha.admin.query("pack.files", { workspaceId: platformId, name: "base", version: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setPacks(alpha.admin, alpha.workspaceId, ["base@2"]);
    expect((await packs(alpha.admin, alpha.workspaceId)).updates).toEqual([]);
    expect((await alpha.admin.query("file.read", { workspaceId: alpha.workspaceId, path: "agents/planner/prompt.md" })).content).toContain("Always answer in French.");
    // Same folder and same releases give the same snapshot, on every load.
    const digest = (await packs(alpha.admin, alpha.workspaceId)).snapshotDigest;
    await harness.restart();
    expect((await (await harness.signIn("alpha-admin@example.com")).query("workspace.get", { workspaceId: alpha.workspaceId })).snapshotDigest).toBe(digest);
  });
});

describe("the weekly Plays", () => {
  it("are scheduled on Monday at 07:00 (and 07:30) in the platform workspace's time zone", async () => {
    const row = harness.governor.gov.db.prepare("SELECT spec, next_run_at_ms AS next FROM triggers WHERE workspace_id=? AND play='capitalize'").get(platformId) as { spec: string; next: number };
    expect(row.spec).toBe("0 7 * * 1");
    expect((harness.governor.gov.db.prepare("SELECT spec FROM triggers WHERE workspace_id=? AND play='sync-tools'").get(platformId) as { spec: string }).spec).toBe("30 7 * * 1");
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

describe("a read platform workspace", () => {
  it("reads the other workspaces like the admin one, audited, and has no pack management", async () => {
    // Several `read` workspaces are allowed beside the one admin workspace.
    const { workspaceId: readerId } = await makeWorkspace(harness, "Reader", { platform: "read", packs: ["base", "platform"] });
    expect(await harness.createWorkspace({ name: "Reader two", packs: ["base"], platform: "read" })).toMatchObject({ slug: "reader-two" });
    expect((await harness.admin.query("workspace.get", { workspaceId: readerId })).platform).toBe("read");
    let drift: unknown;
    let listed: string[] = [];
    driver.script({ capitalizer: async ({ brain }) => { listed = ((answerOf(await brain("platform.workspaces", {})) as { workspaces: Array<{ slug: string }> }).workspaces).map((workspace) => workspace.slug); return "Read."; }, syncer: async ({ brain }) => { drift = await brain("platform.tool-drift", {}); return "Compared."; } });
    await harness.admin.command("task.create", { workspaceId: readerId, play: "capitalize" });
    await harness.admin.command("task.create", { workspaceId: readerId, play: "sync-tools" });
    await driver.drain();
    expect(listed).toContain("alpha");
    expect(events("platform.read", alpha.workspaceId).some((event) => event.payload["source"] === "reader")).toBe(true);
    // Comparing with the pack sources is for the admin workspace, which alone keeps them.
    expect(drift).toMatchObject({ state: "failed", error: expect.stringContaining("only the admin workspace") });
    // No pack management: no release, no pack sources seeded, and a packs/ file is an ordinary document that no pack, pin or release ever reads.
    await expect(harness.admin.command("pack.release", { workspaceId: readerId, name: "base" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(harness.admin.query("pack.files", { workspaceId: readerId, name: "base", version: "working" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.admin.query("workspace.files", { workspaceId: readerId })).files.some((file) => file.path.startsWith("packs/"))).toBe(false);
    await harness.admin.command("file.write", { workspaceId: readerId, files: [{ path: "packs/base/io.github.talelk.brain/tools/sneaky/tool.toml", content: 'description = "Sneaky."\neffect = "read"\n' }] });
    expect(Object.keys((await harness.admin.query("workspace.get", { workspaceId: readerId })).snapshot.tools)).not.toContain("sneaky");
    expect((await harness.admin.query("packs.list", {})).packs.find((pack) => pack.name === "base")?.working).toEqual({ changed: false });
  });
});

describe("update all workspaces", () => {
  it("the admin workspace moves every workspace to the latest release at once, and only the admin workspace may", async () => {
    const { version } = await harness.admin.command("pack.release", { workspaceId: platformId, name: "base" });
    await expect(harness.admin.command("packs.updateAll", { workspaceId: alpha.workspaceId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const done = await harness.admin.command("packs.updateAll", { workspaceId: platformId });
    expect(done.failed).toEqual([]);
    expect(done.updated.find((one) => one.slug === "alpha")?.packs).toEqual([expect.objectContaining({ pack: "base", latest: version })]);
    expect((await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).updates).toEqual([]);
    expect((await harness.admin.query("workspace.get", { workspaceId: alpha.workspaceId })).snapshot.pins).toMatchObject({ base: version });
    expect(events("packs.updated", alpha.workspaceId)).toHaveLength(1);
    expect(await harness.admin.command("packs.updateAll", { workspaceId: platformId })).toEqual({ updated: [], failed: [] });
  });

  it("releases nothing that leaves the shape of a pack, and says what", async () => {
    const path = "packs/base/io.github.talelk.brain/agents/worker/agent.toml";
    const before = (await harness.admin.query("file.read", { workspaceId: platformId, path })).content;
    await harness.admin.command("file.write", { workspaceId: platformId, files: [{ path, content: before.replace(/spend_usd = [0-9.]+/u, "spend_usd = 90") }] });
    await expect(harness.admin.command("pack.release", { workspaceId: platformId, name: "base" })).rejects.toMatchObject({ code: "INVALID_WORKSPACE", problems: [expect.objectContaining({ path, message: expect.stringContaining("spend limit") as string })] });
    await harness.admin.command("file.write", { workspaceId: platformId, files: [{ path, content: before }] });
  });

  it("pins a pack the workspace uses only because another pack requires it", async () => {
    const { workspaceId } = await makeWorkspace(harness, "Factory", { packs: ["software-factory"] });
    const factory = () => harness.admin.query("workspace.get", { workspaceId });
    const [update] = (await factory()).updates;
    expect(update).toMatchObject({ pack: "base", pinned: 0 });
    const done = await harness.admin.command("packs.updateAll", { workspaceId: platformId });
    expect(done.failed).toEqual([]);
    expect((await factory()).updates).toEqual([]);
    expect((await factory()).snapshot.pins).toEqual({ base: update?.latest });
    expect((await harness.admin.query("file.read", { workspaceId, path: "brain.toml" })).content).toContain(`packs = ["software-factory", "base@${update?.latest}"]`);
  });
});
