import { canTransition, isTerminal, STATE_MACHINES } from "@brain/contracts";
import { BrainDomainError } from "./errors";

/**
 * Minimal structural view of the database handle the seam needs. Declared
 * locally so the domain layer stays free of infrastructure imports
 * (scripts/check-boundaries.mjs); any better-sqlite3 handle satisfies it.
 */
export interface StateStore {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
  };
}

/**
 * The single enforcement seam for declared state machines.
 *
 * Every state change of a machine-declared table goes through
 * `transitionState` (per row) or `bulkTransition` (restore-time sweeps).
 * Both read the current state, assert it against the machine declared in
 * contracts/v1/state-machines.json, and write with a compare-and-swap on
 * that state — an illegal transition can never reach the database, and a
 * concurrent change cannot be clobbered. No other module writes state on
 * these tables; the invariant is pinned by tests/contracts/state-seam.test.ts.
 */

/** Machine -> table binding. The key column is the row identity. */
export const MACHINE_TABLE: Readonly<Record<string, { table: string; key: string }>> = {
  job: { table: "jobs", key: "id" },
  attempt: { table: "job_attempts", key: "id" },
  approval: { table: "approval_requests", key: "id" },
  evidence: { table: "evidence_bundles", key: "digest" },
  run: { table: "workflow_runs", key: "id" },
  mission: { table: "missions", key: "id" },
  planVersion: { table: "plan_versions", key: "id" },
  workItem: { table: "work_items", key: "id" },
  capitalizationRun: { table: "capitalization_runs", key: "id" },
  capabilityCandidate: { table: "tool_candidates", key: "id" },
};

export interface TransitionOptions {
  /** Extra SET columns bound as values. */
  set?: Record<string, unknown>;
  /** Computed SET fragments (counters, COALESCE); code constants only. */
  rawSet?: readonly string[];
  /** Append `version=version+1` to the same UPDATE. */
  bumpVersion?: boolean;
  /** Extra CAS predicates, e.g. { version: 3 } for optimistic locking. */
  and?: Record<string, unknown>;
}

/**
 * The from-states that legally reach `to` in the declared machine. Bulk
 * sweeps derive their WHERE-IN set from this instead of hand-listing states.
 */
export function statesTransitioningTo(machine: string, to: string): readonly string[] {
  const m = STATE_MACHINES.machines[machine] ?? {};
  return Object.keys(m).filter((from) => (m[from] ?? []).includes(to));
}

export function assertTransition(machine: string, from: string, to: string): void {
  if (from === to) return;
  if (isTerminal(machine, from)) {
    throw new BrainDomainError("CONFLICT", `${machine} terminal state ${from} cannot transition to ${to}`);
  }
  if (!canTransition(machine, from, to)) {
    throw new BrainDomainError("CONFLICT", `${machine} illegal transition ${from} -> ${to}`);
  }
}

/**
 * Reads the row, asserts the machine, and applies the transition with
 * `WHERE key=? AND state=?`. Returns false when the row already sits in
 * `to` (an idempotent no-op — nothing to re-write); returns true when the
 * transition landed. A concurrent state change throws CONFLICT.
 */
export function transitionState(db: StateStore, machine: string, id: string, to: string, opts: TransitionOptions = {}): boolean {
  const binding = MACHINE_TABLE[machine];
  if (!binding) throw new BrainDomainError("INTERNAL_ERROR", `state machine ${machine} has no table binding`);
  const { table, key } = binding;
  const row = db.prepare(`SELECT state FROM ${table} WHERE ${key}=?`).get(id) as { state: string } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", `${machine} ${id} not found`);
  if (row.state === to) return false;
  assertTransition(machine, row.state, to);
  const sets = ["state=?", ...Object.entries(opts.set ?? {}).map(([col]) => `${col}=?`), ...(opts.rawSet ?? []), ...(opts.bumpVersion ? ["version=version+1"] : [])];
  let sql = `UPDATE ${table} SET ${sets.join(",")} WHERE ${key}=? AND state=?`;
  const values: unknown[] = [to, ...Object.values(opts.set ?? {}), id, row.state];
  for (const [col, value] of Object.entries(opts.and ?? {})) {
    sql += ` AND ${col}=?`;
    values.push(value);
  }
  if (db.prepare(sql).run(...values).changes !== 1) {
    throw new BrainDomainError("CONFLICT", `${machine} ${id} changed concurrently before the transition to ${to}`);
  }
  return true;
}

/**
 * Machine-derived bulk sweep: transitions every row currently in a legal
 * from-state. Used by crash restore, where whole cohorts move at once and
 * row-by-row iteration would lose the single-statement crash safety.
 * Returns the number of rows transitioned.
 */
export function bulkTransition(db: StateStore, machine: string, to: string, opts: TransitionOptions = {}): number {
  const binding = MACHINE_TABLE[machine];
  if (!binding) throw new BrainDomainError("INTERNAL_ERROR", `state machine ${machine} has no table binding`);
  const froms = statesTransitioningTo(machine, to);
  if (froms.length === 0) return 0;
  const sets = ["state=?", ...Object.entries(opts.set ?? {}).map(([col]) => `${col}=?`), ...(opts.rawSet ?? []), ...(opts.bumpVersion ? ["version=version+1"] : [])];
  let sql = `UPDATE ${binding.table} SET ${sets.join(",")} WHERE state IN (${froms.map(() => "?").join(",")})`;
  const values: unknown[] = [to, ...Object.values(opts.set ?? {}), ...froms];
  for (const [col, value] of Object.entries(opts.and ?? {})) {
    sql += ` AND ${col}=?`;
    values.push(value);
  }
  return db.prepare(sql).run(...values).changes;
}

export function assertExpectedVersion(actual: number, expected: number | undefined): void {
  if (expected === undefined) return;
  if (actual !== expected) {
    throw new BrainDomainError("STALE_VERSION", `expected version ${expected} but current is ${actual}`, {
      fields: { currentVersion: String(actual) },
    });
  }
}

export function nextCounter(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new BrainDomainError("INTERNAL_ERROR", "counter exhausted");
  }
  return current + 1;
}
