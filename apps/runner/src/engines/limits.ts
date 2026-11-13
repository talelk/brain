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

/** Tool calls an attempt may make when its task lists no acceptance criteria; the agent's own turn limit is the upper bound. */
export const DEFAULT_TOOL_CALLS = 8;
const FEWEST_TOOL_CALLS = 3;
const MOST_TOOL_CALLS = 12;
/** Repeated identical reads an attempt may make before its tools are taken away: each one costs a whole turn and tells the model nothing new. */
export const REPEAT_BUDGET = 2;

/** How many acceptance criteria the task lists (numbered lines after the last "Acceptance criteria:"), counting 1, 2, 3... in order; a task shown as JSON has its line breaks as `\n`. */
export function criteriaIn(task: string): number {
  const at = task.lastIndexOf("Acceptance criteria:");
  if (at < 0) return 0;
  let count = 0;
  const lines = task.slice(at + "Acceptance criteria:".length).split(/\\n|\n/u);
  for (const line of lines) {
    const numbered = /^\s*(\d{1,2})\.\s/u.exec(line);
    if (!numbered) { if (count > 0 && line.trim() === "") break; continue; }
    if (Number(numbered[1]) !== count + 1) break;
    count += 1;
  }
  return count;
}

/**
 * The most tool calls one attempt may make, from its task. Every call is a model turn that re-sends the whole prompt (about 6k tokens before
 * any work), so looking is paid for per call: one call for each criterion and one to check (3 to 12), 8 when the task lists no criteria, and
 * never more than the agent's own turn limit.
 */
export function toolCallCeiling(task: string, maxTurns: number): number {
  const criteria = criteriaIn(task);
  const wanted = criteria === 0 ? DEFAULT_TOOL_CALLS : Math.min(MOST_TOOL_CALLS, Math.max(FEWEST_TOOL_CALLS, 1 + criteria));
  return maxTurns > 0 ? Math.min(maxTurns, wanted) : wanted;
}

/** The notice that ends an attempt's tool use: it names why, says how many tokens are left and what to write for what was not checked. */
export function finalTurnNotice(why: string, tokensLeft: number): string {
  const left = Math.max(0, Math.round(tokensLeft));
  return `${why} No tools are available any more. You have about ${left.toLocaleString("en-US")} tokens left in this attempt. Write your complete final answer now, in the required format, from what you already have. For anything you could not check or that the tools did not show, set "met" to false and say so plainly instead of searching further.`;
}

/** What the model is told before its first turn about the limits of this attempt. */
export function attemptLimitsNotice(calls: number, maxTokens: number): string {
  return `[Limits of this attempt, set by Brain: at most ${calls} tool calls and about ${maxTokens.toLocaleString("en-US")} tokens, counting every turn. A call that answered is enough: do not repeat it. If a criterion asks for something the tools do not return (a field a command does not print), say so in the answer with "met": false instead of searching for it. The tools are removed when the calls or the tokens run low; then write the answer.]`;
}
