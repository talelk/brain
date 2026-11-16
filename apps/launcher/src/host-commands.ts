import { existsSync, readFileSync } from "node:fs";

/**
 * The operator's list of named host commands: what a tool with `host_command = "<name>"` runs on the runner host. The launcher runs one
 * only by name: the file fixes the argv, and a caller supplies at most the named arguments (the tool's inputs), each checked against the
 * operator's pattern. There is no shell and no free-form argv, and a command declared `privileged` is refused unless the caller says the
 * call is an approved privileged one.
 *
 * The file (BRAIN_LAUNCHER_HOST_COMMANDS) is JSON:
 *   {"commands": {"host.logs": {"argv": ["docker", "logs", "--tail", "{lines}", "{container}"], "effect": "read",
 *                               "args": {"lines": "^[0-9]{1,3}$", "container": "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$"}, "timeoutMs": 15000}}}
 */
export type HostCommandEffect = "read" | "privileged";

export interface HostCommand {
  readonly argv: readonly string[];
  readonly effect: HostCommandEffect;
  /** placeholder name -> anchored pattern the value must match (first character is never "-" so a value cannot become a flag). */
  readonly args: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export type HostCommandTable = ReadonlyMap<string, HostCommand>;

/** The same names a tool file may give as `host_command`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
/** A placeholder names a tool input: lower-case letters, digits and underscores. */
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/gu;

export function parseHostCommands(text: string): HostCommandTable {
  const raw = JSON.parse(text) as { commands?: Record<string, { argv?: unknown; effect?: unknown; args?: unknown; timeoutMs?: unknown }> };
  const table = new Map<string, HostCommand>();
  for (const [name, entry] of Object.entries(raw.commands ?? {})) {
    if (!NAME.test(name)) throw new Error(`host command name ${name} is invalid`);
    if (!Array.isArray(entry.argv) || entry.argv.length === 0 || entry.argv.some((part) => typeof part !== "string")) throw new Error(`host command ${name} needs a string argv`);
    if (entry.effect !== "read" && entry.effect !== "privileged") throw new Error(`host command ${name} needs effect read or privileged`);
    const args = (entry.args ?? {}) as Record<string, unknown>;
    for (const [arg, pattern] of Object.entries(args)) {
      if (typeof pattern !== "string" || !pattern.startsWith("^") || !pattern.endsWith("$")) throw new Error(`host command ${name} argument ${arg} needs an anchored pattern`);
      new RegExp(pattern, "u");
    }
    const used = new Set((entry.argv as string[]).flatMap((part) => [...part.matchAll(PLACEHOLDER)].map((m) => m[1]!)));
    for (const arg of used) if (!(arg in args)) throw new Error(`host command ${name} uses {${arg}} with no pattern`);
    table.set(name, { argv: entry.argv as string[], effect: entry.effect, args: args as Record<string, string>, timeoutMs: Math.min(600_000, Math.max(1000, Number(entry.timeoutMs ?? 15_000))) });
  }
  return table;
}

export function loadHostCommands(path: string | undefined): HostCommandTable {
  if (!path || !existsSync(path)) return new Map();
  return parseHostCommands(readFileSync(path, "utf8"));
}

export type Resolved = { readonly ok: true; readonly argv: readonly string[]; readonly command: HostCommand } | { readonly ok: false; readonly status: number; readonly error: string };

/** Resolves a request to a fixed argv, or says exactly why not. `effect` is what the caller is allowed to run. */
export function resolveHostCommand(table: HostCommandTable, name: string, args: unknown, allowed: HostCommandEffect): Resolved {
  const command = table.get(name);
  if (!command) return { ok: false, status: 404, error: `host command ${name} is not declared by the operator` };
  if (command.effect === "privileged" && allowed !== "privileged") return { ok: false, status: 403, error: `host command ${name} is privileged: only a tool with effect privileged may run it` };
  if (command.effect === "read" && allowed === "privileged") return { ok: false, status: 403, error: `host command ${name} is declared read-only, but the tool that names it is privileged` };
  const given = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  for (const key of Object.keys(given)) if (!(key in command.args)) return { ok: false, status: 422, error: `argument ${key} is not accepted by ${name}` };
  const values: Record<string, string> = {};
  for (const [arg, pattern] of Object.entries(command.args)) {
    const value = given[arg];
    if (typeof value !== "string" || !new RegExp(pattern, "u").test(value) || value.startsWith("-")) return { ok: false, status: 422, error: `argument ${arg} of ${name} is missing or does not match ${pattern}` };
    values[arg] = value;
  }
  return { ok: true, command, argv: command.argv.map((part) => part.replace(PLACEHOLDER, (_all, arg: string) => values[arg]!)) };
}
