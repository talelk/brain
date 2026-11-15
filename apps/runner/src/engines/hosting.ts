import { modelKeyEnvName } from "@brain/contracts";
import type { EngineAdapter, EngineToolBinding } from "@brain/contracts";
import { resolveAnthropicEndpoint } from "./claude";
import { engineHosting } from "./isolation";
import { DEFAULT_LOCAL_MODEL_URL, type HostedRoute } from "./pi";
import { selectEngine } from "./run";
import type { HostInit } from "./sandbox-protocol";
import { SandboxedEngine, type EngineSandboxOpener } from "./sandboxed";

/** What a runner needs to run engines in sandboxes: the launcher that starts them and the directory of per-attempt engine state. */
export interface EngineSandboxSupport {
  readonly opener: EngineSandboxOpener;
  readonly stateRoot: string;
}

/** What one attempt gives its engine's sandbox. */
export interface AttemptSandbox {
  readonly support: EngineSandboxSupport;
  readonly attemptId: string;
  /** The job's resource reservation: the sandbox's cpu and memory limits. */
  readonly resources: { readonly cpuMillicores: number; readonly memoryMb: number };
  /** The workspace's allowed hosts (every job offer carries them). */
  readonly workspaceHosts: readonly string[];
  /** Tells apart the sandboxes of one attempt's routes. */
  readonly routeIndex: number;
}

/** `host` or `host:port` of an address, lower-case, in the form an egress grant names it; undefined for something that is not an address. */
export function hostOfAddress(address: string): string | undefined {
  try { return new URL(address).host.toLowerCase() || undefined; } catch { return undefined; }
}

/**
 * The hosts an engine's model is reached at: the routed model's, else the one this runner's environment names for the engine. An ACP agent
 * picks its own model, so the operator lists its hosts (BRAIN_ENGINE_MODEL_HOSTS). Everything else an attempt may reach is the workspace's list.
 */
export function modelHosts(engineId: string, route: HostedRoute | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const named = (address: string | undefined): string[] => { const host = address === undefined ? undefined : hostOfAddress(address); return host ? [host] : []; };
  if (route) return named(route.baseUrl);
  if (engineId === "pi") return named(env["BRAIN_LOCAL_MODEL_URL"] ?? DEFAULT_LOCAL_MODEL_URL);
  if (engineId === "claude") return named(env["BRAIN_ANTHROPIC_BASE_URL"] ?? env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com");
  return (env["BRAIN_ENGINE_MODEL_HOSTS"] ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
}

/** The settings an engine reads from its environment, forwarded as they are. */
const FORWARDED = ["BRAIN_LOCAL_MODEL_URL", "BRAIN_LOCAL_MODEL_ID", "BRAIN_ANTHROPIC_BASE_URL", "ANTHROPIC_BASE_URL", "BRAIN_CLAUDE_MODEL", "BRAIN_ACP_COMMAND", "BRAIN_OPENCODE_COMMAND", "BRAIN_TENCENTDB_TEAM_ID", "BRAIN_TENCENTDB_AGENT_ID"] as const;
/** The credentials an engine reads from its environment: sent in the init frame only. */
const CREDENTIALS = ["BRAIN_LOCAL_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/**
 * What the engine host is given: the settings and credentials the in-process engine would have read from the runner's environment, by name.
 * A routed attempt gets its route's key by reference (the runner's BRAIN_MODEL_KEY_<reference>); nothing else of the runner's environment goes.
 */
export function hostInit(engine: string, toolBindings: readonly EngineToolBinding[], route: HostedRoute | undefined, env: NodeJS.ProcessEnv = process.env): HostInit {
  // An unrouted Claude may keep its key in a file on the runner (BRAIN_ANTHROPIC_API_KEY_FILE): read there, the key is a credential like the rest.
  if (engine === "claude" && !route) { try { resolveAnthropicEndpoint(env); } catch { /* the engine reports it when it starts */ } }
  const present = <K extends string>(names: readonly K[]): Record<string, string> => Object.fromEntries(names.flatMap((name) => { const value = env[name]; return value ? [[name, value] as const] : []; }));
  const keyName = route ? modelKeyEnvName(route.keyRef) : undefined;
  return {
    engine, toolBindings, ...(route ? { route } : {}),
    env: present(FORWARDED),
    secrets: { ...present(CREDENTIALS), ...(keyName && env[keyName] ? { [keyName]: env[keyName]! } : {}) },
  };
}

/**
 * The engine adapter an attempt uses. An engine that this runner can sandbox runs in its own sandbox (and only there: when the sandbox cannot
 * start, the attempt fails); one that cannot (the fixture, or a runner with no sandbox support) is the in-process engine, and states the
 * isolation of that (`engineIsolation`): the answer is the same function the statement uses.
 */
export function attemptEngine(engineId: string, toolBindings: readonly EngineToolBinding[], route: HostedRoute | undefined, sandbox: AttemptSandbox | undefined): EngineAdapter | undefined {
  if (engineHosting(engineId, sandbox !== undefined) === "in-process") return selectEngine(engineId, toolBindings, route);
  // Built only to read its default model; nothing is ever started on it, and the engine that runs is the one in the sandbox.
  const described = selectEngine(engineId, toolBindings, route);
  if (!described || !sandbox) return undefined;
  const hosts = [...new Set([...sandbox.workspaceHosts, ...modelHosts(engineId, route)])];
  return new SandboxedEngine({
    engineId, ...(described.defaultModelId ? { defaultModelId: described.defaultModelId } : {}),
    opener: sandbox.support.opener, stateRoot: sandbox.support.stateRoot, attemptId: sandbox.attemptId,
    requestId: `engine-${sandbox.attemptId}-${sandbox.routeIndex}`,
    cpuMillicores: sandbox.resources.cpuMillicores, memoryMb: sandbox.resources.memoryMb, egressHosts: hosts,
    init: () => hostInit(engineId, toolBindings, route),
  });
}
