import type { PlanTask, TeamMember, Workflow } from "@brain/contracts";
import type { Store } from "../../application/store";
import { scopesForPrincipal } from "../../application/authz";
import { diffPlan, type PlanDiff } from "../../domain/mission-policy";
import { activeReleaseRecord } from "../configuration/index";
import { GENERAL_TASK_WORKFLOW } from "../workflows/task-experience";
import { reachedLimits } from "./budget";

type Db = ReturnType<Store["workspaceDb"]>;

/** The schedule an occurrence belongs to, as far as the plan gate needs to know it (ADR 0017). */
export interface RepeatSchedule {
  readonly automationId: string;
  readonly createdBy: string;
  /** The mission whose confirmed plan every occurrence repeats; absent for a schedule that names none. */
  readonly sourceMissionId?: string;
  /** The person's switch: "Confirm the plan automatically each time". */
  readonly autoConfirm: boolean;
}

export type RepeatVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly diff?: PlanDiff };

/** The plan an occurrence would run: its tasks without pinned inputs (they are per-occurrence) and its team. */
export interface RepeatPlan { readonly tasks: readonly PlanTask[]; readonly team: readonly TeamMember[] }

const strip = (tasks: readonly PlanTask[]): PlanTask[] => tasks.map(({ inputs: _inputs, ...task }) => task);
const canonical = (plan: RepeatPlan): string => JSON.stringify({ tasks: strip(plan.tasks), team: plan.team });

/** Reads the repeat settings a schedule keeps in its typed input; auto-confirmation is on unless a person turned it off. */
export function repeatSettings(inputJson: string | null): { sourceMissionId?: string; autoConfirm: boolean } {
  if (!inputJson) return { autoConfirm: true };
  try {
    const input = JSON.parse(inputJson) as { sourceMissionId?: unknown; autoConfirm?: unknown };
    return { ...(typeof input.sourceMissionId === "string" && input.sourceMissionId ? { sourceMissionId: input.sourceMissionId } : {}), autoConfirm: input.autoConfirm !== false };
  } catch { return { autoConfirm: true }; }
}

/** The first step of the plan's workflows that writes, merges or waits for an approval (read-only dispatches and evaluations are fine). */
export function effectfulStep(workflows: Readonly<Record<string, Workflow>>, workflowId: string, seen: Set<string> = new Set(), depth = 0): string | undefined {
  const workflow = workflows[workflowId];
  if (!workflow) return `workflow ${workflowId} is not in the active release`;
  if (seen.has(workflowId) || depth > 6) return undefined;
  seen.add(workflowId);
  for (const [name, job] of Object.entries(workflow.spec.jobs)) {
    if (job.kind === "gate") return `step ${name} of ${workflowId} waits for an approval`;
    if (job.kind === "merge") return `step ${name} of ${workflowId} merges changes`;
    if (job.kind === "dispatch" && job.effectClass !== "read") return `step ${name} of ${workflowId} can ${job.effectClass === "write" ? "write" : "act with privileges"}`;
    if (job.kind === "steer") return `step ${name} of ${workflowId} steers a live session`;
    if (job.kind === "subgraph") {
      const inner = effectfulStep(workflows, job.workflow.id, seen, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

const taskNames = (ids: readonly string[]): string => ids.length > 3 ? `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more` : ids.join(", ");

/** Words for what changed between the plan a person confirmed and the one the occurrence would run. */
export function describeDiff(diff: PlanDiff): string {
  const parts = [
    diff.added.length ? `added ${taskNames(diff.added)}` : "", diff.removed.length ? `removed ${taskNames(diff.removed)}` : "",
    diff.changed.length ? `changed ${taskNames(diff.changed)}` : "", diff.reassigned.length ? `reassigned ${taskNames(diff.reassigned)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "the team or tools differ";
}

/**
 * ADR 0017: may this occurrence's plan be confirmed by the schedule, on behalf of the person who created it? Every condition must
 * hold; the first one that does not is the reason a person is asked instead. The new mission already exists (so headroom is real) and
 * `proposed` is the plan it would run.
 */
export function repeatGate(store: Store, db: Db, input: { organizationId: string; workspaceId: string; schedule: RepeatSchedule; missionId: string; proposed: RepeatPlan }): RepeatVerdict {
  const { schedule, proposed } = input;
  if (!schedule.autoConfirm) return { ok: false, reason: "this schedule is set to ask you each time" };
  if (!schedule.sourceMissionId) return { ok: false, reason: "the schedule names no confirmed mission to repeat" };
  const source = db.prepare("SELECT m.state, m.outcome, p.tasks_json AS tasks, p.team_json AS team FROM missions m LEFT JOIN plan_versions p ON p.id=m.active_plan_version_id WHERE m.id=?")
    .get(schedule.sourceMissionId) as { state: string; outcome: string | null; tasks: string | null; team: string | null } | undefined;
  if (!source || source.tasks === null) return { ok: false, reason: "the mission it repeats has no confirmed plan" };
  const bundle = db.prepare("SELECT state FROM mission_evidence_bundles WHERE mission_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(schedule.sourceMissionId) as { state: string } | undefined;
  if (source.state !== "closed" || source.outcome !== "achieved" || bundle?.state !== "verified") return { ok: false, reason: "the mission it repeats was not verified as achieved" };
  const confirmed: RepeatPlan = { tasks: JSON.parse(source.tasks) as PlanTask[], team: JSON.parse(source.team ?? "[]") as TeamMember[] };
  if (canonical(confirmed) !== canonical(proposed)) {
    return { ok: false, reason: `the plan changed since you confirmed it (${describeDiff(diffPlan(strip(confirmed.tasks), strip(proposed.tasks), new Set()))})`, diff: diffPlan(strip(confirmed.tasks), strip(proposed.tasks), new Set()) };
  }
  const workflows = activeReleaseRecord(store, input.organizationId)?.release.workflows ?? {};
  for (const task of proposed.tasks) {
    const step = effectfulStep(workflows, task.workflowId ?? GENERAL_TASK_WORKFLOW);
    if (step) return { ok: false, reason: `${step}, which always needs a person` };
  }
  const mission = db.prepare("SELECT policy_json FROM missions WHERE id=?").get(input.missionId) as { policy_json: string } | undefined;
  const preset = (() => { try { return (JSON.parse(mission?.policy_json ?? "{}") as { preset?: string }).preset; } catch { return undefined; } })();
  if (preset !== "standard" && preset !== "autonomous") return { ok: false, reason: "the mission's autonomy is below standard" };
  const owner = store.control.prepare("SELECT kind, disabled_at_ms FROM principals WHERE id=? AND organization_id=?").get(schedule.createdBy, input.organizationId) as { kind: string; disabled_at_ms: number | null } | undefined;
  if (!owner || owner.kind !== "human" || owner.disabled_at_ms !== null || !scopesForPrincipal(store, schedule.createdBy, input.organizationId, input.workspaceId).includes("mission:write")) {
    return { ok: false, reason: "the person who created the schedule can no longer confirm plans here" };
  }
  const limits = reachedLimits(store, db, input.missionId);
  if (limits.length) return { ok: false, reason: `a ${limits.join(" and ")} limit leaves no room to start` };
  return { ok: true };
}
