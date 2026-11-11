import type { PlanEstimate, PlanVersion } from "@brain/contracts";
import type { Store } from "../../application/store";

type Db = ReturnType<Store["workspaceDb"]>;

/**
 * Plan-time estimates (#54), computed here and never in the browser. Totals add
 * only the tasks that declare a value and count the rest as unknown, so a
 * missing estimate is never shown as zero. The ceiling is the mission budget
 * exactly as admission enforces it: the dollar budget less the coordinator's
 * final allowance, the token ceiling and the active-time limit.
 */
export function planEstimate(plan: PlanVersion, db: Db): PlanEstimate {
  const mission = db.prepare("SELECT budget_micro_usd, budget_tokens, budget_wall_ms, final_allowance_micro_usd FROM missions WHERE id=?").get(plan.missionId) as
    { budget_micro_usd: number | null; budget_tokens: number | null; budget_wall_ms: number | null; final_allowance_micro_usd: number } | undefined;
  const tasks = plan.tasks.map((task) => ({
    taskId: task.id, title: task.title,
    ...(task.estimatedMinutes !== undefined ? { estimatedMinutes: task.estimatedMinutes } : {}),
    ...(task.maxMicroUsd !== undefined ? { maxMicroUsd: task.maxMicroUsd } : {}),
  }));
  const withMinutes = tasks.filter((task) => task.estimatedMinutes !== undefined);
  const withCost = tasks.filter((task) => task.maxMicroUsd !== undefined);
  return {
    planVersionId: plan.planVersionId, tasks, taskCount: tasks.length,
    ...(withMinutes.length > 0 ? { totalEstimatedMinutes: withMinutes.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0) } : {}),
    unknownMinutesTasks: tasks.length - withMinutes.length,
    ...(withCost.length > 0 ? { totalMicroUsd: withCost.reduce((sum, task) => sum + (task.maxMicroUsd ?? 0), 0) } : {}),
    unknownCostTasks: tasks.length - withCost.length,
    ...(mission?.budget_micro_usd != null ? { ceilingMicroUsd: Math.max(0, mission.budget_micro_usd - mission.final_allowance_micro_usd) } : {}),
    ...(mission?.budget_tokens != null ? { ceilingTokens: mission.budget_tokens } : {}),
    ...(mission?.budget_wall_ms != null ? { ceilingWallClockMs: mission.budget_wall_ms } : {}),
  };
}
