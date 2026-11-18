/** The limits of docs/model.md ("Limits"): their defaults, and what a notice says when one stops or delays work. */

/** Generous on purpose: no money cap, no cap on tasks at once (runner slots set the pace), and room for a long answer. */
export const LIMIT_DEFAULTS = {
  daily_spend_usd: 0,
  running_tasks: 0,
  healing_per_day: 5,
  turns: 100,
  tokens: 2_000_000,
  spend_usd: 0,
  max_rounds: 3,
} as const;
/** An attempt that failed for an infrastructure reason is tried again until it has been tried this many times in all. */
export const MAX_ATTEMPTS = 5;
/** The longest reply a model may write in one call, unless the agent's `tokens` is smaller. */
export const MAX_REPLY_TOKENS = 32_768;

export const LIMIT_NAMES = ["agent.turns", "agent.tokens", "agent.spend_usd", "workspace.daily_spend_usd", "workspace.running_tasks", "step.max_rounds", "attempts"] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];
/** What stopped an attempt: the limit, its value, what was used (null when not known) and, for an agent's limit, the agent. */
export interface LimitHit { readonly name: LimitName; readonly value: number; readonly used: number | null; readonly agent?: string | undefined }

export const PRIORITIES = ["low", "normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];
