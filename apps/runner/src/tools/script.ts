import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import type { BlobRef, JsonValue, OfferTool } from "@brain/contracts";
import { execa } from "execa";
import { isJsonObject } from "../engines/json-reply";
import type { CommandResult, Launcher } from "../launcher-client";

/** What running a tool came to: the output the agent and the record get, and whether it worked. */
export interface ToolRunResult { readonly ok: boolean; readonly output: JsonValue }

const fail = (error: string, extra: Record<string, JsonValue> = {}): ToolRunResult => ({ ok: false, output: { error, ...extra } });

/** The environment variable a tool reads a secret from: `BRAIN_SECRET_` and the secret's name in capitals, dashes as underscores. */
export const secretEnvName = (secret: string): string => `BRAIN_SECRET_${secret.toUpperCase().replace(/-/gu, "_")}`;

/** Every leased value is removed from whatever a tool printed before it reaches an event, an artifact or the model. */
export function scrubSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value.length >= 4) out = out.split(value).join("[redacted]");
  return out;
}

/** Where an attempt's copy of a tool's files is: the folder the launcher mounts at `/tools`. */
export const toolDir = (attemptDir: string, tool: string): string => join(attemptDir, "tools", tool);

/** Writes the tool's files, fetched and verified by digest, into the attempt's folder for it; done once per tool and attempt. */
export async function materializeTool(attemptDir: string, tool: OfferTool, blob: (ref: BlobRef) => Promise<Uint8Array>): Promise<string> {
  if (tool.name.length > 80 || !tool.name.split(".").every((part) => /^[a-z][a-z0-9-]{0,62}$/u.test(part))) throw new Error(`the tool name ${tool.name} cannot name a folder`);
  const dir = toolDir(attemptDir, tool.name);
  if (existsSync(join(dir, ".complete"))) return dir;
  for (const file of tool.files) {
    const relative = normalize(file.path);
    if (relative.startsWith("..") || relative.startsWith(sep) || relative.includes(`..${sep}`)) throw new Error(`tool ${tool.name} has a file outside its folder: ${file.path}`);
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await blob(file), { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  if (!existsSync(join(dir, "run.sh"))) throw new Error(`tool ${tool.name} has no run.sh`);
  writeFileSync(join(dir, ".complete"), "");
  return dir;
}

/**
 * What a script's exit means (packs/README.md, "Script tools"): exit 0 with one JSON value on standard output is the result; exit 2
 * with `{"error": "<why>"}` is a refusal by the tool; anything else is a failure, reported with the end of what it printed.
 */
export function scriptResult(run: CommandResult, secrets: readonly string[]): ToolRunResult {
  const stdout = scrubSecrets(run.stdout, secrets).trim();
  const stderr = scrubSecrets(run.stderr, secrets).trim().slice(-2000);
  if (run.timedOut) return fail("the tool ran longer than its timeout and was stopped", stderr ? { stderr } : {});
  let parsed: JsonValue | undefined;
  try { parsed = stdout ? JSON.parse(stdout) as JsonValue : undefined; } catch { parsed = undefined; }
  if (run.exitCode === 0) return parsed === undefined ? fail("the tool printed no JSON result", { stdout: stdout.slice(0, 2000) }) : { ok: true, output: parsed };
  const why = isJsonObject(parsed) && typeof parsed["error"] === "string" ? parsed["error"] : undefined;
  return fail(why ?? `the tool ended with exit code ${run.exitCode}`, stderr ? { stderr } : {});
}

export interface ScriptRun {
  readonly attemptId: string;
  readonly attemptDir: string;
  readonly tool: OfferTool;
  readonly callId: string;
  readonly input: JsonValue;
  readonly launcher: Launcher | undefined;
  readonly blob: (ref: BlobRef) => Promise<Uint8Array>;
  /** Leases one of the tool's declared secrets for this call. */
  readonly secret: (name: string) => Promise<string>;
  /** TEST ONLY: with no launcher, run the script directly on this host. Never set by `main.ts`. */
  readonly unsandboxedForTests: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Runs a tool's `run.sh` on the validated input: in a tool sandbox through the launcher, with the working copy read-only at `/work`,
 * the tool's hosts on the egress proxy and its secrets as environment variables of that run. A runner without a launcher refuses.
 */
export async function runScriptTool(run: ScriptRun): Promise<ToolRunResult> {
  const { tool } = run;
  const input = JSON.stringify(run.input);
  if (Buffer.byteLength(input, "utf8") > 64 * 1024) return fail("the tool input is too large");
  if (!run.launcher && !run.unsandboxedForTests) return fail("this runner has no launcher, so it cannot run a tool in a sandbox; the call was not made");
  let dir: string;
  try { dir = await materializeTool(run.attemptDir, tool, run.blob); } catch (error) { return fail(error instanceof Error ? error.message : "the tool's files could not be fetched"); }
  const secretEnv: Record<string, string> = {};
  try { for (const name of tool.secrets) secretEnv[secretEnvName(name)] = await run.secret(name); } catch (error) { return fail(`a secret of the tool could not be leased: ${error instanceof Error ? error.message.slice(0, 200) : "refused"}`); }
  const values = Object.values(secretEnv);
  const timeoutMs = tool.timeoutSeconds * 1000;
  try {
    if (run.launcher) return scriptResult(await run.launcher.runTool({ attemptId: run.attemptId, tool: tool.name, requestId: run.callId, egressHosts: tool.network, input, timeoutMs, secretEnv }), values);
    return scriptResult(await runDirectlyForTests(dir, join(run.attemptDir, "work"), input, timeoutMs, secretEnv, run.signal), values);
  } catch (error) {
    return fail(scrubSecrets(error instanceof Error ? error.message : "the tool could not be run", values).slice(0, 500));
  }
}

/** TEST ONLY: the script on this host, with an empty environment and the working copy as its directory. There is no sandbox here. */
async function runDirectlyForTests(dir: string, workDir: string, input: string, timeoutMs: number, secretEnv: Readonly<Record<string, string>>, signal: AbortSignal | undefined): Promise<CommandResult> {
  const result = await execa("/bin/bash", [join(dir, "run.sh")], {
    input, timeout: timeoutMs, maxBuffer: 1024 * 1024, extendEnv: false, shell: false, reject: false, cwd: existsSync(workDir) ? workDir : dir,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", ...secretEnv }, ...(signal ? { cancelSignal: signal } : {}),
  });
  return { exitCode: result.exitCode ?? 1, stdout: String(result.stdout), stderr: String(result.stderr), timedOut: result.timedOut === true };
}
