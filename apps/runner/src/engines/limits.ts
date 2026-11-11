/**
 * Per-attempt spend rule shared by every engine (ADR 0006): a cap of 0 means
 * "no per-attempt dollar cap" and the mission budget with its attempt reserve
 * bounds spend; only a positive cap is enforced.
 */
export function overCostCap(microUsd: number, maxMicroUsd: number): boolean {
  return maxMicroUsd > 0 && microUsd > maxMicroUsd;
}
