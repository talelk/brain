import stateMachinesJson from "./state-machines.json" with { type: "json" };

/**
 * The authoritative state machines, importable from the browser
 * (`@brain/contracts/machines`): this module reads only the JSON table, never
 * Node-only code, so the web app asks the same table the Governor enforces.
 */
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
