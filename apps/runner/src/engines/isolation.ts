import type { EngineInfo, Placement } from "@brain/contracts";

export type IsolationMode = Placement["isolation"];

/**
 * The isolation each engine really provides on this runner (ADR 0035). Pi, Claude and the fixture run in the runner process with no
 * native tools: everything they do goes through broker tools, which run in launcher sandboxes. An ACP agent is a separate process of the
 * runner's user that Brain cannot contain: it is kept to broker tools by its configuration, by refusing its permission requests and by
 * stopping it when it runs a native tool, but nothing outside it enforces that, so it is `trusted-local` until engines run in a
 * per-attempt sandbox. An engine not listed here is `trusted-local` too: a new engine claims more only by being named below.
 */
const ENGINE_ISOLATION: Readonly<Record<string, IsolationMode>> = {
  fixture: "ephemeral-container",
  pi: "ephemeral-container",
  claude: "ephemeral-container",
  acp: "trusted-local",
  opencode: "trusted-local",
};

export function engineIsolation(engineId: string): IsolationMode {
  return ENGINE_ISOLATION[engineId] ?? "trusted-local";
}

/** The capability a runner states for one engine: placement needs `engine-isolation:<engine>:<the step's isolation>` to use that engine. */
export const engineIsolationCapability = (engineId: string): string => `engine-isolation:${engineId}:${engineIsolation(engineId)}`;

/**
 * What a runner tells the Governor it has: its configured capabilities, with the engine entries replaced by what was probed (an operator
 * cannot configure an engine, its features or its isolation into existence). Used by the hello and by every heartbeat.
 */
export function advertisedCapabilities(configured: readonly string[], engines: readonly Pick<EngineInfo, "id" | "features">[]): string[] {
  return [...new Set([
    ...configured.filter((capability) => !/^engine(:|-feature:|-isolation:)/u.test(capability)),
    ...engines.map((engine) => `engine:${engine.id}`),
    ...engines.flatMap((engine) => engine.features.map((feature) => `engine-feature:${engine.id}:${feature}`)),
    ...engines.map((engine) => engineIsolationCapability(engine.id)),
  ])];
}

/** The isolation modes this runner provides: the launcher's containers for tools, and the mode of each engine it runs. */
export function advertisedIsolationModes(engines: readonly Pick<EngineInfo, "id">[]): IsolationMode[] {
  return [...new Set<IsolationMode>(["ephemeral-container", ...engines.map((engine) => engineIsolation(engine.id))])];
}
