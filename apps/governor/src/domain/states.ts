import { canTransition, isTerminal } from "@brain/contracts";
import { BrainDomainError } from "./errors";

export function assertTransition(machine: string, from: string, to: string): void {
  if (from === to) return;
  if (isTerminal(machine, from)) {
    throw new BrainDomainError("CONFLICT", `${machine} terminal state ${from} cannot transition to ${to}`);
  }
  if (!canTransition(machine, from, to)) {
    throw new BrainDomainError("CONFLICT", `${machine} illegal transition ${from} -> ${to}`);
  }
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
