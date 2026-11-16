import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OfferProject } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { buildPatch, collectOutputs, credentialEnv, parsePatch, prepareWorkingCopy, SetupError, type WorkingCopy } from "../../apps/runner/src/working-copy";
import { bareRepository, git, tempDir, writeFiles } from "./git-repo";

const BINARY = new Uint8Array([0, 1, 2, 255, 254, 0, 10, 13]);
const FILES = { "README.md": "# App\n", "src/a.txt": "one\ntwo\nthree\n", "src/old.txt": "to be deleted\n", ".gitignore": "node_modules/\n*.log\n" };

function world() {
  const origin = bareRepository(FILES);
  const stateDir = tempDir("state");
  const project: OfferProject = { name: "app", repo: origin.repo, branch: "main", access: "write", network: [] };
  let attempts = 0;
  /** `inherited` are the patches of the tasks this one waits for, in order; `own` is the task's earlier patch. */
  const prepare = (patches: { inherited?: Uint8Array[]; own?: Uint8Array } = {}, overrides: Partial<OfferProject> = {}): Promise<WorkingCopy | undefined> =>
    prepareWorkingCopy({
      stateDir, workspaceId: "ws1", attemptDir: join(stateDir, "attempts", `a${++attempts}`), projects: [{ ...project, ...overrides }], credential: async () => "unused",
      inherited: (patches.inherited ?? []).map((bytes, index, all) => ({ label: `the changes of prerequisite ${index + 1} of ${all.length}`, bytes })), ...(patches.own ? { own: patches.own } : {}),
    });
  return { origin, stateDir, project, prepare };
}

describe("working copy", () => {
  it("mirrors the repository and checks the branch head out, reporting the commit", async () => {
    const w = world();
    const copy = (await w.prepare())!;
    expect(existsSync(join(w.stateDir, "repos", "ws1", "app.git", "HEAD"))).toBe(true);
    expect(copy.baseCommits).toEqual({ app: w.origin.head() });
    expect(readFileSync(join(copy.root, "app", "src/a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    // The working copy is a repository of its own, with no address of the runner's mirror in it.
    expect(git(join(copy.root, "app"), "status", "--porcelain")).toBe("");
    expect(git(join(copy.root, "app"), "remote")).toBe("");
    expect(parsePatch(await copy.patch())).toEqual([]);
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

  it("uploads a diff that holds new, changed, deleted and binary files, leaves ignored files out, and applies again", async () => {
    const w = world();
    const copy = (await w.prepare())!;
    const dir = join(copy.root, "app");
    writeFiles(dir, { "src/a.txt": "one\nTWO\nthree\n", "src/new/b.txt": "brand new\n", "logo.bin": BINARY, "debug.log": "ignored\n", "node_modules/x/index.js": "ignored\n" });
    rmSync(join(dir, "src/old.txt"));
    const patch = await copy.patch();
    const [section] = parsePatch(patch);
    expect(section!.project).toBe("app");
    const text = Buffer.from(section!.diff).toString("latin1");
    // Plain `git diff` output, every path under the project's folder.
    expect(Buffer.from(patch).toString("latin1")).toBe(text);
    for (const path of ["src/a.txt", "src/new/b.txt", "src/old.txt", "logo.bin"]) expect(text).toContain(`diff --git a/app/${path} b/app/${path}\n`);
    expect(text).not.toContain("debug.log");
    expect(text).not.toContain("node_modules");
    // The agent's own repository is untouched by taking the patch: nothing was staged in it.
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");

    // Round trip: the next attempt starts from the same changes, as uncommitted changes against the base commit.
    const next = (await w.prepare({ own: patch }))!;
    const again = join(next.root, "app");
    expect(readFileSync(join(again, "src/a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(readFileSync(join(again, "src/new/b.txt"), "utf8")).toBe("brand new\n");
    expect(new Uint8Array(readFileSync(join(again, "logo.bin")))).toEqual(BINARY);
    expect(existsSync(join(again, "src/old.txt"))).toBe(false);
    expect(git(again, "rev-parse", "HEAD")).toBe(w.origin.head());
    expect(Buffer.from(await next.patch())).toEqual(Buffer.from(patch));
    // And a project's part applies by itself in a plain checkout of the project at its base commit.
    const plain = tempDir("plain");
    git(plain, "clone", "--quiet", w.origin.repo, "app");
    writeFileSync(join(plain, "section.patch"), section!.diff);
    git(join(plain, "app"), "apply", "--binary", "-p2", join(plain, "section.patch"));
    expect(readFileSync(join(plain, "app", "src/new/b.txt"), "utf8")).toBe("brand new\n");
    expect(existsSync(join(plain, "app", "src/old.txt"))).toBe(false);
  });

  /** One task's work: a working copy on what it inherits, some files written or removed, and the patch it leaves. */
  const work = async (w: ReturnType<typeof world>, files: Record<string, string>, inherited: Uint8Array[] = [], remove: string[] = []): Promise<Uint8Array> => {
    const copy = (await w.prepare({ inherited }))!;
    writeFiles(join(copy.root, "app"), files);
    for (const path of remove) rmSync(join(copy.root, "app", path));
    return copy.patch();
  };
  const paths = (patch: Uint8Array): string[] => [...Buffer.from(patch).toString("latin1").matchAll(/^diff --git a\/app\/(\S+) /gmu)].map((match) => match[1]!);

  it("leaves a patch of the task's own changes only: what it inherited is its baseline", async () => {
    const w = world();
    const x = await work(w, { "src/a.txt": "ONE\ntwo\nthree\n", "docs/x.md": "x\n" }, [], ["src/old.txt"]);
    const copy = (await w.prepare({ inherited: [x] }))!;
    const dir = join(copy.root, "app");
    // The inherited changes are a local commit on the project's commit; the base commit reported is still the project's.
    expect(copy.baseCommits).toEqual({ app: w.origin.head() });
    expect(git(dir, "rev-parse", "HEAD~1")).toBe(w.origin.head());
    expect(git(dir, "log", "-1", "--format=%an <%ae> %s")).toBe("Brain <brain@localhost> Changes of the tasks this one waits for");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(await copy.patch()).toEqual(new Uint8Array());
    writeFiles(dir, { "docs/a.md": "a\n", "src/a.txt": "ONE\ntwo\nTHREE\n" });
    const a = await copy.patch();
    expect(paths(a).sort()).toEqual(["docs/a.md", "src/a.txt"]);
    expect(Buffer.from(a).toString("latin1")).toContain("-three\n+THREE\n");
    expect(Buffer.from(a).toString("latin1")).not.toContain("+ONE");
    // A later attempt of the same task: baseline again, its own patch on top as uncommitted changes, and the same patch at the end.
    const again = (await w.prepare({ inherited: [x], own: a }))!;
    expect(git(join(again.root, "app"), "status", "--porcelain").split("\n").map((line) => line.trim()).sort()).toEqual(["?? docs/a.md", "M src/a.txt"]);
    expect(Buffer.from(await again.patch())).toEqual(Buffer.from(a));
  });

  it("applies every ancestor's patch once in a diamond: A and B wait for X, C waits for A and B", async () => {
    const w = world();
    const x = await work(w, { "src/a.txt": "one\ntwo\nthree\nfour (x)\n", "docs/x.md": "x\n" }, [], ["src/old.txt"]);
    // A and B each change another end of the file X changed, and add a file of their own.
    const a = await work(w, { "src/a.txt": "ONE (a)\ntwo\nthree\nfour (x)\n", "docs/a.md": "a\n" }, [x]);
    const b = await work(w, { "src/a.txt": "one\ntwo\nthree\nfour (x)\nfive (b)\n", "docs/b.md": "b\n" }, [x], ["docs/x.md"]);
    expect(paths(a).sort()).toEqual(["docs/a.md", "src/a.txt"]);
    expect(paths(b).sort()).toEqual(["docs/b.md", "docs/x.md", "src/a.txt"]);
    const copy = (await w.prepare({ inherited: [x, a, b] }))!;
    const dir = join(copy.root, "app");
    expect(readFileSync(join(dir, "src/a.txt"), "utf8")).toBe("ONE (a)\ntwo\nthree\nfour (x)\nfive (b)\n");
    expect(["docs/a.md", "docs/b.md", "docs/x.md", "src/old.txt"].map((path) => existsSync(join(dir, path)))).toEqual([true, true, false, false]);
    writeFiles(dir, { "docs/c.md": "c\n" });
    const c = await copy.patch();
    expect(paths(c)).toEqual(["docs/c.md"]);
    // The pull request is every patch once, in order, on the project's commit: the same files as C's working copy.
    const plain = tempDir("plain");
    git(plain, "clone", "--quiet", w.origin.repo, "app");
    for (const [index, patch] of [x, a, b, c].entries()) { writeFileSync(join(plain, `${index}.patch`), patch); git(plain, "-C", "app", "apply", "--3way", "-p2", join(plain, `${index}.patch`)); }
    for (const path of ["src/a.txt", "docs/a.md", "docs/b.md", "docs/c.md"]) expect(readFileSync(join(plain, "app", path), "utf8")).toBe(readFileSync(join(dir, path), "utf8"));
    expect(existsSync(join(plain, "app", "docs/x.md"))).toBe(false);
  });

  it("fails with the conflicting paths when two inherited patches change the same lines", async () => {
    const w = world();
    const first = await work(w, { "src/a.txt": "one\nfirst\nthree\n" });
    const second = await work(w, { "src/a.txt": "one\nsecond\nthree\n" });
    const failure = await w.prepare({ inherited: [first, second] }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(SetupError);
    expect((failure as SetupError).infrastructure).toBe(false);
    expect((failure as SetupError).message).toBe("the changes of prerequisite 2 of 2 do not apply to project app: conflict in src/a.txt");
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
    expect(await prepareWorkingCopy({ stateDir, workspaceId: "ws1", attemptDir: join(stateDir, "attempts", "a1"), projects: [], inherited: [], credential: async () => "" })).toBeUndefined();
  });

  it("gives a fetch its credential as a header for the repository's own origin, in the environment only", () => {
    const env = credentialEnv("https://github.com/acme/app.git", "ghp_secret");
    expect(env).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}` });
    expect(credentialEnv("/srv/git/app.git", "ghp_secret")).toEqual({});
    expect(credentialEnv("https://github.com/acme/app.git", undefined)).toEqual({});
  });

  it("is one patch for several projects, split again by the project folder each path starts with", async () => {
    const web = bareRepository({ "index.html": "<p>old</p>\n" });
    const w = world();
    const stateDir = tempDir("state");
    const projects: OfferProject[] = [w.project, { name: "web", repo: web.repo, branch: "main", access: "write", network: [] }];
    const prepare = (attempt: string, own?: Uint8Array) => prepareWorkingCopy({ stateDir, workspaceId: "ws1", attemptDir: join(stateDir, "attempts", attempt), projects, inherited: [], ...(own ? { own } : {}), credential: async () => "" });
    const copy = (await prepare("a1"))!;
    writeFiles(copy.root, { "app/src/a.txt": "changed in app\n", "web/index.html": "<p>new</p>\n", "web/diff --git.txt": "a file with a tricky name\n" });
    const patch = await copy.patch();
    expect(copy.baseCommits).toEqual({ app: w.origin.head(), web: web.head() });
    expect(parsePatch(patch).map((section) => section.project)).toEqual(["app", "web"]);
    expect(Buffer.from(buildPatch(parsePatch(patch)))).toEqual(Buffer.from(patch));
    const next = (await prepare("a2", patch))!;
    expect(readFileSync(join(next.root, "app/src/a.txt"), "utf8")).toBe("changed in app\n");
    expect(readFileSync(join(next.root, "web/index.html"), "utf8")).toBe("<p>new</p>\n");
    expect(readFileSync(join(next.root, "web/diff --git.txt"), "utf8")).toBe("a file with a tricky name\n");
    expect(parsePatch(new Uint8Array())).toEqual([]);
    expect(() => parsePatch(new Uint8Array(Buffer.from("not a diff\n")))).toThrow("not `git diff` output");
    expect(() => parsePatch(new Uint8Array(Buffer.from("diff --git a/x.txt b/x.txt\n")))).toThrow("outside every project's folder");
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
