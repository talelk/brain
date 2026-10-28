import registryJson from "./registry.json" with { type: "json" };
import stateMachinesJson from "./state-machines.json" with { type: "json" };
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

export const STATE_MACHINES = stateMachinesJson as unknown as {
  readonly machines: Record<string, Record<string, readonly string[]>>;
};

export function canTransition(machine: string, from: string, to: string): boolean {
  const m = STATE_MACHINES.machines[machine];
  if (!m) return false;
  return (m[from] ?? []).includes(to);
}
export function isTerminal(machine: string, state: string): boolean {
  const m = STATE_MACHINES.machines[machine];
  if (!m) return false;
  return (m[state] ?? []).length === 0;
}
export function machineStates(machine: string): readonly string[] {
  return Object.keys(STATE_MACHINES.machines[machine] ?? {});
}

export const AUTH_MATRIX = authMatrixJson as unknown as {
  readonly roles: Record<string, { readonly scopes: readonly string[]; readonly grantScope: string }>;
};

export function roleScopes(role: string): readonly string[] {
  return AUTH_MATRIX.roles[role]?.scopes ?? [];
}
