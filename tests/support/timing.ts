/**
 * Timeouts in tests that wait on real processes, sockets or the disk are budgets, not assertions. Under parallel
 * agent load they need more room; set BRAIN_TEST_TIMEOUT_FACTOR (for example 3) to scale every budget that goes
 * through `scaled`. The factor never shortens a budget below its default.
 */
const parsed = Number(process.env["BRAIN_TEST_TIMEOUT_FACTOR"] ?? "1");
export const TIMEOUT_FACTOR = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;

export function scaled(ms: number): number {
  return Math.ceil(ms * TIMEOUT_FACTOR);
}
