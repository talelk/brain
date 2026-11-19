import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { OfferProject } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { collectOutputs, credentialEnv, prepareWorkingCopy, SetupError, type WorkingCopy } from "../../apps/runner/src/working-copy";
import { bareRepository, git, tempDir, writeFiles } from "./git-repo";
import { testStore } from "./store";

const BINARY = new Uint8Array([0, 1, 2, 255, 254, 0, 10, 13]);
const FILES = { "README.md": "# App\n", "src/a.txt": "one\ntwo\nthree\n", "src/old.txt": "to be deleted\n", ".gitignore": "node_modules/\n*.log\n" };

const store = await testStore();
/** What a finished attempt leaves for the next: the attempt and the commit of each project it pushed. */
interface State { readonly attemptId: string; readonly commits: Readonly<Record<string, string>> }
let worlds = 0;
let attempts = 0;

function world() {
  const origin = bareRepository(FILES);
  const stateDir = tempDir("state");
  const workspaceId = `ws${++worlds}`;
  const project: OfferProject = { name: "app", repo: origin.repo, branch: "main", access: "write", network: [] };
  let last = "";
  /** `inherited` are the states this attempt starts from, in order: those of the tasks it waits for, then its own earlier attempt's. */
  const prepare = (before: { inherited?: State[] } = {}, overrides: Partial<OfferProject> = {}): Promise<WorkingCopy | undefined> => {
    const attemptId = (last = `a${++attempts}`);
    return prepareWorkingCopy({
      stateDir, workspaceId, attemptDir: join(stateDir, "attempts", attemptId), attemptId, store: store.offer(workspaceId, "g1", attemptId), projects: [{ ...project, ...overrides }], credential: async () => "unused",
      inherited: (before.inherited ?? []).map((state, index, all) => ({ label: `the changes of prerequisite ${index + 1} of ${all.length}`, ...state })),
    });
  };
  return { origin, stateDir, workspaceId, project, prepare, attempt: () => last };
}

describe("working copy", () => {
  it("mirrors the repository and checks the branch head out, reporting the commit", async () => {
    const w = world();
    const copy = (await w.prepare())!;
    expect(existsSync(join(w.stateDir, "repos", w.workspaceId, "app.git", "HEAD"))).toBe(true);
    expect(copy.baseCommits).toEqual({ app: w.origin.head() });
    expect(readFileSync(join(copy.root, "app", "src/a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    // The working copy is a repository of its own, with no address of the runner's mirror in it.
    expect(git(join(copy.root, "app"), "status", "--porcelain")).toBe("");
    expect(git(join(copy.root, "app"), "remote")).toBe("");
    expect(await copy.diff()).toEqual(new Uint8Array());
    expect(await copy.push()).toEqual({});
  });

  it("works on the base commit an earlier attempt worked on, even after the branch moved", async () => {
    const w = world();
    const first = w.origin.head();
    w.origin.commit({ "src/a.txt": "changed upstream\n" }, "second");
    const pinned = (await w.prepare({}, { baseCommit: first }))!;
    expect(pinned.baseCommits).toEqual({ app: first });
    expect(readFileSync(join(pinned.root, "app", "src/a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    const latest = (await w.prepare())!;
    expect(latest.baseCommits).toEqual({ app: w.origin.head() });
    expect(readFileSync(join(latest.root, "app", "src/a.txt"), "utf8")).toBe("changed upstream\n");
  });

  it("works on a base commit far older than the fetched window, fetching it alone, and takes a diff from it", async () => {
    const w = world();
    const first = w.origin.head();
    for (let i = 0; i < 60; i++) w.origin.commit({ "src/a.txt": `change ${i}\n`, [`gen/f${i}.txt`]: `${i}\n` }, `c${i}`);
    const copy = (await w.prepare({}, { baseCommit: first }))!;
    expect(copy.baseCommits).toEqual({ app: first });
    const dir = join(copy.root, "app");
    expect(readFileSync(join(dir, "src/a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    writeFiles(dir, { "src/a.txt": "one\nTWO\nthree\n" });
    expect(Buffer.from(await copy.diff()).toString("utf8")).toContain("diff --git a/app/src/a.txt b/app/src/a.txt\n");
    const lost = "0".repeat(40);
    await expect(w.prepare({}, { baseCommit: lost })).rejects.toMatchObject({ name: "SetupError", infrastructure: false });
  });
  it("works on a base commit the mirror holds but no ref reaches, left by an earlier fetch of the branch before it moved far past", async () => {
    const w = world();
    const first = w.origin.head();
    // The base was fetched earlier (the branch then was within the window)...
    expect((await w.prepare({}, { baseCommit: first }))!.baseCommits).toEqual({ app: first });
    // ...then the branch advanced past the window and was fetched again, so that no ref reaches the base any more.
    for (let i = 0; i < 60; i++) w.origin.commit({ "src/a.txt": `change ${i}\n`, [`gen/f${i}.txt`]: `${i}\n` }, `c${i}`);
    const mirror = join(w.stateDir, "repos", w.workspaceId, "app.git");
    await w.prepare();
    git(mirror, "update-ref", "-d", `refs/heads/base-${first}`);
    expect(git(mirror, "for-each-ref", "--contains", first)).toBe("");
    expect(git(mirror, "cat-file", "-t", first)).toBe("commit");
    const copy = (await w.prepare({}, { baseCommit: first }))!;
    expect(copy.baseCommits).toEqual({ app: first });
    expect(readFileSync(join(copy.root, "app", "src/a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });


  it("shows a diff of new, changed, deleted and binary files, leaves ignored files out, and hands the state on whole", async () => {
    const w = world();
    const copy = (await w.prepare())!;
    const dir = join(copy.root, "app");
    writeFiles(dir, { "src/a.txt": "one\nTWO\nthree\n", "src/new/b.txt": "brand new\n", "logo.bin": BINARY, "debug.log": "ignored\n", "node_modules/x/index.js": "ignored\n" });
    rmSync(join(dir, "src/old.txt"));
    const diff = await copy.diff();
    const text = Buffer.from(diff).toString("latin1");
    // Plain `git diff` output, every path under the project's folder.
    for (const path of ["src/a.txt", "src/new/b.txt", "src/old.txt", "logo.bin"]) expect(text).toContain(`diff --git a/app/${path} b/app/${path}\n`);
    expect(text).not.toContain("debug.log");
    expect(text).not.toContain("node_modules");
    // The agent's own repository is untouched by taking the diff: nothing was staged in it.
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");

    // The state is the whole tree, on the base commit; the next attempt starts from it and holds the same changes.
    const state = { attemptId: w.attempt(), commits: await copy.push() };
    expect(git(w.origin.clone, "ls-tree", "-r", "--name-only", w.origin.head())).not.toContain("logo.bin");
    const next = (await w.prepare({ inherited: [state] }))!;
    const again = join(next.root, "app");
    expect(readFileSync(join(again, "src/a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(readFileSync(join(again, "src/new/b.txt"), "utf8")).toBe("brand new\n");
    expect(new Uint8Array(readFileSync(join(again, "logo.bin")))).toEqual(BINARY);
    expect(existsSync(join(again, "src/old.txt"))).toBe(false);
    expect(existsSync(join(again, "debug.log"))).toBe(false);
    expect(git(again, "rev-parse", "HEAD")).toBe(state.commits["app"]);
    expect(Buffer.from(await next.diff())).toEqual(Buffer.from(diff));
    // Pushing again with nothing more changed makes no new commit.
    expect(await copy.push()).toEqual(state.commits);
  });

  /** One task's work: a working copy on what it inherits, some files written or removed, the diff it shows and the state it pushes. */
  const work = async (w: ReturnType<typeof world>, files: Record<string, string>, inherited: State[] = [], remove: string[] = []): Promise<{ diff: Uint8Array; state: State }> => {
    const copy = (await w.prepare({ inherited }))!;
    writeFiles(join(copy.root, "app"), files);
    for (const path of remove) rmSync(join(copy.root, "app", path));
    const diff = await copy.diff();
    return { diff, state: { attemptId: w.attempt(), commits: await copy.push() } };
  };
  const paths = (patch: Uint8Array): string[] => [...Buffer.from(patch).toString("latin1").matchAll(/^diff --git a\/app\/(\S+) /gmu)].map((match) => match[1]!);

  it("starts from the state it inherits, whose changes the diff shows against the base commit, and a later attempt of the task starts from its own", async () => {
    const w = world();
    const x = (await work(w, { "src/a.txt": "ONE\ntwo\nthree\n", "docs/x.md": "x\n" }, [], ["src/old.txt"])).state;
    const copy = (await w.prepare({ inherited: [x] }))!;
    const dir = join(copy.root, "app");
    // The inherited changes are the state commit, on the project's commit; the base commit reported is still the project's.
    expect(copy.baseCommits).toEqual({ app: w.origin.head() });
    expect(git(dir, "rev-parse", "HEAD")).toBe(x.commits["app"]);
    expect(git(dir, "rev-parse", "HEAD~1")).toBe(w.origin.head());
    expect(git(dir, "log", "-1", "--format=%an <%ae> %s")).toBe(`Brain <brain@localhost> Brain: the state of attempt ${x.attemptId}`);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(paths(await copy.diff()).sort()).toEqual(["docs/x.md", "src/a.txt", "src/old.txt"]);
    writeFiles(dir, { "docs/a.md": "a\n", "src/a.txt": "ONE\ntwo\nTHREE\n" });
    const a = await copy.diff();
    expect(paths(a).sort()).toEqual(["docs/a.md", "docs/x.md", "src/a.txt", "src/old.txt"]);
    expect(Buffer.from(a).toString("latin1")).toContain("-three\n+THREE\n");
    const own = { attemptId: w.attempt(), commits: await copy.push() };
    // A later attempt of the same task starts from what the first left, which holds what the tasks before it left, and shows the same diff.
    const again = (await w.prepare({ inherited: [x, own] }))!;
    expect(git(join(again.root, "app"), "rev-parse", "HEAD")).toBe(own.commits["app"]);
    expect(git(join(again.root, "app"), "status", "--porcelain")).toBe("");
    expect(Buffer.from(await again.diff())).toEqual(Buffer.from(a));
  });

  it("merges every ancestor's state once in a diamond: A and B wait for X, C waits for A and B", async () => {
    const w = world();
    const x = await work(w, { "src/a.txt": "one\ntwo\nthree\nfour (x)\n", "docs/x.md": "x\n" }, [], ["src/old.txt"]);
    // A and B each change another end of the file X changed, and add a file of their own.
    const a = await work(w, { "src/a.txt": "ONE (a)\ntwo\nthree\nfour (x)\n", "docs/a.md": "a\n" }, [x.state]);
    const b = await work(w, { "src/a.txt": "one\ntwo\nthree\nfour (x)\nfive (b)\n", "docs/b.md": "b\n" }, [x.state], ["docs/x.md"]);
    expect(paths(a.diff).sort()).toEqual(["docs/a.md", "docs/x.md", "src/a.txt", "src/old.txt"]);
    expect(paths(b.diff).sort()).toEqual(["docs/b.md", "src/a.txt", "src/old.txt"]);
    const copy = (await w.prepare({ inherited: [x.state, a.state, b.state] }))!;
    const dir = join(copy.root, "app");
    expect(readFileSync(join(dir, "src/a.txt"), "utf8")).toBe("ONE (a)\ntwo\nthree\nfour (x)\nfive (b)\n");
    expect(["docs/a.md", "docs/b.md", "docs/x.md", "src/old.txt"].map((path) => existsSync(join(dir, path)))).toEqual([true, true, false, false]);
    writeFiles(dir, { "docs/c.md": "c\n" });
    expect(paths(await copy.diff()).sort()).toEqual(["docs/a.md", "docs/b.md", "docs/c.md", "src/a.txt", "src/old.txt"]);
    // C's state holds the same files as its working copy, on the project's commit: it is what a pull request is made of.
    const c = await copy.push();
    for (const path of ["src/a.txt", "docs/a.md", "docs/b.md", "docs/c.md"]) expect(git(join(store.root, "repos", w.workspaceId, "app.git"), "show", `${c["app"]}:${path}`)).toBe(readFileSync(join(dir, path), "utf8").trimEnd());
    expect(git(join(store.root, "repos", w.workspaceId, "app.git"), "ls-tree", "-r", "--name-only", c["app"]!)).not.toContain("docs/x.md");
  });

  it("fails with the conflicting paths when two inherited states change the same lines", async () => {
    const w = world();
    const first = await work(w, { "src/a.txt": "one\nfirst\nthree\n" });
    const second = await work(w, { "src/a.txt": "one\nsecond\nthree\n" });
    const failure = await w.prepare({ inherited: [first.state, second.state] }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(SetupError);
    expect((failure as SetupError).infrastructure).toBe(false);
    expect((failure as SetupError).message).toBe("the changes of the tasks this one waits for do not merge in project app: conflict in src/a.txt");
  });

  it("pushes nothing for a project that did not change, and fails as an infrastructure problem for a state the store does not have", async () => {
    const w = world();
    const idle = (await w.prepare())!;
    expect(await idle.push()).toEqual({});
    await work(w, { "src/a.txt": "one\ntwo\nTHREE\n" });
    const absent = await w.prepare({ inherited: [{ attemptId: "never-pushed", commits: { app: w.origin.head() } }] }).then(() => undefined, (error: unknown) => error);
    expect((absent as SetupError).infrastructure).toBe(true);
    expect((absent as SetupError).message).toContain("could not be fetched for project app from the git store");
  });

  it("fails, saying why, when the offer has no git store", async () => {
    const w = world();
    const stateDir = tempDir("state");
    const failure = await prepareWorkingCopy({ stateDir, workspaceId: "ws1", attemptDir: join(stateDir, "attempts", "a1"), attemptId: "a1", store: undefined, projects: [w.project], inherited: [], credential: async () => "" }).then(() => undefined, (error: unknown) => error);
    expect((failure as SetupError).message).toContain("no git store");
  });

  it("fails as an infrastructure problem when the repository cannot be fetched", async () => {
    const w = world();
    const failure = await w.prepare({}, { repo: join(w.stateDir, "no-such-repository.git") }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(SetupError);
    expect((failure as SetupError).infrastructure).toBe(true);
    expect((failure as SetupError).message).toContain("project app could not be fetched");
  });

  it("has no working copy when the offer has no projects", async () => {
    const stateDir = tempDir("state");
    expect(await prepareWorkingCopy({ stateDir, workspaceId: "ws1", attemptDir: join(stateDir, "attempts", "a1"), attemptId: "a1", store: undefined, projects: [], inherited: [], credential: async () => "" })).toBeUndefined();
  });

  it("gives a fetch its credential as a header for the repository's own origin, in the environment only", () => {
    const env = credentialEnv("https://github.com/acme/app.git", "ghp_secret");
    expect(env).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}` });
    expect(credentialEnv("/srv/git/app.git", "ghp_secret")).toEqual({});
    expect(credentialEnv("https://github.com/acme/app.git", undefined)).toEqual({});
  });

  it("is one diff for several projects, each with a state of its own", async () => {
    const web = bareRepository({ "index.html": "<p>old</p>\n" });
    const w = world();
    const stateDir = tempDir("state");
    const projects: OfferProject[] = [w.project, { name: "web", repo: web.repo, branch: "main", access: "write", network: [] }];
    const prepare = (attempt: string, inherited: State[] = []) => prepareWorkingCopy({ stateDir, workspaceId: "ws1", attemptDir: join(stateDir, "attempts", attempt), attemptId: attempt, store: store.offer("ws1", "g1", attempt), projects, inherited: inherited.map((state) => ({ label: "an earlier attempt", ...state })), credential: async () => "" });
    const copy = (await prepare(`m${++attempts}`))!;
    writeFiles(copy.root, { "app/src/a.txt": "changed in app\n", "web/index.html": "<p>new</p>\n", "web/diff --git.txt": "a file with a tricky name\n" });
    const diff = Buffer.from(await copy.diff()).toString("utf8");
    expect(copy.baseCommits).toEqual({ app: w.origin.head(), web: web.head() });
    expect(diff).toContain("diff --git a/app/src/a.txt b/app/src/a.txt\n");
    expect(diff).toContain("diff --git a/web/index.html b/web/index.html\n");
    const pushed = await copy.push();
    expect(Object.keys(pushed).sort()).toEqual(["app", "web"]);
    const next = (await prepare(`m${++attempts}`, [{ attemptId: "m1", commits: pushed }]))!;
    expect(readFileSync(join(next.root, "app/src/a.txt"), "utf8")).toBe("changed in app\n");
    expect(readFileSync(join(next.root, "web/index.html"), "utf8")).toBe("<p>new</p>\n");
    expect(readFileSync(join(next.root, "web/diff --git.txt"), "utf8")).toBe("a file with a tricky name\n");
  });

  it("collects the plain files of the output folder and leaves links out", async () => {
    const out = tempDir("out");
    writeFiles(out, { "report.md": "# Report\n", "data/rows.csv": "a,b\n" });
    const { symlinkSync } = await import("node:fs");
    symlinkSync("/etc/hostname", join(out, "link.txt"));
    const collected = collectOutputs(out);
    expect(collected.files.map((file) => [file.name, file.mediaType])).toEqual([["data/rows.csv", "text/csv"], ["report.md", "text/markdown"]]);
    expect(collected.skipped).toEqual(["link.txt"]);
  });
});
