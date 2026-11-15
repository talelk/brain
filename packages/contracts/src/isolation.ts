/**
 * Isolation levels, weakest first (ADR 0067). A runner or an engine states the level it really provides; a step and the effective
 * policy state the level they need. A statement meets a need when it is the same level or a stronger one. A name outside this order
 * is compared by equality only, so it never satisfies a named level and a named level never satisfies it.
 */
export const ISOLATION_LEVELS = ["trusted-local", "ephemeral-container", "dedicated-vm"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export const isolationRank = (level: string): number => ISOLATION_LEVELS.indexOf(level as IsolationLevel);

/** True when what is provided is at least what is required (ordered, not equality). */
export function isolationSatisfies(provided: string, required: string): boolean {
  if (provided === required) return true;
  const have = isolationRank(provided);
  const need = isolationRank(required);
  return have >= 0 && need >= 0 && have >= need;
}

/** The stricter of two named levels; an unnamed level never wins over a named one. */
export function stricterIsolation(a: string, b: string): string {
  return isolationRank(b) > isolationRank(a) ? b : a;
}

/** Every named level that meets the need, weakest first: the statements an engine may make to take a step. */
export function isolationLevelsMeeting(required: string): string[] {
  const need = isolationRank(required);
  return need < 0 ? [required] : ISOLATION_LEVELS.slice(need);
}
