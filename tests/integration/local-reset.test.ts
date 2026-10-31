import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { instancePaths, registerInstance, resetInstance } from "../../scripts/local-instance";
import { acquireDirectory } from "../../apps/governor/src/infrastructure/persistence/directory";

it("reset clears only registered instance state, refuses active writers and preserves unrelated files", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-reset-"));
  const paths = instancePaths({ BRAIN_INSTANCE_DIR: root });
  try {
    registerInstance(paths);
    for (const directory of [paths.data, paths.run, paths.cli]) { mkdirSync(directory); writeFileSync(join(directory, "private-state"), "fixture"); }
    writeFileSync(join(root, "keep.txt"), "unrelated");
    const refused = spawnSync(process.execPath, ["--import", "tsx", "scripts/brain.ts", "reset"], { encoding: "utf8", env: { ...process.env, BRAIN_INSTANCE_DIR: root, BRAIN_DATA_DIR: paths.data, BRAIN_RUN_DIR: paths.run, BRAIN_CLI_STATE_DIR: paths.cli }, timeout: 15000 });
    expect(refused.status).not.toBe(0); expect(refused.stderr).toContain("--yes"); expect(existsSync(join(paths.data, "private-state"))).toBe(true);
    const release = acquireDirectory(paths.data);
    expect(() => resetInstance(paths)).toThrow(/in use/); release();
    resetInstance(paths);
    expect([paths.data, paths.run, paths.cli].every((path) => !existsSync(path))).toBe(true);
    expect(existsSync(join(root, "keep.txt"))).toBe(true);
    registerInstance(paths);
    symlinkSync(tmpdir(), paths.data);
    expect(() => resetInstance(paths)).toThrow(/symbolic/);
    expect(() => resetInstance({ ...paths, data: tmpdir() })).toThrow(/inside/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
