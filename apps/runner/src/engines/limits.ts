import type { EngineLimits } from "./port";

/** A cap of 0 means no cap; only a positive one is enforced. */
export function overCostCap(microUsd: number, maxMicroUsd: number): boolean {
  return maxMicroUsd > 0 && microUsd > maxMicroUsd;
}

/** What an attempt has used so far; `turns` counts the model's replies (a reply that calls a tool is one); `lastTurnTokens` is what the latest turn cost. */
export interface AttemptUse { readonly tokens: number; readonly microUsd: number; readonly turns: number; readonly lastTurnTokens?: number }
type Allowance = Pick<EngineLimits, "maxTokens" | "maxMicroUsd" | "maxTurns">;

/** The share of its allowance an attempt may use before further tool calls are refused and the model is told to write its answer. */
const WRAP_UP_SHARE = 0.8;

/**
 * The agent's limits, judged while the attempt runs. The stop is staged because every turn sends the whole conversation again, so an
 * attempt left to run to its end can use several times its allowance before anything looks at it:
 * - past `WRAP_UP_SHARE` of the tokens or the money (or on its last turn) tool calls are refused and the model is told to answer;
 * - past the allowance itself, an attempt still calling tools is stopped, and the reason names the numbers;
 * - an attempt whose final answer is already written is never stopped for its size: the answer is kept and the spend is reported.
 */
export function wrapUpReason(use: AttemptUse, limits: Allowance): string | undefined {
  // The next turn costs about what the last did: wrap up while that still fits, not after it did not.
  const tokens = limits.maxTokens > 0 && (use.tokens >= limits.maxTokens * WRAP_UP_SHARE || use.tokens + (use.lastTurnTokens ?? 0) > limits.maxTokens);
  const money = limits.maxMicroUsd > 0 && use.microUsd >= limits.maxMicroUsd * WRAP_UP_SHARE;
  const turns = limits.maxTurns > 0 && use.turns >= limits.maxTurns - 1;
  if (!tokens && !money && !turns) return undefined;
  return "This attempt's allowance is nearly spent, so no more tool calls are accepted. Stop calling tools at once and write your complete final answer now from what you already have, saying what you could not check.";
}

/** Why an attempt that is still calling tools must stop now, or undefined while it is within its limits. */
export function overAllowanceReason(use: AttemptUse, limits: Allowance): string | undefined {
  const parts: string[] = [];
  if (limits.maxTokens > 0 && use.tokens > limits.maxTokens) parts.push(`${use.tokens} of ${limits.maxTokens} tokens`);
  if (overCostCap(use.microUsd, limits.maxMicroUsd)) parts.push(`${use.microUsd} of ${limits.maxMicroUsd} micro-dollars`);
  if (limits.maxTurns > 0 && use.turns > limits.maxTurns) parts.push(`${use.turns} of ${limits.maxTurns} turns`);
  return parts.length > 0 ? `the attempt used its allowance (${parts.join(", ")}) and was still calling tools, so no complete answer was written` : undefined;
}

/** The notice that ends an attempt's tool use: it names why and how many tokens are left. */
export function finalTurnNotice(why: string, tokensLeft: number): string {
  const left = Math.max(0, Math.round(tokensLeft));
  return `${why} No tools are available any more. You have about ${left.toLocaleString("en-US")} tokens left in this attempt. Write your complete final answer now, in the required format, from what you already have, and say plainly what you could not check.`;
}
