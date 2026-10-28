import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigDocsFromDir } from "../../apps/governor/src/modules/configuration/loader";
import { parseRestrictedYaml } from "../../apps/governor/src/modules/configuration/index";

// T08 packet acceptance: the confined loader reads only regular YAML files
// under the root, in deterministic order; symlinks and escapes are refused;
// the restricted YAML grammar rejects dangerous/ambiguous constructs.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function root(): string {
  const d = mkdtempSync(join(tmpdir(), "brain-loader-"));
  dirs.push(d);
  return d;
}

describe("confined config loader (T08)", () => {
  it("loads yaml files recursively in path order and ignores non-yaml files", () => {
    const dir = root();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "b.yaml"), "kind: B\n");
    writeFileSync(join(dir, "sub", "a.yml"), "kind: A\n");
    writeFileSync(join(dir, "notes.txt"), "ignore me\n");
    const docs = loadConfigDocsFromDir(dir);
    expect(docs.map((d) => d.path)).toEqual(["b.yaml", "sub/a.yml"]);
  });

  it("rejects symlinked files and symlinked directories outright", () => {
    const dir = root();
    const outside = root();
    writeFileSync(join(outside, "secret.yaml"), "kind: Secret\n");
    symlinkSync(join(outside, "secret.yaml"), join(dir, "link.yaml"));
    expect(() => loadConfigDocsFromDir(dir)).toThrow(/symlink forbidden/);

    const dir2 = root();
    symlinkSync(outside, join(dir2, "linkdir"));
    expect(() => loadConfigDocsFromDir(dir2)).toThrow(/symlink forbidden/);
  });

  it("restricted YAML rejects anchors, tags, duplicate keys and deep nesting", () => {
    expect(() => parseRestrictedYaml("a: &x 1\nb: *x\n", "a.yaml")).toThrow();
    expect(() => parseRestrictedYaml("a: !!str hello\n", "a.yaml")).toThrow();
    expect(() => parseRestrictedYaml("a: 1\na: 2\n", "a.yaml")).toThrow();
    expect(() => parseRestrictedYaml("a: 1\n---\nb: 2\n", "a.yaml")).toThrow();
    expect(() => parseRestrictedYaml("base: &b\n  x: 1\nderived:\n  <<: *b\n", "a.yaml")).toThrow();
    expect(parseRestrictedYaml("kind: Workflow\nmetadata:\n  id: w1\n", "w.yaml")).toMatchObject({ kind: "Workflow" });
  });
});
