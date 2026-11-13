import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OUTPUT_LIMITS, RunOutputDir, refuseName } from "../../apps/runner/src/tools/run-output";

// The per-run output folder (backlog 88): the only place an agent's files.write lands, collected as artifacts when the attempt ends well.
// Everything a name or a file can try, a link, a path out of the folder, a huge file, a flood of files, must leave the host untouched.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function folder(): { state: string; out: RunOutputDir; outside: string } {
  const state = mkdtempSync(join(tmpdir(), "brain-run-output-"));
  roots.push(state);
  const outside = join(state, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), "do not touch");
  return { state, out: new RunOutputDir(join(state, "runner"), "att-1"), outside };
}
const names = (out: RunOutputDir) => out.collect().map((file) => file.name);

describe("names that may be written", () => {
  it("accepts plain relative names with a result extension, and refuses everything that could leave the folder or hide", () => {
    for (const ok of ["report.md", "tables/q3.csv", "a/b/c.json", "notes_1-2.txt"]) expect(refuseName(ok), ok).toBeUndefined();
    for (const bad of ["../escape.md", "a/../../escape.md", "/etc/cron.d/x.txt", "a/./b.md", ".hidden.md", "dir/.env.txt", "a//b.md", "back\\slash.md", "a/b/c/d.md", "tool.exe", "noextension", "x.sh", "trailing/", "", "spa ce.md", "n\u0000ul.md", `${"x".repeat(70)}.md`]) expect(refuseName(bad), JSON.stringify(bad)).toBeTruthy();
    expect(refuseName(42)).toBeTruthy();
    expect(refuseName(undefined)).toBeTruthy();
  });
});

describe("writing", () => {
  it("writes inside the attempt's folder only, and a refused write leaves nothing behind", () => {
    const { state, out, outside } = folder();
    expect(out.write({ name: "report.md", content: "# Report\nall good" })).toMatchObject({ ok: true, data: { name: "report.md", bytes: 17, files: 1, replaced: false } });
    expect(out.write({ name: "tables/q3.csv", content: "a,b\n1,2\n" })).toMatchObject({ ok: true });
    expect(out.write({ name: "report.md", content: "v2" })).toMatchObject({ ok: true, data: { replaced: true, files: 2 } });
    for (const name of ["../outside/secret.md", "../../etc/passwd.txt", "/tmp/abs.md", "a/../../outside/secret.md"]) expect(out.write({ name, content: "pwned" }).ok, name).toBe(false);
    expect(out.write({ name: "x.md", content: 12 as never }).ok).toBe(false);
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("do not touch");
    expect(names(out)).toEqual(["report.md", "tables/q3.csv"]);
    expect(existsSync(join(state, "runner", "run-output", "att-1", "report.md"))).toBe(true);
  });

  it("never writes through a link: a symlinked file, a symlinked folder, or a symlinked output root", () => {
    const { state, out, outside } = folder();
    out.write({ name: "seed.md", content: "x" });
    // A link planted where a file will be written (by something with access to the folder) must not be followed.
    symlinkSync(join(outside, "secret.md"), join(out.dir, "link.md"));
    const throughFile = out.write({ name: "link.md", content: "pwned" });
    expect(throughFile.ok).toBe(false);
    symlinkSync(outside, join(out.dir, "linked"));
    const throughFolder = out.write({ name: "linked/new.md", content: "pwned" });
    expect(throughFolder.ok).toBe(false);
    expect(existsSync(join(outside, "new.md"))).toBe(false);
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("do not touch");
    // The whole root replaced by a link to somewhere else is refused as well.
    rmSync(out.dir, { recursive: true, force: true });
    symlinkSync(outside, out.dir);
    expect(lstatSync(out.dir).isSymbolicLink()).toBe(true);
    expect(out.write({ name: "again.md", content: "pwned" }).ok).toBe(false);
    expect(existsSync(join(outside, "again.md"))).toBe(false);
    void state;
  });

  it("enforces the size of a file, the number of files and the total", () => {
    const { out } = folder();
    expect(out.write({ name: "big.txt", content: "x".repeat(OUTPUT_LIMITS.fileBytes + 1) })).toMatchObject({ ok: false });
    expect(out.write({ name: "edge.txt", content: "x".repeat(OUTPUT_LIMITS.fileBytes) })).toMatchObject({ ok: true });
    for (let index = 0; index < OUTPUT_LIMITS.files - 1; index++) expect(out.write({ name: `f${index}.txt`, content: "x" }).ok).toBe(true);
    const flood = out.write({ name: "one-too-many.txt", content: "x" });
    expect(flood).toMatchObject({ ok: false });
    expect(JSON.stringify(flood)).toContain(String(OUTPUT_LIMITS.files));
    // Replacing an existing file is not a new file.
    expect(out.write({ name: "f0.txt", content: "y" }).ok).toBe(true);
    const total = folder();
    for (let index = 0; index < 5; index++) expect(total.out.write({ name: `t${index}.txt`, content: "x".repeat(OUTPUT_LIMITS.fileBytes) }).ok).toBe(true);
    expect(total.out.write({ name: "t5.txt", content: "x" })).toMatchObject({ ok: false });
  });
});

describe("collecting", () => {
  it("returns only regular files with the right media type, skips links and anything planted, and the folder is removed afterwards", () => {
    const { out, outside } = folder();
    out.write({ name: "report.md", content: "# R" });
    out.write({ name: "data/rows.csv", content: "a\n1\n" });
    out.write({ name: "obj.json", content: "{}" });
    // Planted by someone else: a link to a secret, a link to a folder, a file with a name no result may have, a dot-file, a too-deep file.
    symlinkSync(join(outside, "secret.md"), join(out.dir, "stolen.md"));
    symlinkSync(outside, join(out.dir, "data", "escape"));
    writeFileSync(join(out.dir, "run.sh"), "#!/bin/sh");
    writeFileSync(join(out.dir, ".env.txt"), "token");
    mkdirSync(join(out.dir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(out.dir, "a", "b", "c", "deep.md"), "too deep");
    writeFileSync(join(out.dir, "huge.txt"), "x".repeat(OUTPUT_LIMITS.fileBytes + 1));
    const collected = out.collect();
    expect(collected.map((file) => [file.name, file.mediaType])).toEqual([["data/rows.csv", "text/csv"], ["obj.json", "application/json"], ["report.md", "text/markdown"]]);
    expect(new TextDecoder().decode(collected.find((file) => file.name === "report.md")!.bytes)).toBe("# R");
    expect(JSON.stringify(collected)).not.toContain("do not touch");
    out.dispose();
    expect(existsSync(out.dir)).toBe(false);
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("do not touch");
    out.dispose(); // twice is fine, and so is disposing a folder that never existed
    expect(new RunOutputDir(join(tmpdir(), "brain-never-written"), "att-none").collect()).toEqual([]);
  });

  it("refuses an attempt id that could name another folder", () => {
    expect(() => new RunOutputDir("/tmp/state", "../other")).toThrow(/invalid attempt id/u);
    expect(() => new RunOutputDir("/tmp/state", "a/b")).toThrow(/invalid attempt id/u);
  });
});
