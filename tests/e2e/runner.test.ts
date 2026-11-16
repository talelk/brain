import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerConfig } from "../../apps/runner/src/config";
import { Runner } from "../../apps/runner/src/runner";
import type { Timer } from "../../apps/runner/src/tools/approval";
import { startGitServer, type GitServer } from "../core/git-server";
import { createHarness, type Client, type Harness } from "../core/harness";
import { getTask, makeWorkspace, step } from "../core/work";
import { bareRepository, git, tempDir } from "../runner/git-repo";

/**
 * The real runner against the real Governor, in one process: the runner on its fixture engine (scripted by `FIXTURE` lines in the goals),
 * the Governor reached through the runner's transport seam, a project repository served over HTTP by the test.
 */
const origin = bareRepository({ "src/cart.js": "export const total = (items) => items.length;\n" });
let harness: Harness;
let server: GitServer;
let member: Client;
let workspaceId: string;
let runner: Runner;
/** What happens while the runner waits for an approval. The wait runs on this clock, so "in time" and "too late" are the test's to decide. */
let whileWaiting: () => Promise<void> = () => Promise.resolve();
const waited = { ms: 0 };
const timer: Timer = { now: () => waited.ms, sleep: async (ms) => { waited.ms += ms; await whileWaiting(); } };

const approveAll = async (): Promise<void> => {
  for (const approval of (await member.query("approvals.list", { workspaceId, state: "pending" })).approvals) {
    await member.command("approval.decide", { workspaceId, approvalId: approval.id, decision: "approve", subjectDigest: approval.subjectDigest });
  }
};
const runAll = async (): Promise<number> => {
  let attempts = 0;
  while (await runner.runOnce()) attempts += 1;
  return attempts;
};
const start = async (play: string): Promise<string> => (await member.command("task.create", { workspaceId, play })).taskId;

beforeAll(async () => {
  server = await startGitServer(dirname(origin.repo));
  harness = await createHarness({ fetch: (input, init) => fetch(input, init) });
  ({ workspaceId } = await makeWorkspace(harness, "Joined", {
    brain: `[[project]]\nname = "shop"\nrepo = "${server.origin}/origin.git"\nbranch = "main"\naccess = "write"\ncredential = "secret:github"\n`,
    agents: { writer: {}, developer: { native: "all", tools: ["git.open-pr"] }, operator: { tools: ["deploy.restart"] } },
    tools: { "deploy.restart": 'description = "Restarts one container."\neffect = "privileged"\nneeds = ["bash"]\n[inputs.container]\ntype = "string"\nrequired = true\n' },
    plays: {
      pipeline: 'title = "Pipeline"\n[[step]]\nid = "draft"\nagent = "writer"\ngoal = """Draft the note.\nFIXTURE @work reply The tide follows the moon."""\n[[step]]\nid = "polish"\nagent = "writer"\nafter = ["draft"]\ngoal = """Polish this: {{steps.draft.result}}\nFIXTURE @work reply Polished in round %round%."""\n',
      change: 'title = "Change"\n[[step]]\nid = "change"\nagent = "developer"\ngoal = """Fix the total.\nFIXTURE @work write shop/src/cart.js export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);\\\\n\nFIXTURE @work tool git.open-pr {"project": "shop", "title": "Fix the cart total", "body": "It counted the items."}\nFIXTURE @work reply Opened the pull request."""\n',
      restart: 'title = "Restart"\n[[step]]\nid = "restart"\nagent = "operator"\ngoal = """Restart the database.\nFIXTURE @work tool deploy.restart {"container": "db"}\nFIXTURE @work reply The database was restarted."""\n',
    },
  }));
  await harness.admin.command("secret.set", { workspaceId, name: "github", value: "ghp-test-token" });
  member = await harness.member(workspaceId, "max@example.com", "member");
  const cfg: RunnerConfig = {
    governorUrl: "http://localhost:3100", stateDir: tempDir("e2e-state"), name: "the real runner", enrollToken: (await harness.admin.command("runner.token", {})).token, capabilities: ["bash"], engines: ["fixture"], slots: 1,
    attemptTimeoutMs: 30_000, sandbox: { cpuMillicores: 1000, memoryMb: 1024 }, unsandboxedForTests: true, approval: { timer, pollMs: 10, waitMs: 30 },
    transport: (input, init) => Promise.resolve(harness.governor.app.fetch(new Request(input as string, init))),
  };
  runner = await Runner.connect(cfg);
});
afterAll(async () => {
  harness.close();
  await server.close();
});

describe("the runner and the Governor together", () => {
  it("a pipeline Play runs to a checked result", async () => {
    expect((await harness.admin.query("runners.list", {})).runners).toMatchObject([{ name: "the real runner", online: true, engines: ["fixture"], capabilities: ["bash", "native-tools"] }]);
    const taskId = await start("pipeline");
    expect(await runAll()).toBe(4);
    const task = await getTask(member, workspaceId, taskId);
    // `%round%` is the fixture's own placeholder: a Play's goal may hold it, and the engine fills it in.
    expect(task).toMatchObject({ state: "done", result: "Polished in round 1." });
    expect(task.attempts.map((attempt) => [attempt.kind, attempt.agent, attempt.state, attempt.engine])).toEqual([
      ["work", "writer", "succeeded", "fixture"], ["check", "checker", "succeeded", "fixture"], ["work", "writer", "succeeded", "fixture"], ["check", "checker", "succeeded", "fixture"],
    ]);
    expect((await getTask(member, workspaceId, step(task, "polish").id)).goal).toContain("Polish this: The tide follows the moon.");
    expect(task.checks.map((check) => [check.by.id, check.pass])).toEqual([["checker", true], ["checker", true]]);
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true });
  });

  it("an agent edits the working copy with its native tools, and the change leaves as a pull request a person approved", async () => {
    whileWaiting = approveAll;
    const base = origin.head();
    const taskId = await start("change");
    expect(await runAll()).toBe(2);
    whileWaiting = () => Promise.resolve();
    const task = await getTask(member, workspaceId, taskId);
    const change = step(task, "change");
    const branch = `brain/${change.id}`;
    expect(task).toMatchObject({ state: "done", result: "Opened the pull request." });
    expect(task.toolCalls[0]?.output).toEqual({ url: "https://github.example/origin/pull/41", number: 41, branch });
    expect(git(origin.repo, "show", `${branch}:src/cart.js`)).toBe("export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);");
    expect(git(origin.repo, "log", "--format=%s|%P", "-1", branch)).toBe(`Fix the cart total|${base}`);
    expect(server.opened).toEqual([{ repo: "origin", title: "Fix the cart total", head: branch, base: "main", body: "It counted the items." }]);
    expect(task.approvals).toMatchObject([{ tool: "git.open-pr", state: "approved", standing: false, subject: { patchDigest: expect.stringMatching(/^sha256:/u), baseCommit: base } }]);
    expect(task.pullRequests).toMatchObject([{ project: "shop", number: 41, branch }]);
    // The attempt left its working copy as a patch, on the commit it found; the check was given that patch to work on.
    const work = task.attempts[0];
    expect(task.artifacts.filter((artifact) => artifact.attemptId === work?.id).map((artifact) => artifact.kind)).toContain("patch");
    expect(task.toolCalls.map((call) => [call.tool, call.outcome])).toEqual([["git.open-pr", "succeeded"]]);
  });

  it("a call nobody approved in time is held; once approved, an attempt of its own runs it and the task goes on", async () => {
    const taskId = await start("restart");
    expect(await runner.runOnce()).toBe(true);
    const held = await getTask(member, workspaceId, taskId);
    expect(step(held, "restart")).toMatchObject({ state: "needs_you", needs: { kind: "approval" } });
    expect(held.attempts.map((attempt) => [attempt.kind, attempt.state])).toEqual([["work", "held"]]);
    expect(held.toolCalls).toMatchObject([{ tool: "deploy.restart", outcome: "held" }]);
    expect(await runner.runOnce()).toBe(false);
    await approveAll();
    // The approved call runs alone; then the agent is run again, repeats its call, and this time a person approves while it waits.
    expect(await runner.runOnce()).toBe(true);
    expect((await getTask(member, workspaceId, taskId)).toolCalls).toMatchObject([{ tool: "deploy.restart", outcome: "succeeded", output: { container: "db" } }]);
    whileWaiting = approveAll;
    expect(await runAll()).toBe(2);
    const task = await getTask(member, workspaceId, taskId);
    expect(task.attempts.map((attempt) => [attempt.kind, attempt.state])).toEqual([["work", "held"], ["act", "succeeded"], ["work", "succeeded"], ["check", "succeeded"]]);
    expect(task).toMatchObject({ state: "done", result: "The database was restarted." });
    expect(task.approvals.map((approval) => approval.state)).toEqual(["approved", "approved"]);
  });
});
