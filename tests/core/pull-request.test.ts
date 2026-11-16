import type { Approval, BrainToolResponse } from "@brain/contracts";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bareRepository, git, writeFiles } from "../runner/git-repo";
import { enrolRunner, type Driver, type Turn } from "./driver";
import { startGitServer, type GitServer } from "./git-server";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step } from "./work";

/** `git.open-pr` (docs/architecture.md section 8) against a real repository over HTTP, with the GitHub API answered by the test. */
let harness: Harness;
let server: GitServer;
let member: Client;
let workspaceId: string;
let driver: Driver;
const origin = bareRepository({ "README.md": "# Shop\n", "src/cart.js": "export const total = (items) => items.length;\n" });

/** The patch of a change to the project, in the form a runner uploads it: paths start with the project's folder. */
function patchOf(files: Record<string, string>): string {
  writeFiles(origin.clone, files);
  git(origin.clone, "add", "--intent-to-add", "--all");
  const patch = git(origin.clone, "diff", "--binary", "--full-index", "--no-renames", "--src-prefix=a/shop/", "--dst-prefix=b/shop/", "HEAD");
  git(origin.clone, "reset", "--quiet", "--hard", "HEAD");
  git(origin.clone, "clean", "--quiet", "-fd");
  return `${patch}\n`;
}
const approve = async (): Promise<Approval> => {
  const [approval] = (await member.query("approvals.list", { workspaceId, state: "pending" })).approvals;
  await member.command("approval.decide", { workspaceId, approvalId: approval?.id ?? "", decision: "approve", subjectDigest: approval?.subjectDigest ?? "" });
  return approval as Approval;
};
/** Asks to open the pull request, has it approved, and asks again with the same call id, as a runner does. */
const openPr = async ({ post }: Turn, input: { project: string; title: string; body: string }): Promise<BrainToolResponse> => {
  const call = { callId: `open-${input.title}`, tool: "git.open-pr", input };
  const asked = await post<BrainToolResponse>("brain-tool", call);
  if (asked.state !== "pending") return asked;
  await approve();
  return post<BrainToolResponse>("brain-tool", call);
};
const play = `title = "Fix"\n[[step]]\nid = "change"\nagent = "developer"\ngoal = "Fix the cart total."\n[[step]]\nid = "release"\nagent = "releaser"\nafter = ["change"]\ngoal = "Open the pull request."\n`;

beforeAll(async () => {
  server = await startGitServer(dirname(origin.repo));
  harness = await createHarness({ fetch: (input, init) => fetch(input, init) });
  ({ workspaceId } = await makeWorkspace(harness, "Shop", {
    brain: `[[project]]\nname = "shop"\nrepo = "${server.origin}/origin.git"\nbranch = "main"\naccess = "write"\ncredential = "secret:github"\n[[project]]\nname = "docs"\nrepo = "${server.origin}/origin.git"\n`,
    agents: { developer: { tools: ["git.open-pr"], native: "all" }, releaser: { tools: ["git.open-pr"], native: "read" } },
    plays: { fix: play, solo: 'title = "Solo"\n[[step]]\nid = "change"\nagent = "developer"\ngoal = "Change and open."\n' },
  }));
  await harness.admin.command("secret.set", { workspaceId, name: "github", value: "ghp-test-token" });
  member = await harness.member(workspaceId, "max@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass() });
});
afterAll(async () => {
  harness.close();
  await server.close();
});

describe("git.open-pr", () => {
  it("opens a pull request from the working copy's change once a person approved exactly that change", async () => {
    const base = origin.head();
    const patch = patchOf({ "src/cart.js": "export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);\n", "test/cart.test.js": "// the total adds the prices\n" });
    let subject: Approval["subject"] | undefined;
    driver.script({
      developer: async (turn) => {
        // No change yet: there is nothing to open.
        expect(await openPr(turn, { project: "shop", title: "Nothing", body: "x" })).toMatchObject({ state: "failed", error: expect.stringContaining("no changes") });
        await turn.upload("working-copy.patch", patch, "patch");
        const call = { callId: "the-pull-request", tool: "git.open-pr", input: { project: "shop", title: "Fix the cart total", body: "It added nothing up." } };
        expect(await turn.post<BrainToolResponse>("brain-tool", call)).toMatchObject({ state: "pending" });
        expect(server.opened).toEqual([]);
        subject = (await approve()).subject;
        expect(await turn.post<BrainToolResponse>("brain-tool", call)).toEqual({ state: "done", output: { url: "https://github.example/origin/pull/41", number: 41, branch: `brain/${turn.offer.task.id}` } });
        // A project the workspace may only read, and one it does not have, are refused before anyone is asked, in words the agent can act on.
        expect(await openPr(turn, { project: "docs", title: "x", body: "x" })).toMatchObject({ state: "failed", error: expect.stringContaining("read-only") });
        expect(await openPr(turn, { project: "blog", title: "y", body: "x" })).toMatchObject({ state: "failed", error: expect.stringContaining("The projects are: shop, docs") });
        return { result: "Opened https://github.example/origin/pull/41", patch, baseCommits: { shop: base } };
      },
    });
    const taskId = step(await getTask(member, workspaceId, (await member.command("task.create", { workspaceId, play: "solo" })).taskId), "change").id;
    await driver.drain();
    const branch = `brain/${taskId}`;
    expect(git(origin.repo, "show", `${branch}:src/cart.js`)).toContain("sum + item.price");
    expect(git(origin.repo, "show", `${branch}:test/cart.test.js`)).toBe("// the total adds the prices");
    expect(git(origin.repo, "log", "--format=%an|%s|%P", "-1", branch)).toBe(`Brain|Fix the cart total|${base}`);
    expect(git(origin.repo, "rev-parse", "main")).toBe(base);
    expect(server.opened).toEqual([{ repo: "origin", title: "Fix the cart total", head: branch, base: "main", body: "It added nothing up." }]);
    // The branch was pushed with the project's credential, and so was the API call.
    expect(server.requests.find((request) => request.path.endsWith("/git-receive-pack"))?.authorization).toBe(`Basic ${Buffer.from("x-access-token:ghp-test-token").toString("base64")}`);
    expect(server.requests.find((request) => request.path.startsWith("/api/"))?.authorization).toBe("Bearer ghp-test-token");
    const task = await getTask(member, workspaceId, taskId);
    expect(task.state).toBe("done");
    expect(task.pullRequests).toMatchObject([{ project: "shop", branch, url: "https://github.example/origin/pull/41", number: 41, state: "open" }]);
    // What the approver was shown is the patch that was opened, and a member can read it.
    expect(subject).toMatchObject({ tool: "git.open-pr", input: { project: "shop", title: "Fix the cart total" }, patchDigest: expect.stringMatching(/^sha256:/u) });
    expect(await (await member.fetch(`/v1/artifacts/${subject?.patchDigest}`)).text()).toBe(patch);
    expect(task.artifacts.map((artifact) => [artifact.name, artifact.kind])).toEqual([["working-copy.patch", "patch"], ["pull-request.patch", "pull-request"], ["working-copy.patch", "patch"]]);
  });

  it("a later step opens the pull request for the change of the step it waits for, on the commit that change was made on", async () => {
    const base = origin.head();
    const patch = patchOf({ "README.md": "# Shop\n\nNow with a correct cart total.\n" });
    driver.script({
      developer: () => ({ result: "Changed the README.", patch, baseCommits: { shop: base } }),
      releaser: async (turn) => {
        expect(turn.offer.projects[0]).toMatchObject({ name: "shop", baseCommit: base, credential: "github" });
        expect(turn.offer.inheritedPatches).toHaveLength(1);
        expect(turn.offer.workingCopy).toBeUndefined();
        const opened = await openPr(turn, { project: "shop", title: "Say the total is right", body: "Follows the fix." });
        return opened.state === "done" ? `Opened ${(opened.output as { url: string }).url}` : JSON.stringify(opened);
      },
    });
    const taskId = (await member.command("task.create", { workspaceId, play: "fix" })).taskId;
    const offers = [await driver.step(), await driver.step()];
    // The check of the change works on the change: its working copy starts from the patch it checks.
    expect(offers[1]).toMatchObject({ kind: "check", inheritedPatches: [{ digest: offers[1]?.context.review?.[0]?.patch?.digest }] });
    // The branch moves on while the goal is in progress; the goal stays on the commit it started from.
    const moved = origin.commit({ "CHANGELOG.md": "Unrelated.\n" }, "unrelated");
    await driver.drain();
    const release = step(await getTask(member, workspaceId, taskId), "release");
    const branch = `brain/${release.id}`;
    expect(git(origin.repo, "show", `${branch}:README.md`)).toContain("Now with a correct cart total.");
    expect(git(origin.repo, "log", "--format=%P", "-1", branch)).toBe(base);
    expect(moved).not.toBe(base);
    expect((await getTask(member, workspaceId, taskId)).result).toBe("Opened https://github.example/origin/pull/42");
  });

  it("a change that does not fit the commit is refused with the paths, and nothing is pushed", async () => {
    const stale = patchOf({ "src/cart.js": "export const total = () => 0;\n" }).replace("items.length", "items.size");
    driver.script({
      developer: async (turn) => {
        await turn.upload("working-copy.patch", stale, "patch");
        const opened = await openPr(turn, { project: "shop", title: "Stale", body: "x" });
        expect(opened).toMatchObject({ state: "failed", error: expect.stringContaining("src/cart.js") });
        return "It did not apply.";
      },
    });
    const pushes = server.requests.filter((request) => request.path.endsWith("/git-receive-pack")).length;
    await member.command("task.create", { workspaceId, play: "solo" });
    await driver.drain();
    expect(server.requests.filter((request) => request.path.endsWith("/git-receive-pack")).length).toBe(pushes);
    expect(server.opened).toHaveLength(2);
  });
});
