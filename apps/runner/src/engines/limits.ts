/**
 * Per-attempt spend rule shared by every engine (ADR 0006): a cap of 0 means
 * "no per-attempt dollar cap" and the mission budget with its attempt reserve
 * bounds spend; only a positive cap is enforced.
 */
export function overCostCap(microUsd: number, maxMicroUsd: number): boolean {
  return maxMicroUsd > 0 && microUsd > maxMicroUsd;
}

/** What an attempt has used so far; `turns` counts the model's replies (a reply that calls a tool is one); `lastTurnTokens` is what the latest turn cost. */
export interface AttemptUse { readonly tokens: number; readonly microUsd: number; readonly turns: number; readonly lastTurnTokens?: number }
export interface AttemptLimits { readonly maxTokens: number; readonly maxMicroUsd: number; readonly maxTurns: number }

/** The share of its allowance an attempt may use before further tool calls are refused and the model is told to write its answer. */
export const WRAP_UP_SHARE = 0.8;

/**
 * The budget of one attempt, judged while it runs. The stop is staged because every turn re-sends the whole conversation, so an attempt
 * that is left to run to its end can use several times its allowance before anything looks at it:
 * - past `WRAP_UP_SHARE` of the tokens (or on its last turn) a tool call is refused with an instruction to answer from what it has;
 * - past the allowance itself, an attempt still calling tools is stopped, and the reason names the numbers;
 * - an attempt whose final answer is already written is never stopped for its size: the answer is kept and the spend is charged.
 */
export function wrapUpReason(use: AttemptUse, limits: AttemptLimits): string | undefined {
  // A turn re-sends the whole conversation, so the next one costs about what the last did: wrap up while that still fits, not after it did not.
  const tokens = limits.maxTokens > 0 && (use.tokens >= limits.maxTokens * WRAP_UP_SHARE || use.tokens + (use.lastTurnTokens ?? 0) > limits.maxTokens);
  const money = limits.maxMicroUsd > 0 && use.microUsd >= limits.maxMicroUsd * WRAP_UP_SHARE;
  const turns = limits.maxTurns > 0 && use.turns >= limits.maxTurns - 1;
  if (!tokens && !money && !turns) return undefined;
  return "The tool-call budget is used up: this attempt's allowance is nearly spent, so no more tool calls are accepted. Stop calling tools at once and write your complete final answer now from what you already have, saying what you could not check.";
}

/** Why an attempt that is still calling tools must stop now, or undefined while it is within its allowance. */
export function overAllowanceReason(use: AttemptUse, limits: AttemptLimits): string | undefined {
  const parts: string[] = [];
  if (limits.maxTokens > 0 && use.tokens > limits.maxTokens) parts.push(`${use.tokens} of ${limits.maxTokens} tokens`);
  if (overCostCap(use.microUsd, limits.maxMicroUsd)) parts.push(`${use.microUsd} of ${limits.maxMicroUsd} micro-dollars`);
  if (limits.maxTurns > 0 && use.turns > limits.maxTurns) parts.push(`${use.turns} of ${limits.maxTurns} turns`);
  return parts.length > 0 ? `the attempt used its allowance (${parts.join(", ")}) and was still calling tools, so no complete answer was written` : undefined;
}
