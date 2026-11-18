import type { AttemptUsage, SnapshotManifest, Spend, Usage } from "@brain/contracts";
import type { Governor } from "../app";
import type { Db } from "../db";
import type { Gov } from "../dispatch";
import { utcDay, type AttemptRow } from "../tasks/store";
import { activeManifest } from "../workspace/store";

/**
 * The usage ledger: one row per attempt. Claiming an attempt reserves the most its agent may spend; the model gateway adds what each model
 * call used as it happens; the end of the attempt settles the row, after which the reservation no longer counts. The workspace's daily cap
 * is judged on settled cost plus what open attempts hold.
 */
/** What an attempt is known to have cost so far. */
export const COST = "COALESCE(u.settled_micro_usd, u.metered_micro_usd)";
/** What an attempt counts for against the daily cap: its cost once settled, until then the larger of its reservation and what the gateway measured. */
const HELD = "COALESCE(u.settled_micro_usd, MAX(u.reserved_micro_usd, u.metered_micro_usd))";

export const microUsd = (usd: number): number => Math.round(usd * 1_000_000);
export const capOf = (manifest: SnapshotManifest): number => microUsd(manifest.limits.daily_spend_usd);

export function spentToday(gov: Pick<Gov, "db" | "clock">, workspaceId: string): number {
  return (gov.db.prepare(`SELECT COALESCE(SUM(${HELD}), 0) AS n FROM usage u WHERE u.workspace_id=? AND u.day=?`).get(workspaceId, utcDay(gov.clock.nowMs())) as { n: number }).n;
}
/** What the workspace has spent today besides what `attemptId` itself holds: its own reservation must not count against the cap it is admitted under. */
export function spentBesides(gov: Pick<Gov, "db" | "clock">, workspaceId: string, attemptId: string): number {
  const own = gov.db.prepare(`SELECT ${HELD} AS held, COALESCE(u.metered_micro_usd, 0) AS metered FROM usage u WHERE u.attempt_id=?`).get(attemptId) as { held: number; metered: number } | undefined;
  return spentToday(gov, workspaceId) - (own?.held ?? 0) + (own?.metered ?? 0);
}
/** True when the workspace's daily cap leaves no room for `more`. A cap of 0 is no cap. */
export function overCap(gov: Gov, workspaceId: string, manifest: SnapshotManifest, more: number): boolean {
  const cap = capOf(manifest);
  return cap > 0 && spentToday(gov, workspaceId) + more > cap;
}

/** Reserves what the attempt may spend, on the day it is claimed. An attempt claimed again keeps what the gateway already measured. */
export function reserveUsage(gov: Gov, attempt: AttemptRow, model: string | null, reservedMicroUsd: number): void {
  const now = gov.clock.nowMs();
  gov.db.prepare(`INSERT INTO usage(attempt_id, workspace_id, task_id, agent, model, day, reserved_micro_usd, created_at_ms) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET reserved_micro_usd=excluded.reserved_micro_usd, day=excluded.day`).run(attempt.id, attempt.workspace_id, attempt.task_id, attempt.agent, model, utcDay(now), reservedMicroUsd, now);
}

/** Adds what one model call used, as the gateway read it from the model's own answer. */
export function meterUsage(db: Db, attemptId: string, model: string, used: AttemptUsage): void {
  db.prepare(`UPDATE usage SET model=?, input_tokens=input_tokens+?, output_tokens=output_tokens+?, cached_input_tokens=cached_input_tokens+?, metered_micro_usd=metered_micro_usd+? WHERE attempt_id=?`)
    .run(model, used.inputTokens, used.outputTokens, used.cachedInputTokens, used.microUsd, attemptId);
}

/** Settles an attempt's row when it ends. The gateway's token counts stand when it measured any; the cost is the larger of what it measured and what the runner reports. */
export function settleUsage(gov: Gov, attemptId: string, reported?: AttemptUsage): void {
  const metered = gov.db.prepare("SELECT input_tokens + output_tokens AS tokens FROM usage WHERE attempt_id=?").get(attemptId) as { tokens: number } | undefined;
  if (!metered) return;
  const tokens = reported && metered.tokens === 0 ? reported : undefined;
  gov.db.prepare(`UPDATE usage SET settled_micro_usd=MAX(metered_micro_usd, ?), settled_at_ms=?, input_tokens=COALESCE(?, input_tokens), output_tokens=COALESCE(?, output_tokens),
    cached_input_tokens=COALESCE(?, cached_input_tokens) WHERE attempt_id=?`).run(reported?.microUsd ?? 0, gov.clock.nowMs(), tokens?.inputTokens ?? null, tokens?.outputTokens ?? null, tokens?.cachedInputTokens ?? null, attemptId);
}

export const spendOf = (gov: Gov, workspaceId: string): Spend => ({ todayMicroUsd: spentToday(gov, workspaceId), capMicroUsd: capOf(activeManifest(gov, workspaceId)) });

const SUMS = `COALESCE(SUM(${COST}), 0) AS microUsd, COALESCE(SUM(u.input_tokens), 0) AS inputTokens, COALESCE(SUM(u.output_tokens), 0) AS outputTokens, COALESCE(SUM(u.cached_input_tokens), 0) AS cachedInputTokens`;
/** The usage of some attempts: `where` is a condition on `usage u`. */
export function usageWhere(db: Db, where: string, ...values: unknown[]): Usage {
  return db.prepare(`SELECT ${SUMS} FROM usage u WHERE ${where}`).get(...values) as Usage;
}

export function registerUsage({ gov: { registry } }: Governor): void {
  registry.query("usage.summary", (ctx, input) => {
    const since = utcDay(ctx.now() - (input.days - 1) * 86_400_000);
    const by = <K extends string>(column: string, key: K) =>
      ctx.db.prepare(`SELECT ${column} AS ${key}, ${SUMS} FROM usage u WHERE u.workspace_id=? AND u.day>=? GROUP BY 1 ORDER BY 1`).all(input.workspaceId, since) as Array<Usage & Record<K, string>>;
    return {
      spend: spendOf(ctx.gov, input.workspaceId), total: usageWhere(ctx.db, "u.workspace_id=? AND u.day>=?", input.workspaceId, since),
      byDay: by("u.day", "day"), byAgent: by("u.agent", "agent"), byModel: by("COALESCE(u.model, '')", "model"),
    };
  });
}
