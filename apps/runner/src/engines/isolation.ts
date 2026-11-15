import type { EngineInfo, Placement } from "@brain/contracts";

export type IsolationMode = Placement["isolation"];

/**
 * The isolation each engine really provides on this runner (ADR 0035, 0073). An engine that runs in the runner process is `trusted-local`:
 * nothing outside it contains it. An engine run by the engine sandbox (its own container, read-only root, no capabilities, resource limits,
 * network only through the egress proxy) is `ephemeral-container`; that is claimed only while this runner can start such sandboxes, and the
 * runner never runs a sandboxable engine in its own process when it claims it. The fixture engine runs no model, no agent code and no
 * tool of its own (it answers from its script and proposes broker tools, which run in launcher containers), so it has nothing to contain and
 * states `ephemeral-container` with or without a sandbox. An engine not listed here is `trusted-local`: a new engine claims more only by
 * being named below.
 */
const SANDBOXABLE: ReadonlySet<string> = new Set(["pi", "claude", "acp", "opencode", "codex"]);

/** Where an engine runs: in its own sandbox, or in the runner process. The one answer both the statement and the selection read. */
export type EngineHosting = "sandboxed" | "in-process";

export function engineHosting(engineId: string, sandboxAvailable: boolean): EngineHosting {
  return SANDBOXABLE.has(engineId) && sandboxAvailable ? "sandboxed" : "in-process";
}

export function engineIsolation(engineId: string, sandboxAvailable: boolean): IsolationMode {
  if (engineId === "fixture") return "ephemeral-container";
  return engineHosting(engineId, sandboxAvailable) === "sandboxed" ? "ephemeral-container" : "trusted-local";
}

/** The capability a runner states for one engine: placement needs `engine-isolation:<engine>:<the step's isolation>` to use that engine. */
export const engineIsolationCapability = (engineId: string, sandboxAvailable: boolean): string => `engine-isolation:${engineId}:${engineIsolation(engineId, sandboxAvailable)}`;

/**
 * What a runner tells the Governor it has: its configured capabilities, with the engine entries replaced by what was probed (an operator
 * cannot configure an engine, its features or its isolation into existence). Used by the hello and by every heartbeat.
 */
export function advertisedCapabilities(configured: readonly string[], engines: readonly Pick<EngineInfo, "id" | "features">[], sandboxAvailable: boolean): string[] {
  return [...new Set([
    ...configured.filter((capability) => !/^engine(:|-feature:|-isolation:)/u.test(capability)),
    ...engines.map((engine) => `engine:${engine.id}`),
    ...engines.flatMap((engine) => engine.features.map((feature) => `engine-feature:${engine.id}:${feature}`)),
    ...engines.map((engine) => engineIsolationCapability(engine.id, sandboxAvailable)),
  ])];
}

/** The isolation modes this runner provides: the launcher's containers for tools, and the mode of each engine it runs. */
export function advertisedIsolationModes(engines: readonly Pick<EngineInfo, "id">[], sandboxAvailable: boolean): IsolationMode[] {
  return [...new Set<IsolationMode>(["ephemeral-container", ...engines.map((engine) => engineIsolation(engine.id, sandboxAvailable))])];
}
