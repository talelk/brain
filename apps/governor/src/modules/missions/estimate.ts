import type { PlanEstimate, PlanTask, PlanVersion } from "@brain/contracts";
import type { Store } from "../../application/store";

type Db = ReturnType<Store["workspaceDb"]>;

/** A plan may take up to this many times its own estimate, never less than the floor (ADR 0016). */
export const PLAN_TIME_FACTOR = 3;
export const PLAN_TIME_FLOOR_MS = 2 * 60 * 60_000;

/**
 * The time limit a mission has once this plan is confirmed. A limit a person named is never changed; a default limit (from a Play)
 * becomes max(current default, estimate x 3, 2 h) and only ever rises. A mission with no time limit stays without one.
 */
export function planWallLimit(current: number | null, explicit: boolean, tasks: readonly Pick<PlanTask, "estimatedMinutes">[]): { limitMs: number | null; belowEstimate: boolean; raised: boolean } {
  const estimateMs = tasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0) * 60_000;
  if (current === null) return { limitMs: null, belowEstimate: false, raised: false };
  if (explicit) return { limitMs: current, belowEstimate: estimateMs > current, raised: false };
  const limitMs = Math.max(current, estimateMs * PLAN_TIME_FACTOR, PLAN_TIME_FLOOR_MS);
  return { limitMs, belowEstimate: false, raised: limitMs > current };
}

/**
 * Plan-time estimates (#54), computed here and never in the browser. Totals add
 * only the tasks that declare a value and count the rest as unknown, so a
 * missing estimate is never shown as zero. The ceiling is the mission budget
 * exactly as admission enforces it: the dollar budget less the coordinator's
 * final allowance, the token ceiling and the working-time limit as it will be
 * once this plan is confirmed (ADR 0016).
 */
export function planEstimate(plan: PlanVersion, db: Db): PlanEstimate {
  const mission = db.prepare("SELECT budget_micro_usd, budget_tokens, budget_wall_ms, budget_wall_explicit, final_allowance_micro_usd FROM missions WHERE id=?").get(plan.missionId) as
    { budget_micro_usd: number | null; budget_tokens: number | null; budget_wall_ms: number | null; budget_wall_explicit: number; final_allowance_micro_usd: number } | undefined;
  const tasks = plan.tasks.map((task) => ({
    taskId: task.id, title: task.title,
    ...(task.estimatedMinutes !== undefined ? { estimatedMinutes: task.estimatedMinutes } : {}),
    ...(task.maxMicroUsd !== undefined ? { maxMicroUsd: task.maxMicroUsd } : {}),
  }));
  const withMinutes = tasks.filter((task) => task.estimatedMinutes !== undefined);
  const withCost = tasks.filter((task) => task.maxMicroUsd !== undefined);
  const wall = planWallLimit(mission?.budget_wall_ms ?? null, mission?.budget_wall_explicit === 1, plan.tasks);
  return {
    planVersionId: plan.planVersionId, tasks, taskCount: tasks.length,
    ...(withMinutes.length > 0 ? { totalEstimatedMinutes: withMinutes.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0) } : {}),
    unknownMinutesTasks: tasks.length - withMinutes.length,
    ...(withCost.length > 0 ? { totalMicroUsd: withCost.reduce((sum, task) => sum + (task.maxMicroUsd ?? 0), 0) } : {}),
    unknownCostTasks: tasks.length - withCost.length,
    ...(mission?.budget_micro_usd != null ? { ceilingMicroUsd: Math.max(0, mission.budget_micro_usd - mission.final_allowance_micro_usd) } : {}),
    ...(mission?.budget_tokens != null ? { ceilingTokens: mission.budget_tokens } : {}),
    ...(wall.limitMs !== null ? { ceilingWallClockMs: wall.limitMs } : {}),
    ...(wall.belowEstimate ? { timeLimitBelowEstimate: true } : {}),
  };
}
