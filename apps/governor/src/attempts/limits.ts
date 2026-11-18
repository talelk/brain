import { LIMIT_DEFAULTS, type AttemptFailure, type AttemptUsage, type LimitHit } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { taskOf, type AttemptRow } from "../tasks/store";
import { capOf, COST, microUsd, spentToday } from "../trust/usage";
import { activeManifest, manifestOf } from "../workspace/store";

/** What stopped an attempt that failed: the limit, its value and what was used (docs/model.md, Limits). A failure no limit explains is returned as it came. */
export function withLimit(gov: Gov, attempt: AttemptRow, failure: AttemptFailure, reported: AttemptUsage): AttemptFailure {
  if (failure.infrastructure || failure.reason === "stopped") return failure;
  const manifest = manifestOf(gov, taskOf(gov.db, attempt.task_id).snapshot_digest);
  const limits = manifest.agents[attempt.agent]?.limits ?? { turns: LIMIT_DEFAULTS.turns, tokens: LIMIT_DEFAULTS.tokens, spend_usd: LIMIT_DEFAULTS.spend_usd };
  const row = gov.db.prepare(`SELECT COALESCE(u.input_tokens + u.output_tokens, 0) AS tokens, COALESCE(${COST}, 0) AS micro FROM usage u WHERE u.attempt_id=?`).get(attempt.id) as { tokens: number; micro: number } | undefined;
  const tokens = Math.max(row?.tokens ?? 0, reported.inputTokens + reported.outputTokens);
  const micro = Math.max(row?.micro ?? 0, reported.microUsd);
  const hit = (limit: LimitHit): AttemptFailure => ({ ...failure, reason: "limit", limit });
  const agent = { agent: attempt.agent };
  const active = activeManifest(gov, attempt.workspace_id);
  const cap = capOf(active);
  // The money limits explain only a refusal or an end the attempt chose; a failed setup or a lost runner has other causes.
  const refused = failure.reason === "limit" || failure.reason === "model-refused" || failure.reason === "engine";
  if (!refused) return failure;
  if (cap > 0 && spentToday(gov, attempt.workspace_id) >= cap) return hit({ name: "workspace.daily_spend_usd", value: active.limits.daily_spend_usd, used: spentToday(gov, attempt.workspace_id) / 1_000_000 });
  if (limits.spend_usd > 0 && micro >= microUsd(limits.spend_usd) * 0.98) return hit({ name: "agent.spend_usd", value: limits.spend_usd, used: micro / 1_000_000, ...agent });
  if (failure.reason !== "limit") return failure;
  if (limits.tokens > 0 && tokens >= limits.tokens * 0.9) return hit({ name: "agent.tokens", value: limits.tokens, used: tokens, ...agent });
  return limits.turns > 0 ? hit({ name: "agent.turns", value: limits.turns, used: null, ...agent }) : failure;
}
