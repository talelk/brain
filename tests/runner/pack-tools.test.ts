import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/** Every script tool a pack ships proves itself (packs/README.md, "Script tools"): its test.sh needs no network, exits 0 and says ok, or says what is missing here. */
const PACKS = fileURLToPath(new URL("../../packs", import.meta.url));
const run = promisify(execFile);
const folders = (path: string): string[] => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []);
const proofs = folders(PACKS).flatMap((pack) => folders(join(PACKS, pack, "tools")).map((tool) => ({ pack, tool, folder: join(PACKS, pack, "tools", tool) }))).filter(({ folder }) => existsSync(join(folder, "test.sh")));

describe("the tools a pack ships", () => {
  it("have a proof to run", () => {
    expect(proofs.length).toBeGreaterThan(0);
  });

  it.concurrent.each(proofs)("$pack/$tool proves itself", { timeout: 180_000 }, async ({ tool, folder }) => {
    const { stdout } = await run("bash", ["./test.sh"], { cwd: folder, env: { PATH: process.env["PATH"], HOME: process.env["HOME"], TMPDIR: process.env["TMPDIR"] } });
    expect(stdout.trim().split("\n").at(-1)).toMatch(new RegExp(`^${tool.replaceAll(".", "\\.")}: (ok|skipped)`, "u"));
  });
});
