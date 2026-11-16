import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch, PatchConflict, projectPatch, type PatchedFile } from "../../apps/governor/src/integrations/patch";

type Files = Record<string, string | Uint8Array>;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** git with none of the host's configuration. */
const git = (dir: string, ...args: string[]): Buffer => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, maxBuffer: 64 * 1024 * 1024 });
function write(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
/** A repository with the files committed. */
function repo(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-patch-"));
  dirs.push(dir);
  git(dir, "init", "--quiet");
  write(dir, files);
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "base");
  return dir;
}
/** Every file of the working copy, as hex. */
function snapshot(dir: string): Record<string, string> {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !relative(dir, entry.parentPath).startsWith(".git"));
  return Object.fromEntries(entries.map((entry) => [relative(dir, join(entry.parentPath, entry.name)), readFileSync(join(entry.parentPath, entry.name)).toString("hex")]));
}
/** The changes of the working copy against its last commit. */
function diff(dir: string, ...flags: string[]): Buffer {
  git(dir, "add", "--all");
  return git(dir, "diff", "--cached", "--binary", "-M", ...flags, "HEAD");
}
/** The files after the patch is applied to them. */
function apply(files: Record<string, string>, patch: Uint8Array): { files: Record<string, string>; changed: PatchedFile[] } {
  const changed = applyPatch(patch, (path) => (Object.hasOwn(files, path) ? Buffer.from(files[path] as string, "hex") : undefined));
  const next = { ...files };
  for (const file of changed) {
    if (file.content) next[file.path] = Buffer.from(file.content).toString("hex");
    else delete next[file.path];
  }
  return { files: next, changed };
}
/** Makes the change in a repository of the files, and checks that its patch turns the files before into the files after, byte for byte. */
function check(before: Files, change: (dir: string) => void): { patch: string; changed: PatchedFile[] } {
  const dir = repo(before);
  const was = snapshot(dir);
  change(dir);
  const patch = diff(dir);
  const { files, changed } = apply(was, patch);
  expect(files).toEqual(snapshot(dir));
  return { patch: patch.toString("latin1"), changed };
}

const hex = (text: string): string => Buffer.from(text).toString("hex");
const text = (lines: number): string => Array.from({ length: lines }, (_, index) => `line ${index + 1}\n`).join("");
/** Bytes that do not compress, the same on every run. */
function noise(length: number, seed: number): Uint8Array {
  let state = seed;
  return Uint8Array.from({ length }, () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff);
}

describe("applyPatch", () => {
  it("changes several places of a text file, also one with a space in its name", () => {
    const { patch, changed } = check({ "src/app.ts": text(60), "notes/to do.txt": text(5) }, (dir) => write(dir, {
      "src/app.ts": text(60).replace("line 3\n", "LINE 3\n").replace("line 30\n", "").replace("line 55\n", "line 55\nadded\nadded too\n"),
      "notes/to do.txt": `first\n${text(5)}`,
    }));
    expect(patch.match(/^@@ /gmu)).toHaveLength(4);
    expect(changed.map((file) => [file.path, file.mode])).toEqual([["notes/to do.txt", "100644"], ["src/app.ts", "100644"]]);
  });

  it("adds files, an empty one and one with an accent in its name, and deletes files", () => {
    const { patch, changed } = check({ "gone.txt": "one\ntwo\n", "stays.txt": "same\n" }, (dir) => {
      write(dir, { "docs/new.md": "# New\n\ntext\n", "empty.txt": "", "docs/spécial.txt": "é\n" });
      rmSync(join(dir, "gone.txt"));
    });
    expect(patch).toContain("\"a/docs/sp\\303\\251cial.txt\"");
    expect(changed.filter((file) => file.content === undefined).map((file) => file.path)).toEqual(["gone.txt"]);
    expect(changed.find((file) => file.path === "empty.txt")).toEqual({ path: "empty.txt", content: new Uint8Array(), mode: "100644" });
  });

  it("renames a file and changes it, and renames another as it is", () => {
    const { patch, changed } = check({ "old.txt": text(30), "kept as is.txt": text(4) }, (dir) => {
      write(dir, { "lib/new.txt": text(30).replace("line 12\n", "twelve\n"), "moved as is.txt": text(4) });
      for (const path of ["old.txt", "kept as is.txt"]) rmSync(join(dir, path));
    });
    expect(patch).toContain("rename from old.txt\nrename to lib/new.txt\n");
    expect(changed.map((file) => [file.path, file.content === undefined])).toEqual([["old.txt", true], ["lib/new.txt", false], ["kept as is.txt", true], ["moved as is.txt", false]]);
  });

  it("keeps, adds and removes the line end of the last line, and keeps CRLF line ends", () => {
    const { patch } = check({ "none.txt": "a\nb\nc", "gains.txt": "a\nb", "loses.txt": "a\nb\n", "crlf.txt": "a\r\nb\r\nc\r\n", "bare.txt": "a" }, (dir) => write(dir, {
      "none.txt": "A\nb\nC", "gains.txt": "a\nb\n", "loses.txt": "a\nB", "crlf.txt": "a\r\nB\r\nc\r\nd\r\n", "bare.txt": "a\nb",
    }));
    expect(patch).toContain("\\ No newline at end of file");
  });

  it("makes a file executable without changing its content", () => {
    const { changed } = check({ "run.sh": "#!/bin/sh\necho hi\n" }, (dir) => chmodSync(join(dir, "run.sh"), 0o755));
    expect(changed).toEqual([{ path: "run.sh", content: new Uint8Array(Buffer.from("#!/bin/sh\necho hi\n")), mode: "100755" }]);
  });

  it("adds a binary file, and changes a few bytes of a large one", () => {
    const large = noise(300_000, 7);
    const { patch } = check({ "data.bin": large, "old.bin": noise(900, 3) }, (dir) => {
      const edited = Uint8Array.from(large);
      edited.set([0, 1, 2, 3], 150_000);
      write(dir, { "data.bin": Buffer.concat([edited, noise(40, 5)]), "logo.bin": noise(5000, 11) });
      rmSync(join(dir, "old.bin"));
    });
    expect(patch).toMatch(/GIT binary patch\ndelta \d+\n/u);
    expect(patch).toMatch(/new file mode 100644\nindex [0-9a-f.]+\nGIT binary patch\nliteral 5000\n/u);
  });

  it("applies two patches one after the other to the same file, and reports the file once", () => {
    const dir = repo({ "app.txt": text(20), "other.txt": "one\n" });
    const was = snapshot(dir);
    write(dir, { "app.txt": text(20).replace("line 4\n", "four\n"), "made.txt": "first\n" });
    const first = diff(dir);
    git(dir, "commit", "--quiet", "-m", "first");
    write(dir, { "app.txt": text(20).replace("line 4\n", "four\nfive\n").replace("line 18\n", ""), "made.txt": "second\n" });
    const { files, changed } = apply(was, Buffer.concat([first, Buffer.from("\n"), diff(dir)]));
    expect(files).toEqual(snapshot(dir));
    expect(changed.map((file) => file.path)).toEqual(["app.txt", "made.txt"]);
  });

  it("names every file the patch does not fit: changed since, missing, or already there with other content", () => {
    const dir = repo({ "a.txt": "one\ntwo\n", "b.txt": "one\ntwo\n", "c.txt": "one\n", "d.bin": noise(70_000, 2) });
    write(dir, { "a.txt": "one\n2\n", "b.txt": "1\ntwo\n", "c.txt": "one\nmore\n", "new.txt": "new\n", "d.bin": Buffer.concat([noise(70_000, 2), noise(9, 4)]) });
    const base = { "a.txt": hex("one\nTWO\n"), "c.txt": hex("one\n"), "new.txt": hex("other\n"), "d.bin": hex("short") };
    expect(() => apply(base, diff(dir))).toThrow(PatchConflict);
    expect(() => apply(base, diff(dir))).toThrow(expect.objectContaining({ paths: ["a.txt", "b.txt", "d.bin", "new.txt"] }));
  });
});

describe("projectPatch", () => {
  it("keeps one project of a working-copy patch and takes the project folder off its paths", () => {
    const shop = repo({ "src/app.ts": text(20), "old name.txt": "first\n", "sp é.txt": "second\n", "logo.bin": noise(500, 9) });
    const was = snapshot(shop);
    write(shop, { "src/app.ts": text(20).replace("line 7\n", "seven\n"), "src/new.ts": "export {};\n", "new name.txt": "first\n", "docs/sp é.txt": "second\n" });
    for (const path of ["old name.txt", "sp é.txt", "logo.bin"]) rmSync(join(shop, path));
    const other = repo({ "src/app.ts": "one\n" });
    write(other, { "src/app.ts": "two\n" });
    const whole = Buffer.concat([diff(other, "--src-prefix=a/other/", "--dst-prefix=b/other/"), diff(shop, "--src-prefix=a/shop/", "--dst-prefix=b/shop/")]);
    const part = projectPatch(whole, "shop");
    expect(Buffer.from(part).toString("latin1")).toBe(diff(shop).toString("latin1"));
    expect(Buffer.from(part).toString("latin1")).toContain("rename from \"sp \\303\\251.txt\"\nrename to \"docs/sp \\303\\251.txt\"\n");
    expect(apply(was, part).files).toEqual(snapshot(shop));
    expect(projectPatch(whole, "none")).toHaveLength(0);
  });
});
