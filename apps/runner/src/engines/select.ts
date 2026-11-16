import { ClaudeEngine } from "./claude";
import { CodexEngine } from "./codex";
import { FixtureEngine } from "./fixture";
import { OpenCodeEngine } from "./opencode";
import { PiEngine } from "./pi";
import type { EngineAdapter } from "./port";

/** The engines this runner knows: fixture (no model), pi, claude, and the ACP agents opencode and codex. */
export function createEngine(id: string): EngineAdapter | undefined {
  switch (id) {
    case "fixture": return new FixtureEngine();
    case "pi": return new PiEngine();
    case "claude": return new ClaudeEngine();
    case "opencode": return new OpenCodeEngine();
    case "codex": return new CodexEngine();
    default: return undefined;
  }
}

/**
 * Engines that are whole programs of their own (ACP agents). The runner can judge their own tools only by what they report, and they
 * carry tools no setting turns off (OpenCode's Code Mode can fetch), so they run in an engine sandbox or not at all.
 */
const SANDBOX_ONLY: ReadonlySet<string> = new Set(["opencode", "codex"]);

/**
 * Where an engine runs. The fixture runs no model and no code of its own, so it runs in the runner and may use its native tools there
 * (they are confined to the attempt's working copy). Every other engine runs in its attempt's sandbox when this runner can start one.
 * Without a sandbox, Pi and Claude run in the runner process with their own tools off, and an ACP agent does not run.
 */
export type EngineHosting = "fixture" | "sandboxed" | "in-process" | "unavailable";

export function engineHosting(id: string, sandboxAvailable: boolean): EngineHosting {
  return id === "fixture" ? "fixture" : sandboxAvailable ? "sandboxed" : SANDBOX_ONLY.has(id) ? "unavailable" : "in-process";
}

/** Whether an engine hosted this way may be given native tools. */
export const nativeToolsAllowed = (hosting: EngineHosting): boolean => hosting === "fixture" || hosting === "sandboxed";
