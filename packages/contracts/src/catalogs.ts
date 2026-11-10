import registryJson from "./registry.json" with { type: "json" };
import authMatrixJson from "./authorization-matrix.json" with { type: "json" };

export interface CommandDef {
  readonly type: string;
  readonly schema: string;
  readonly scope: string;
  readonly authority: string;
  readonly actors: readonly string[];
}
export interface EventDef {
  readonly type: string;
  readonly envelope: string;
  readonly payloadContract: string;
  readonly durable: boolean;
}

interface RegistryShape {
  readonly commands: readonly CommandDef[];
  readonly queries: readonly string[];
  readonly events: readonly EventDef[];
}

const registry = registryJson as unknown as RegistryShape;

export const COMMANDS: ReadonlyMap<string, CommandDef> = new Map(registry.commands.map((c) => [c.type, c]));
export const QUERIES: ReadonlySet<string> = new Set(registry.queries);
export const EVENTS: ReadonlyMap<string, EventDef> = new Map(registry.events.map((e) => [e.type, e]));

export function commandDef(type: string): CommandDef | undefined {
  return COMMANDS.get(type);
}
export function isKnownQuery(type: string): boolean {
  return QUERIES.has(type);
}
export function isKnownEvent(type: string): boolean {
  return EVENTS.has(type);
}

export { STATE_MACHINES, canTransition, isTerminal, machineStates } from "./machines";

export const AUTH_MATRIX = authMatrixJson as unknown as {
  readonly roles: Record<string, { readonly scopes: readonly string[]; readonly grantScope: string }>;
};

export function roleScopes(role: string): readonly string[] {
  return AUTH_MATRIX.roles[role]?.scopes ?? [];
}
