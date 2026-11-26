/**
 * What `pnpm brain check <folder>` and the repository's tests do with a folder someone wrote: load it as Brain would, hold a pack to its
 * shape, and run each tool's `test.sh`, checking what `run.sh` printed against the outputs the tool declares. Everything is offline.
 */
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { loadWorkspace } from "../apps/governor/src/workspace/load";
import { packShapeProblems } from "../apps/governor/src/workspace/pack-shape";
import { fieldSchema, PLATFORM_PACK, ToolFile, type Problem } from "../packages/contracts/src/files";
import type { JsonValue } from "../packages/contracts/src/protocol";
import { schemaProblem } from "../packages/contracts/src/validate";

/** Passes on to bash, and keeps what a `run.sh` that succeeded printed. */
const KEEPER = `#!/bin/sh
case "$1" in
  */run.sh)
    out="$(mktemp)"; "$REAL_BASH" "$@" >"$out"; code=$?; cat "$out"
    if [ "$code" = 0 ]; then tr -d '\\n' <"$out" >>"$PROOF_LOG"; printf '\\n' >>"$PROOF_LOG"; fi
    rm -f "$out"; exit "$code" ;;
  *) exec "$REAL_BASH" "$@" ;;
esac
`;

export interface Proof { readonly ok: boolean; readonly said: string; readonly problems: readonly string[] }

/** Runs the `test.sh` of one tool folder. `ok` needs it to end with 0 saying ok or skipped, and every result of `run.sh` to fit the tool's outputs. */
export async function proveTool(folder: string): Promise<Proof> {
  const work = mkdtempSync(join(tmpdir(), "brain-proof-"));
  try {
    const bin = join(work, "bin");
    const log = join(work, "results");
    mkdirSync(bin);
    writeFileSync(join(bin, "bash"), KEEPER);
    chmodSync(join(bin, "bash"), 0o755);
    writeFileSync(log, "");
    const bash = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
    const env = { PATH: `${bin}:${process.env["PATH"] ?? ""}`, REAL_BASH: bash, PROOF_LOG: log, HOME: process.env["HOME"], TMPDIR: process.env["TMPDIR"] };
    let said: string;
    try {
      said = (await promisify(execFile)(bash, ["./test.sh"], { cwd: folder, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim().split("\n").at(-1) ?? "";
    } catch (error) {
      const failed = error as { stderr?: string; stdout?: string; message: string };
      return { ok: false, said: `test.sh failed: ${(failed.stderr || failed.stdout || failed.message).trim().split("\n").slice(-3).join(" ")}`, problems: [] };
    }
    const tool = ToolFile.safeParse(parseToml(readFileSync(join(folder, "tool.toml"), "utf8")));
    const schema = tool.success && tool.data.outputs ? fieldSchema(tool.data.outputs, "outputs") : undefined;
    const problems = schema ? readFileSync(log, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      let value: JsonValue;
      try { value = JSON.parse(line) as JsonValue; } catch { return [`run.sh printed no JSON: ${line.slice(0, 200)}`]; }
      const problem = schemaProblem(schema, value, "output");
      return problem ? [`a result does not fit the outputs: ${problem}`] : [];
    }) : [];
    return { ok: /: (?:ok|skipped)/u.test(said) && problems.length === 0, said, problems: [...new Set(problems)] };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Every file of a folder by its path from it; hidden files and dependencies are not part of a workspace or a pack. */
function filesOf(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) walk(path);
      else files.set(relative(root, path), new Uint8Array(readFileSync(path)));
    }
  };
  walk(root);
  return files;
}

/** Everything wrong with a workspace folder or a pack folder, and what each tool's proof said. */
export async function checkFolder(folder: string, packsDir: string): Promise<{ kind: "workspace" | "pack"; problems: Problem[]; proofs: Array<Proof & { tool: string }> }> {
  const isPack = existsSync(join(folder, "pack.toml"));
  if (!isPack && !existsSync(join(folder, "brain.toml"))) throw new Error(`${folder} holds neither pack.toml nor brain.toml`);
  const files = filesOf(folder);
  if (isPack) {
    // A pack is checked as a workspace that holds its files over the packs it requires.
    const pack = parseToml(readFileSync(join(folder, "pack.toml"), "utf8")) as { name?: string; requires?: string[] };
    files.set("brain.toml", new TextEncoder().encode(`name = "Check"\n${pack.name === PLATFORM_PACK ? 'platform = "admin"\n' : ""}packs = ${JSON.stringify((pack.requires ?? []).filter((name) => name !== pack.name))}\n`));
  }
  const loaded = loadWorkspace(files, packsDir);
  const problems = [...loaded.problems, ...(isPack && loaded.manifest ? packShapeProblems(loaded.manifest, "workspace") : [])];
  const tools = [...files.keys()].filter((path) => /^tools\/[^/]+\/test\.sh$/u.test(path)).map((path) => dirname(path)).sort();
  const proofs: Array<Proof & { tool: string }> = [];
  for (const tool of tools) proofs.push({ tool: tool.slice("tools/".length), ...(await proveTool(join(folder, tool))) });
  return { kind: isPack ? "pack" : "workspace", problems, proofs };
}
