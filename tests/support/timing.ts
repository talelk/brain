import { availableParallelism, loadavg } from "node:os";

/**
 * Timeouts in tests that wait on real processes, sockets or the disk are budgets, not assertions. Under parallel
 * agent load they need more room. The factor is BRAIN_TEST_TIMEOUT_FACTOR when set (for example 3), and otherwise follows
 * the machine: one-minute load per CPU, rounded up, at most 4. It never shortens a budget below its default, and it only
 * widens deadlines; no test asserts that something happens faster than its budget.
 */
function factor(): number {
  const set = Number(process.env["BRAIN_TEST_TIMEOUT_FACTOR"] ?? "");
  if (Number.isFinite(set) && set >= 1) return set;
  const perCpu = loadavg()[0]! / Math.max(1, availableParallelism());
  return Math.min(4, Math.max(1, Math.ceil(perCpu)));
}
export const TIMEOUT_FACTOR = factor();

export function scaled(ms: number): number {
  return Math.ceil(ms * TIMEOUT_FACTOR);
}
