import type { EstimateBasis, PlanEstimate, PlanTask, PlanVersion } from "@brain/contracts";
import type { Store } from "../../application/store";
import { DEFAULT_TASK_TOKEN_CAP } from "../../domain/failure";
import { GENERAL_TASK_WORKFLOW } from "../workflows/index";
import { wayOfWorking } from "./outcomes";
import { ALL_SPEND } from "./usage";

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

/** A task's own history needs at least this many completed runs before its median replaces what the planner declared. */
export const ESTIMATE_MIN_RUNS = 3;
/** The 25th-75th percentile range is shown only from this many runs: fewer say too little about the spread. */
export const ESTIMATE_RANGE_MIN_RUNS = 4;
/** Only the most recent completed runs count, so an old way of working stops weighing on today's estimate. */
export const ESTIMATE_WINDOW = 25;

/** The value at fraction `q` of an ascending list, interpolating between neighbours and rounding to a whole number (q = 0.5 is the median). */
export function quantile(ascending: readonly number[], q: number): number {
  const at = (ascending.length - 1) * q, below = Math.floor(at), above = Math.ceil(at);
  return Math.round((ascending[below] ?? 0) + ((ascending[above] ?? 0) - (ascending[below] ?? 0)) * (at - below));
}

type Sample = { microUsd: number; ms: number };
type History = { source: "play-task" | "workflow"; samples: Sample[] };
type Figure = { value: number; basis: EstimateBasis };

/**
 * The completed runs of one kind of task: Done work items of other missions with their settled attempts (the usage ledger), newest first,
 * bounded by the window. A run's cost is what its attempts settled. Its time is the span of its attempts, from the ledger's reservation (the
 * claim) to the release of the runner's capacity (the attempt's end); the ledger's own settlement time is no measure, as a sweep settles
 * later.
 */
function samplesOf(store: Store, db: Db, missionId: string, where: string, ...params: unknown[]): Sample[] {
  const items = (db.prepare(`SELECT wi.id AS id FROM work_items wi JOIN missions m ON m.id=wi.mission_id
    WHERE wi.state='done' AND wi.mission_id != ? AND ${where}
      AND EXISTS (SELECT 1 FROM execution_links el JOIN ${ALL_SPEND} s ON s.run_id=el.run_id WHERE el.work_item_id=wi.id AND s.source='attempt' AND s.settled_at_ms IS NOT NULL)
    ORDER BY wi.updated_at_ms DESC, wi.id LIMIT ?`).all(missionId, ...params as never[], ESTIMATE_WINDOW) as Array<{ id: string }>).map((row) => row.id);
  return items.map((id) => {
    const attempts = db.prepare(`SELECT s.attempt_id AS attemptId, s.settled_micro_usd AS microUsd, s.created_at_ms AS startedAtMs
      FROM execution_links el JOIN ${ALL_SPEND} s ON s.run_id=el.run_id WHERE el.work_item_id=? AND s.source='attempt' AND s.settled_at_ms IS NOT NULL`).all(id) as Array<{ attemptId: string; microUsd: number | null; startedAtMs: number }>;
    const ended = store.control.prepare(`SELECT released_at_ms AS at FROM capacity_reservations WHERE attempt_id=?`);
    return {
      microUsd: attempts.reduce((sum, attempt) => sum + (attempt.microUsd ?? 0), 0),
      ms: attempts.reduce((sum, attempt) => sum + Math.max(0, ((ended.get(attempt.attemptId) as { at: number | null } | undefined)?.at ?? attempt.startedAtMs) - attempt.startedAtMs), 0),
    };
  });
}

/**
 * The past runs an estimate for this task rests on: the same Play task first, else the same way of working (its workflow: the task's own,
 * else the workspace's default, else the general task workflow, as ADR 0022 resolves it; a task given to a team member's agent has none
 * of its own); none when neither has enough runs.
 */
function historyOf(store: Store, db: Db, missionId: string, playId: string | null, task: PlanTask, defaultWorkflowId: string): History | undefined {
  if (playId) {
    const samples = samplesOf(store, db, missionId, "m.play_id=? AND wi.plan_task_id=?", playId, task.id);
    if (samples.length >= ESTIMATE_MIN_RUNS) return { source: "play-task", samples };
  }
  const workflowId = task.workflowId ?? (task.assignment?.kind === "agent" ? undefined : defaultWorkflowId);
  if (workflowId) {
    const samples = samplesOf(store, db, missionId, "COALESCE(wi.workflow_id, CASE WHEN json_extract(wi.assignment_json,'$.kind')='agent' THEN NULL ELSE ? END)=?", defaultWorkflowId, workflowId);
    if (samples.length >= ESTIMATE_MIN_RUNS) return { source: "workflow", samples };
  }
  return undefined;
}

/** The median of past runs with its range, or what the planner declared, or nothing. `unit` converts a raw value to the figure's own unit. */
function figureOf(history: History | undefined, pick: (sample: Sample) => number, unit: (raw: number) => number, declared: number | undefined): Figure | undefined {
  if (history) {
    const values = history.samples.map(pick).sort((a, b) => a - b);
    const runs = values.length;
    return { value: unit(quantile(values, 0.5)), basis: { kind: "history", runs, source: history.source, ...(runs >= ESTIMATE_RANGE_MIN_RUNS ? { low: unit(quantile(values, 0.25)), high: unit(quantile(values, 0.75)) } : {}) } };
  }
  return declared !== undefined ? { value: declared, basis: { kind: "declared" } } : undefined;
}

/** The plan's total over the tasks that have a figure: one basis when they agree, mixed when they do not, none with no figure. The range sums each task's range (a declared figure is its own range). */
function totalOf(figures: readonly (Figure | undefined)[]): { total: number; basis: EstimateBasis } | undefined {
  const known = figures.filter((figure): figure is Figure => figure !== undefined);
  if (known.length === 0) return undefined;
  const kinds = new Set(known.map((figure) => figure.basis.kind));
  const histories = known.filter((figure) => figure.basis.kind === "history");
  const ranged = histories.some((figure) => figure.basis.low !== undefined);
  return { total: known.reduce((sum, figure) => sum + figure.value, 0), basis: {
    kind: kinds.size === 1 ? (kinds.has("history") ? "history" : "declared") : "mixed",
    ...(histories.length > 0 ? { runs: Math.min(...histories.map((figure) => figure.basis.runs ?? 0)) } : {}),
    ...(ranged ? { low: known.reduce((sum, figure) => sum + (figure.basis.low ?? figure.value), 0), high: known.reduce((sum, figure) => sum + (figure.basis.high ?? figure.value), 0) } : {}),
  } };
}

const minutesOf = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/**
 * Plan-time estimates (#54, #132), computed here and never in the browser. Each task's figure is the median of its past completed runs in
 * this workspace (the same Play task, else the same workflow; at least ESTIMATE_MIN_RUNS of them, the newest ESTIMATE_WINDOW), else what the
 * planner declared, else unknown; every figure carries its basis. Deterministic arithmetic over the usage ledger: no model computes it and it
 * never changes a budget. Totals add only the tasks that have a figure and count the rest as unknown, so a missing estimate is never shown
 * as zero. The ceiling is the mission budget exactly as admission enforces it: the dollar budget less the coordinator's final allowance,
 * the token ceiling and the working-time limit as it will be once this plan is confirmed (ADR 0016). A suggested budget is offered only
 * when history informs the estimate; a person decides whether to take it.
 */
export function planEstimate(plan: PlanVersion, store: Store, db: Db, workspaceId: string): PlanEstimate {
  const mission = db.prepare("SELECT budget_micro_usd, budget_tokens, budget_wall_ms, budget_wall_explicit, final_allowance_micro_usd, play_id FROM missions WHERE id=?").get(plan.missionId) as
    { budget_micro_usd: number | null; budget_tokens: number | null; budget_wall_ms: number | null; budget_wall_explicit: number; final_allowance_micro_usd: number; play_id: string | null } | undefined;
  const defaultWorkflowId = wayOfWorking(store, workspaceId)?.workflowId ?? GENERAL_TASK_WORKFLOW;
  // Every candidate of a best-of-N task spends up to the task's ceiling (ADR 0071), so a declared cost counts them all.
  const rows = plan.tasks.map((task) => {
    const history = historyOf(store, db, plan.missionId, mission?.play_id ?? null, task, defaultWorkflowId);
    return { task, time: figureOf(history, (sample) => sample.ms, minutesOf, task.estimatedMinutes), cost: figureOf(history, (sample) => sample.microUsd, (raw) => raw, task.maxMicroUsd === undefined ? undefined : task.maxMicroUsd * (task.candidates?.length ?? 1)) };
  });
  const tasks = rows.map(({ task, time, cost }) => ({
    taskId: task.id, title: task.title,
    ...(time ? { estimatedMinutes: time.value, timeBasis: time.basis } : {}),
    ...(cost ? { microUsd: cost.value, costBasis: cost.basis } : {}),
  }));
  const time = totalOf(rows.map((row) => row.time));
  const cost = totalOf(rows.map((row) => row.cost));
  const wall = planWallLimit(mission?.budget_wall_ms ?? null, mission?.budget_wall_explicit === 1, plan.tasks);
  const belowEstimate = wall.limitMs !== null && mission?.budget_wall_explicit === 1 && (time?.total ?? 0) * 60_000 > wall.limitMs;
  const fromHistory = (basis: EstimateBasis | undefined): boolean => basis !== undefined && basis.kind !== "declared";
  const suggestedMicroUsd = cost && fromHistory(cost.basis) && (cost.basis.high ?? cost.total) > 0 ? (cost.basis.high ?? cost.total) + (mission?.final_allowance_micro_usd ?? 0) : undefined;
  const suggestedWallClockMs = time && fromHistory(time.basis) ? (time.basis.high ?? time.total) * 60_000 * PLAN_TIME_FACTOR : undefined;
  return {
    planVersionId: plan.planVersionId, tasks, taskCount: tasks.length,
    ...(time ? { totalEstimatedMinutes: time.total } : {}),
    unknownMinutesTasks: rows.filter((row) => row.time === undefined).length,
    timeBasis: time?.basis ?? { kind: "unknown" },
    ...(cost ? { totalMicroUsd: cost.total } : {}),
    unknownCostTasks: rows.filter((row) => row.cost === undefined).length,
    costBasis: cost?.basis ?? { kind: "unknown" },
    taskTokenCap: DEFAULT_TASK_TOKEN_CAP,
    ...(mission?.budget_micro_usd != null ? { ceilingMicroUsd: Math.max(0, mission.budget_micro_usd - mission.final_allowance_micro_usd) } : {}),
    ...(mission?.budget_tokens != null ? { ceilingTokens: mission.budget_tokens } : {}),
    ...(wall.limitMs !== null ? { ceilingWallClockMs: wall.limitMs } : {}),
    ...(belowEstimate ? { timeLimitBelowEstimate: true } : {}),
    ...(suggestedMicroUsd !== undefined ? { suggestedMicroUsd } : {}),
    ...(suggestedWallClockMs !== undefined ? { suggestedWallClockMs } : {}),
  };
}
