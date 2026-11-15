import { domainDigest, roleScopes } from "@brain/contracts";
import type { AcceptedDecision, ActorContext, AutonomyPolicy, AutonomyPreset, ExecutionLink, JsonValue, Mission, MissionBrief, MissionOutcome, OutputInput, PlanAssignment, PlanOperation, PlanTask, PlanVersion, TeamMember, WorkItem, WorkItemPriority, WorkItemState } from "@brain/contracts";
import type { Store } from "../../application/store";
import { hasWorkspaceMembership, requireWorkspaceRead, scopesForPrincipal } from "../../application/authz";
import { assertExpectedVersion, assertTransition, transitionState } from "../../domain/states";
import { assertPlanTasks } from "../../domain/work-plan";
import { JOB_PRIORITY, normalizeTags } from "../../domain/work-priority";
import { assertServedCriteria, criteriaFromText, criteriaCoverage, parseCriteria } from "../../domain/criteria";
import { AUTONOMY_PRESETS, assertMembersBound, assertTeamEligible, beyondPolicy, diffPlan, policyFor, teamOperations, withinCeiling, type AgentCapabilities } from "../../domain/mission-policy";
import { activeReleaseRecord } from "../configuration/index";
import { repeatGate, type RepeatPlan, type RepeatSchedule } from "./repeat";
import { pump, wake, coordinatorInput, type CoordinatorPort } from "./coordinator";
import { admit, admitChallenge, admitOutsideMission, budgetOf, DEFAULT_MISSION_BUDGET, hasHeadroom, limitChangeNote, minutesWord, reserve as reserveSpend, settle, settleAll, usageOf } from "./budget";
import { missionTaskTrust } from "./task-trust";
import { agentUsage, capReached, memberUsage, missionBreakdown, missionUsage, outsideMissionsUsage, runUsage, SERIES_MAX_DAYS, setSpendCap, spendCapOf, spendSeries, verifiedCost, taskUsage, workspaceUsage } from "./usage";
import { planEstimate, planWallLimit } from "./estimate";
import { listEvalCases, recordEvalCase } from "./eval-cases";
import { listComments, recordComment } from "./comments";
import { questionOf, recordQuestion } from "./questions";
import { listPullRequests } from "./pull-requests";
import { listMessages, listOutputs, outputDetail, pinInputs, recordOutputVersion, recordTaskResult, sendMessage, taskOf, taskResult, verifyOutputs } from "./outputs";
import { readVerified } from "../artifacts/index";
import { assembleMissionBundle, type ServedCriterion, dependencyHandoffs, finalizeHandoff, latestMissionBundle, needsSignOff, recordMissionVerdict, submitHandoff, trustForBundle, workflowCovers } from "../evidence/index";
import type { HandoffNotes } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { OUTAGE_MAX_WAITS, OUTAGE_WAIT_MS, QUOTA_MAX_WAITS, REMEDY, classifyFailure, lessonText, quotaWaitMs, waitWords, type FailureClass } from "../../domain/failure";
import { GENERAL_TASK_WORKFLOW } from "../workflows/index";
import { modelRoutesUsable } from "../jobs/index";
import { missionTimeline } from "./timeline";
import { observedCalls, taskTokenCap, taskTokens, wayOfWorking, workflowAgentTools, workflowsCovering } from "./outcomes";

/** The optional narrowing of `workItems.list`: one mission, one team member (by member id), one priority, one tag. */
interface WorkItemFilter { missionId?: string; memberId?: string; priority?: string; tag?: string }

export interface MissionCommand {
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly expectedVersion?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

type MissionRow = {
  id: string; title: string; intent: string; success_criteria_json: string; owner_id: string;
  active_plan_version_id: string | null; state: Mission["state"]; pause_reason: "human" | "budget" | null; stop_note: string | null;
  outcome: MissionOutcome | null; brief_version: number; policy_json: string; parking_threshold: number; auto_start: number;
  budget_micro_usd: number | null; budget_wall_ms: number | null; member_cap: number; attempt_reserve_micro_usd: number; final_allowance_micro_usd: number; budget_tokens: number | null; attempt_reserve_tokens: number;
  coordinator_member_id: string | null; coordinator_workflow: string | null; play_id: string | null;
  budget_wall_explicit: number; wall_extended: number;
  version: number; created_at_ms: number; updated_at_ms: number;
};
type BriefRow = { mission_id: string; version: number; intent: string; constraints_json: string; change: string; rebased_from: number | null; created_by: string; created_at_ms: number };
type DecisionRow = { id: string; mission_id: string; statement: string; source_kind: AcceptedDecision["source"]["kind"]; source_ref: string | null; accepted_by: string; introduced_version: number; superseded_by: string | null; created_at_ms: number };

/** At most this many verified outputs of an earlier mission seed a new plan, each shown to a task as at most this many characters. */
const PINNED_INPUT_LIMIT = 6;
const PINNED_INPUT_CHARS = 4000;
/** Work that has started is never changed or abandoned by replanning (issue #39). */
const STARTED: ReadonlySet<WorkItemState> = new Set(["in-progress", "review", "blocked", "done"]);
/** What each shipped check of the task validator means in words; an unknown check keeps its own id. */
const CHECK_WORDS: Readonly<Record<string, string>> = {
  structure: "the report does not have the required structure",
  safety: "the report claims actions it must not take",
  deliverable: "there is no real deliverable (it copies the brief, asks a question, or is too short)",
  "criteria-met": "not every acceptance criterion is answered, with evidence",
};
/** The team member a task is assigned to, when it is assigned to an agent; the machine principal of its sessions is that member's (ADR 0032). */
/** The mission and member of a delegated child's run (ADR 0053), which is no task's run; undefined for any other run. */
const delegatedRunOf = (db: ReturnType<Store["workspaceDb"]>, runId: string): { missionId: string; memberId: string | null } | undefined =>
  db.prepare("SELECT mission_id AS missionId, member_id AS memberId FROM delegation_runs WHERE run_id=?").get(runId) as { missionId: string; memberId: string | null } | undefined;
const memberOf = (assignmentJson: string | null): string | null => {
  const assignment = assignmentJson ? JSON.parse(assignmentJson) as PlanAssignment : undefined;
  return assignment?.kind === "agent" ? assignment.id : null;
};
/** Parked work is stopped, not running: a person may re-plan it (edit, reassign, run it with another recipe), which replaces the parked item. */
const isStarted = (row: { state: WorkItemState; parked?: number }): boolean => STARTED.has(row.state) && !(row.state === "blocked" && row.parked === 1);
/** Lessons stay with the planner this long. */
const LESSON_TTL_MS = 90 * 86_400_000;
/** Tools a task must observe: its own declaration, else the workspace's way of working. */
const effectiveTools = (task: PlanTask, defaults: { requiredTools: readonly string[] } | undefined): string[] => [...new Set(task.requiredTools ?? defaults?.requiredTools ?? [])].sort();
/** The written sections every session receives stay small (issue #34). */
const BRIEF_CHAR_CAP = 8000;
type PlanRow = {
  id: string; mission_id: string; revision: number; digest: string; state: PlanVersion["state"];
  origin: PlanVersion["origin"]; created_by: string; summary: string | null; tasks_json: string; team_json: string;
  created_at_ms: number; confirmed_at_ms: number | null;
};
type WorkItemRow = {
  id: string; mission_id: string; plan_version_id: string; plan_task_id: string; title: string;
  state: WorkItemState; criteria_json: string; assignment_json: string | null; workflow_id: string | null;
  next_action: string; blocked_reason: string | null; scheduled_at_ms: number | null; evidence_digest: string | null;
  failed_attempts: number; parked: number; parked_diagnostic: string | null;
  required_tools_json: string; failure_class: FailureClass | null; token_cap: number | null; retry_after_ms: number | null;
  priority: WorkItemPriority; tags_json: string; due_at_ms: number | null;
  version: number; created_at_ms: number; updated_at_ms: number;
};

/** A person's new priority reaches the runs already started for the work: their later steps and their queued jobs follow. Bound at the composition root. */
export interface RunPriorityPort {
  setRunPriority(organizationId: string, workspaceId: string, runId: string, jobPriority: number): void;
}

/** Live message delivery is the sessions module's, bound at the composition root. */
export interface MissionDeliveryPort {
  deliver(organizationId: string, workspaceId: string, messageId: string, interrupt: boolean): unknown;
}

/** The blocked reason of a task stopped because its agent was interrupted too often; the interface offers Try again for it. */
export const PARKED_INTERRUPTED_REASON = "Stopped: waiting for you to try again";

/** Undelivered messages one team member's session may have waiting (ADR 0042). */
const MAX_PENDING_TEAMMATE_MESSAGES = 5;

export class MissionService {
  constructor(private readonly store: Store, private readonly delivery?: MissionDeliveryPort, private readonly coordinatorPort?: CoordinatorPort, private readonly capitalization?: { requestMissionRun(organizationId: string, workspaceId: string, missionId: string): string }, private readonly runs?: RunPriorityPort) {}

  /** Starts coordinator runs for pending wakes across active workspaces (maintenance pass). */
  pumpCoordinators(): number {
    let started = 0;
    for (const ws of this.store.control.prepare("SELECT id, organization_id FROM workspaces WHERE status='active'").all() as Array<{ id: string; organization_id: string }>) {
      try { started += pump(this.store, this.store.workspaceDb(ws.id, ws.organization_id), ws.organization_id, ws.id, this.coordinatorPort); } catch { /* one workspace never blocks another */ }
    }
    return started;
  }

  static coordinatorInput = coordinatorInput;

  /** The current brief of a mission, as every session of it receives it. */
  briefOf(actor: ActorContext, workspaceId: string, missionId: string): MissionBrief {
    return this.brief(actor, workspaceId, this.missionRow(actor, workspaceId, missionId));
  }

  private db(actor: ActorContext, workspaceId: string) {
    requireWorkspaceRead(this.store, actor, workspaceId);
    return this.store.workspaceDb(workspaceId, actor.organizationId);
  }

  private organizationOf(workspaceId: string): string {
    const row = this.store.control.prepare("SELECT organization_id FROM workspaces WHERE id=?").get(workspaceId) as { organization_id: string } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "workspace not found");
    return row.organization_id;
  }

  private missionRow(actor: ActorContext, workspaceId: string, id: string): MissionRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM missions WHERE id=?").get(id) as MissionRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "mission not found");
    return row;
  }

  private planRow(actor: ActorContext, workspaceId: string, id: string): PlanRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM plan_versions WHERE id=?").get(id) as PlanRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "plan version not found");
    return row;
  }

  private workItemRow(actor: ActorContext, workspaceId: string, id: string): WorkItemRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM work_items WHERE id=?").get(id) as WorkItemRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "work item not found");
    return row;
  }

  private mission(workspaceId: string, row: MissionRow): Mission {
    const db = this.store.workspaceDb(workspaceId, this.organizationOf(workspaceId));
    settle(this.store, db, row.id);
    const taskTrust = missionTaskTrust(this.store, this.organizationOf(workspaceId), db, row.id);
    // The newest plan version still waiting for a person (a Play's starting plan, or a coordinator's proposal beyond its policy).
    const pending = db.prepare("SELECT id FROM plan_versions WHERE mission_id=? AND state='proposed' ORDER BY revision DESC LIMIT 1").get(row.id) as { id: string } | undefined;
    return {
      ...(taskTrust ? { taskTrust } : {}),
      budget: budgetOf(row), usage: usageOf(this.store, db, row, this.store.now()),
      subjects: (db.prepare("SELECT pack, kind, subject_id FROM mission_subjects WHERE mission_id=? ORDER BY kind, subject_id").all(row.id) as Array<{ pack: "support" | "sre"; kind: "ticket" | "incident"; subject_id: string }>).map((entry) => ({ pack: entry.pack, kind: entry.kind, id: entry.subject_id })),
      missionId: row.id, workspaceId, title: row.title, intent: row.intent, ...(row.play_id ? { playId: row.play_id } : {}), ...(row.coordinator_member_id ? { coordinatorMemberId: row.coordinator_member_id } : {}),
      successCriteria: this.coverage(db, row), ownerId: row.owner_id,
      ...(row.active_plan_version_id ? { activePlanVersionId: row.active_plan_version_id } : {}),
      ...(pending ? { pendingPlanVersionId: pending.id } : {}),
      state: row.state, ...(row.stop_note ? { pauseReason: "stopped" as const, pauseNote: row.stop_note } : row.pause_reason ? { pauseReason: row.pause_reason } : {}), ...(row.outcome ? { outcome: row.outcome } : {}),
      briefVersion: row.brief_version, autonomyPolicy: JSON.parse(row.policy_json) as AutonomyPolicy, parkingThreshold: row.parking_threshold, autoStart: row.auto_start === 1,
      ...(row.wall_extended === 1 ? { timeExtendedByBrain: true } : {}),
      version: row.version, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  /** Each success criterion with whether the work serving it is done, read from the confirmed plan and its latest live work item per task (ADR 0034). */
  private coverage(db: ReturnType<Store["workspaceDb"]>, row: MissionRow): Mission["successCriteria"] {
    const { tasks, latest } = this.confirmedWork(db, row);
    return criteriaCoverage(parseCriteria(row.success_criteria_json), tasks, new Set([...latest].filter(([, item]) => item.state === "done").map(([taskId]) => taskId)));
  }

  /** The confirmed plan's tasks and the latest live work item of each (a retained item keeps its old plan version, so the plan task id is the key). */
  private confirmedWork(db: ReturnType<Store["workspaceDb"]>, row: MissionRow): { tasks: PlanTask[]; latest: Map<string, { id: string; state: WorkItemState }> } {
    const plan = row.active_plan_version_id ? db.prepare("SELECT tasks_json FROM plan_versions WHERE id=?").get(row.active_plan_version_id) as { tasks_json: string } | undefined : undefined;
    const latest = new Map<string, { id: string; state: WorkItemState }>();
    for (const item of db.prepare("SELECT id, plan_task_id, state FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY created_at_ms DESC, id DESC").all(row.id) as Array<{ id: string; plan_task_id: string; state: WorkItemState }>) {
      if (!latest.has(item.plan_task_id)) latest.set(item.plan_task_id, { id: item.id, state: item.state });
    }
    return { tasks: plan ? JSON.parse(plan.tasks_json) as PlanTask[] : [], latest };
  }

  /** Each criterion with the live work items of the confirmed plan tasks that serve it: what the mission evidence bundle records coverage from. */
  private servedCriteria(db: ReturnType<Store["workspaceDb"]>, row: MissionRow): ServedCriterion[] {
    const { tasks, latest } = this.confirmedWork(db, row);
    return parseCriteria(row.success_criteria_json).map((criterion) => ({
      criterionId: criterion.id, text: criterion.text,
      workItemIds: tasks.filter((task) => (task.criterionIds ?? []).includes(criterion.id)).flatMap((task) => latest.get(task.id)?.id ?? []),
    }));
  }

  private plan(workspaceId: string, row: PlanRow): PlanVersion {
    return {
      planVersionId: row.id, missionId: row.mission_id, workspaceId, revision: row.revision,
      digest: row.digest, state: row.state, origin: row.origin, createdBy: row.created_by,
      ...(row.summary ? { summary: row.summary } : {}), tasks: JSON.parse(row.tasks_json) as PlanTask[],
      ...(row.team_json !== "[]" ? { team: JSON.parse(row.team_json) as TeamMember[] } : {}),
      createdAt: iso(row.created_at_ms), ...(row.confirmed_at_ms ? { confirmedAt: iso(row.confirmed_at_ms) } : {}),
    };
  }

  private workItem(actor: ActorContext, workspaceId: string, row: WorkItemRow): WorkItem {
    const dependsOn = this.effectiveDependencies(this.db(actor, workspaceId), row.id).map((entry) => entry.id).sort();
    return {
      workItemId: row.id, missionId: row.mission_id, planVersionId: row.plan_version_id,
      planTaskId: row.plan_task_id, workspaceId, title: row.title, state: row.state,
      criteria: JSON.parse(row.criteria_json) as string[], dependsOn,
      ...(row.assignment_json ? { assignment: JSON.parse(row.assignment_json) as PlanAssignment } : {}),
      ...(row.workflow_id ? { workflowId: row.workflow_id } : {}), nextAction: row.next_action,
      ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
      ...(row.parked === 1 && row.parked_diagnostic ? { parkedDiagnostic: row.parked_diagnostic } : {}),
      ...(row.scheduled_at_ms ? { scheduledAt: iso(row.scheduled_at_ms) } : {}),
      ...(row.evidence_digest ? { evidenceDigest: row.evidence_digest } : {}),
      failedAttempts: row.failed_attempts, parked: row.parked === 1,
      ...(JSON.parse(row.required_tools_json) as string[]).length > 0 ? { requiredTools: JSON.parse(row.required_tools_json) as string[] } : {},
      ...(row.failure_class ? { failureClass: row.failure_class, remedy: REMEDY[row.failure_class] } : {}),
      tokenCap: taskTokenCap(row), tokensUsed: taskTokens(this.store, this.store.workspaceDb(workspaceId, actor.organizationId), row.id),
      priority: row.priority, tags: JSON.parse(row.tags_json) as string[],
      ...(row.due_at_ms !== null ? { dueAt: iso(row.due_at_ms) } : {}),
      // A board flag derived on read, never stored: an open item past its due date. It raises no attention item and notifies nobody.
      ...(row.due_at_ms !== null && row.due_at_ms < this.store.now() && row.state !== "done" && row.state !== "abandoned" ? { overdue: true as const } : {}),
      version: row.version, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  apply(actor: ActorContext, command: MissionCommand): string {
    const workspaceId = command.workspaceId;
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    switch (command.commandType) {
      case "mission.create": return this.createMission(actor, workspaceId, command.payload);
      case "mission.pause": case "mission.resume": case "mission.proposeCompletion": case "mission.close":
        return this.changeState(actor, workspaceId, command.commandType, command.payload, command.expectedVersion);
      case "mission.brief.edit": return this.editBrief(actor, workspaceId, command.payload);
      case "decision.accept": return this.acceptDecision(actor, workspaceId, command.payload);
      case "mission.policy.set": return this.setPolicy(actor, workspaceId, command.payload, command.expectedVersion);
      case "mission.message.send": return this.message(actor, workspaceId, command.payload);
      case "mission.question.ask": return this.ask(actor, workspaceId, command.payload);
      case "mission.owner.transfer": return this.transferOwner(actor, workspaceId, command.payload, command.expectedVersion);
      case "mission.budget.set": return this.setBudget(actor, workspaceId, command.payload, command.expectedVersion);
      case "workspace.spendCap.set": return this.setSpendCap(actor, workspaceId, command.payload);
      case "workItem.spendCap.raise": return this.raiseTaskCap(actor, workspaceId, command.payload);
      case "handoff.submit": return this.handoff(actor, workspaceId, command.payload);
      case "mission.verdict.record": return this.verdict(actor, workspaceId, command.payload);
      case "plan.propose": return this.proposePlan(actor, workspaceId, command.payload);
      case "plan.confirm": return this.confirmPlan(actor, workspaceId, command.payload, command.expectedVersion);
      case "plan.reject": return this.rejectPlan(actor, workspaceId, command.payload);
      case "workItem.transition": return this.transition(actor, workspaceId, command.payload, command.expectedVersion);
      case "workItem.comment": return this.comment(actor, workspaceId, command.payload);
      case "workItem.details.set": return this.setDetails(actor, workspaceId, command.payload, command.expectedVersion);
      default: throw new BrainDomainError("INVALID_CONTRACT", `unsupported work command ${command.commandType}`);
    }
  }

  private createMission(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const db = this.db(actor, workspaceId);
    const id = this.store.id("mission");
    const release = payload["playId"] ? activeReleaseRecord(this.store, actor.organizationId) : undefined;
    const play = payload["playId"] ? release?.release.plays?.[String(payload["playId"])] : undefined;
    if (payload["playId"] && !play) throw new BrainDomainError("NOT_FOUND", `play ${String(payload["playId"])} is not in the active release`);
    const intent = String(payload["intent"] ?? play?.spec.intent ?? "");
    if (!intent) throw new BrainDomainError("INVALID_ARGUMENT", "a mission needs an intent");
    const successCriteria = (payload["successCriteria"] as string[] | undefined) ?? play?.spec.successCriteria;
    if (!successCriteria || successCriteria.length === 0) throw new BrainDomainError("INVALID_ARGUMENT", "a mission needs success criteria");
    const constraints = (payload["constraints"] as string[] | undefined) ?? play?.spec.constraints ?? [];
    assertBriefSize(intent, constraints, []);
    const preset = (payload["autonomy"] as AutonomyPreset | undefined) ?? play?.spec.autonomy ?? "standard";
    const policy = withinCeiling(policyFor(preset, 1), this.ceiling(workspaceId));
    this.store.inTx(db, () => {
      const now = this.store.now();
      const budget = (payload["budget"] as { maxMicroUsd?: number; maxWallClockMs?: number; memberCap?: number; attemptReserveMicroUsd?: number; finalAllowanceMicroUsd?: number; maxTokens?: number; attemptReserveTokens?: number } | undefined) ?? play?.spec.budget ?? DEFAULT_MISSION_BUDGET;
      db.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,policy_json,parking_threshold,auto_start,budget_micro_usd,budget_wall_ms,member_cap,attempt_reserve_micro_usd,budget_wall_explicit,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, String(payload["title"]), intent, JSON.stringify(criteriaFromText(successCriteria)), actor.actorId, JSON.stringify(policy), Number(payload["parkingThreshold"] ?? play?.spec.parkingThreshold ?? 3), payload["autoStart"] === false ? 0 : 1,
          budget.maxMicroUsd ?? null, budget.maxWallClockMs ?? null, budget.memberCap ?? 3, budget.attemptReserveMicroUsd ?? 0, payload["budget"] !== undefined && budget.maxWallClockMs !== undefined ? 1 : 0, now, now);
      if (budget.finalAllowanceMicroUsd) db.prepare("UPDATE missions SET final_allowance_micro_usd=? WHERE id=?").run(budget.finalAllowanceMicroUsd, id);
      db.prepare("UPDATE missions SET budget_tokens=?,attempt_reserve_tokens=? WHERE id=?").run(budget.maxTokens ?? null, budget.attemptReserveTokens ?? 0, id);
      db.prepare("INSERT INTO mission_brief_versions(mission_id,version,intent,constraints_json,change,created_by,created_at_ms) VALUES (?,1,?,?,'created',?,?)")
        .run(id, intent, JSON.stringify(constraints), actor.actorId, now);
      for (const subject of (payload["subjects"] as Array<{ pack: string; kind: "ticket" | "incident"; id: string }> | undefined) ?? []) {
        // A mission is about subjects its packs own; it never invents one (#24).
        const table = subject.kind === "ticket" ? "tickets" : "incidents";
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(subject.id)) throw new BrainDomainError("NOT_FOUND", `${subject.kind} ${subject.id} not found`);
        db.prepare("INSERT OR IGNORE INTO mission_subjects(mission_id,pack,kind,subject_id) VALUES (?,?,?,?)").run(id, subject.pack, subject.kind, subject.id);
      }
      if (play && release) db.prepare("UPDATE missions SET play_id=?,play_release_digest=?,coordinator_member_id=?,coordinator_workflow=?,final_allowance_micro_usd=? WHERE id=?")
        .run(String(payload["playId"]), release.digest, play.spec.coordinator ?? null, play.spec.coordinatorWorkflow ?? null, budget.finalAllowanceMicroUsd ?? play.spec.budget?.finalAllowanceMicroUsd ?? 0, id);
      this.store.emit(db, { aggregateType: "mission", aggregateId: id, eventType: "mission.created", payload: { missionId: id } });
    });
    if (play) this.proposePlan(actor, workspaceId, { missionId: id, origin: "template", summary: `From play ${String(payload["playId"])}`, tasks: play.spec.plan.tasks, team: play.spec.team });
    return id;
  }

  /** The workspace's autonomy ceiling: no mission policy may grant more (#35). */
  private ceiling(workspaceId: string): readonly PlanOperation[] {
    const row = this.store.control.prepare("SELECT autonomy_ceiling_json FROM workspaces WHERE id=?").get(workspaceId) as { autonomy_ceiling_json: string | null } | undefined;
    // No ceiling set means the workspace allows every plan operation.
    return row?.autonomy_ceiling_json ? JSON.parse(row.autonomy_ceiling_json) as PlanOperation[] : [...AUTONOMY_PRESETS.autonomous];
  }

  private proposePlan(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertNotClosed(mission);
    const tasks = payload["tasks"] as unknown as PlanTask[];
    // A session that does not name a team keeps the confirmed one: it cannot see the team, and leaving it out must not dissolve it.
    const named = payload["team"] as TeamMember[] | undefined;
    const team = named ?? (actor.kind === "agent" && mission.active_plan_version_id ? JSON.parse(this.planRow(actor, workspaceId, mission.active_plan_version_id).team_json) as TeamMember[] : []);
    assertPlanTasks(tasks);
    assertServedCriteria(tasks, new Set(parseCriteria(mission.success_criteria_json).map((criterion) => criterion.id)));
    assertTeamEligible(team, tasks, this.agentCapabilities(actor.organizationId));
    this.assertWayOfWorking(actor.organizationId, workspaceId, tasks);
    const gate = this.gate(actor, workspaceId, mission, tasks, team);
    const db = this.db(actor, workspaceId);
    const id = this.store.id("plan");
    const origin = String(payload["origin"]) as PlanVersion["origin"];
    const summary = payload["summary"] ? String(payload["summary"]) : undefined;
    const digest = domainDigest("brain:plan-version:v1", { missionId: mission.id, origin, summary: summary ?? null, tasks, team } as unknown as JsonValue);
    this.store.inTx(db, () => {
      const revision = (db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM plan_versions WHERE mission_id=?").get(mission.id) as { next: number }).next;
      db.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,summary,tasks_json,team_json,created_at_ms) VALUES (?,?,?,?,'proposed',?,?,?,?,?,?)")
        .run(id, mission.id, revision, digest, origin, actor.actorId, summary ?? null, JSON.stringify(tasks), JSON.stringify(team), this.store.now());
      this.store.emit(db, { aggregateType: "plan", aggregateId: id, eventType: "plan.proposed", payload: { missionId: mission.id, planVersionId: id, digest } });
    });
    if (gate.autoConfirm) {
      this.confirmPlan(actor, workspaceId, { planVersionId: id }, mission.version, true);
      this.store.emit(db, { aggregateType: "plan", aggregateId: id, eventType: "plan.autoConfirmed", payload: { missionId: mission.id, planVersionId: id, digest } });
    }
    return id;
  }

  /**
   * Started work is identical across versions for every author. A coordinator
   * (agent) version of a mission that already has confirmed work is confirmed
   * without a human only when every operation it needs is in the mission's
   * autonomy policy; otherwise it stays a plan proposal (issue #35).
   */
  private gate(actor: ActorContext, workspaceId: string, mission: MissionRow, tasks: readonly PlanTask[], team: readonly TeamMember[]): { autoConfirm: boolean; beyond: readonly PlanOperation[] } {
    if (!mission.active_plan_version_id) return { autoConfirm: false, beyond: [] };
    const db = this.db(actor, workspaceId);
    const active = this.planRow(actor, workspaceId, mission.active_plan_version_id);
    const confirmed = JSON.parse(active.tasks_json) as PlanTask[];
    // Retained work keeps its original plan version, so started work is read per mission.
    const started = new Set((db.prepare("SELECT plan_task_id AS id, state, parked FROM work_items WHERE mission_id=? AND state!='abandoned'").all(mission.id) as Array<{ id: string; state: WorkItemState; parked: number }>)
      .filter(isStarted).map((row) => row.id));
    const diff = diffPlan(confirmed, tasks, started);
    assertMembersBound(JSON.parse(active.team_json) as TeamMember[], team, tasks);
    const policy = JSON.parse(mission.policy_json) as AutonomyPolicy;
    const beyond = [...new Set([...beyondPolicy(diff, policy), ...teamOperations(JSON.parse(active.team_json) as TeamMember[], team).filter((operation) => !policy.operations.includes(operation))])].sort();
    return { autoConfirm: actor.kind === "agent" && mission.state === "active" && beyond.length === 0, beyond };
  }

  /**
   * A person turns down a plan proposal (#43): it becomes rejected, leaves the
   * attention queue, and the coordinator wakes with the reason. The confirmed
   * version and its work are untouched.
   */
  private rejectPlan(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person rejects a plan proposal");
    const plan = this.planRow(actor, workspaceId, String(payload["planVersionId"]));
    if (plan.state !== "proposed") throw new BrainDomainError("CONFLICT", "only a proposed plan version can be rejected");
    const reason = String(payload["reason"] ?? "").trim();
    if (!reason) throw new BrainDomainError("INVALID_ARGUMENT", "a rejection needs a reason");
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      transitionState(db, "planVersion", plan.id, "rejected", {});
      db.prepare("UPDATE planning_requests SET state='failed',error=?,updated_at_ms=? WHERE plan_version_id=?").run(`Rejected: ${reason}`.slice(0, 1024), this.store.now(), plan.id);
      this.store.emit(db, { aggregateType: "plan", aggregateId: plan.id, eventType: "plan.rejected", payload: { missionId: plan.mission_id, planVersionId: plan.id, reason } });
      wake(this.store, db, plan.mission_id, "plan-resolved", `Proposal rejected: ${reason}`);
    });
    return plan.id;
  }

  private confirmPlan(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number, withinPolicy = false): string {
    const plan = this.planRow(actor, workspaceId, String(payload["planVersionId"]));
    const mission = this.missionRow(actor, workspaceId, plan.mission_id);
    assertExpectedVersion(mission.version, expectedVersion);
    if (!withinPolicy && actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "a plan proposal beyond the autonomy policy needs human confirmation");
    if (mission.state === "closed" || mission.state === "verifying") throw new BrainDomainError("CONFLICT", `a ${mission.state} mission takes no new plan version`);
    if (plan.state !== "proposed") throw new BrainDomainError("CONFLICT", "only a proposed plan version can be confirmed");
    const tasks = JSON.parse(plan.tasks_json) as PlanTask[];
    assertPlanTasks(tasks);
    assertServedCriteria(tasks, new Set(parseCriteria(mission.success_criteria_json).map((criterion) => criterion.id)));
    const team = JSON.parse(plan.team_json) as TeamMember[];
    // The release may have changed since the version was proposed: eligibility holds at confirmation too.
    assertTeamEligible(team, tasks, this.agentCapabilities(actor.organizationId));
    this.assertWayOfWorking(actor.organizationId, workspaceId, tasks);
    this.gate(actor, workspaceId, mission, tasks, team);
    const db = this.db(actor, workspaceId);
    const defaults = wayOfWorking(this.store, workspaceId);
    this.store.inTx(db, () => {
      const priorActive = mission.active_plan_version_id;
      if (priorActive) transitionState(db, "planVersion", priorActive, "superseded");
      // An older proposal this version was edited from (or that it overtakes) is no longer a live proposal: left open it would come back as the plan to confirm.
      for (const open of db.prepare("SELECT id FROM plan_versions WHERE mission_id=? AND state='proposed' AND revision<? AND id!=?").all(mission.id, plan.revision, plan.id) as Array<{ id: string }>) transitionState(db, "planVersion", open.id, "superseded");
      const previous = db.prepare("SELECT * FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY created_at_ms DESC,id DESC").all(mission.id) as WorkItemRow[];
      const latestByTask = new Map<string, WorkItemRow>();
      for (const item of previous) if (!latestByTask.has(item.plan_task_id)) latestByTask.set(item.plan_task_id, item);
      const selected = new Map<string, string>();
      const retained = new Set<string>();
      const now = this.store.now();
      for (const task of tasks) {
        const prior = latestByTask.get(task.id);
        // A task's latest live work item is kept whatever plan version made it: a second re-plan must not start finished work again.
        if (prior && this.sameTask(db, prior, task, effectiveTools(task, defaults))) {
          selected.set(task.id, prior.id);
          retained.add(prior.id);
          continue;
        }
        const id = this.store.id("work");
        selected.set(task.id, id);
        const state: WorkItemState = task.dependsOn.length === 0 ? "ready" : "backlog";
        // Failed attempts follow the plan task across members: reassignment never resets the parking count.
        const carried = prior && prior.state !== "done" ? prior.failed_attempts : 0;
        // What a person set on the task (priority, tags, due date) follows the task to its new work item, like the token cap.
        db.prepare(`INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,assignment_json,workflow_id,next_action,failed_attempts,required_tools_json,token_cap,priority,tags_json,due_at_ms,created_at_ms,updated_at_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, mission.id, plan.id, task.id, task.title, state, JSON.stringify(task.criteria),
          task.assignment ? JSON.stringify(task.assignment) : null, task.workflowId ?? null,
          state === "ready" ? "Start this task" : "Wait for predecessor completion", carried, JSON.stringify(effectiveTools(task, defaults)), prior?.token_cap ?? null,
          prior?.priority ?? "normal", prior?.tags_json ?? "[]", prior?.due_at_ms ?? null, now, now);
      }
      for (const item of previous) {
        if (retained.has(item.id) || isStarted(item)) continue;
        transitionState(db, "workItem", item.id, "abandoned", { set: { next_action: `Superseded by plan revision ${plan.revision}`, updated_at_ms: now }, bumpVersion: true });
      }
      // Every selected item's edges follow the items this plan selected. A retained task keeps its work item but not its old edges:
      // a dependency that was replaced is a new item, and an edge left on the abandoned one would never be done.
      for (const task of tasks) {
        const workItemId = selected.get(task.id);
        if (!workItemId) continue;
        if (retained.has(workItemId)) db.prepare("DELETE FROM work_item_dependencies WHERE work_item_id=?").run(workItemId);
        for (const dependency of task.dependsOn) {
          const dependencyId = selected.get(dependency);
          if (!dependencyId) throw new BrainDomainError("INTERNAL_ERROR", "confirmed plan dependency was not materialized");
          db.prepare("INSERT INTO work_item_dependencies(work_item_id,depends_on_work_item_id) VALUES (?,?)").run(workItemId, dependencyId);
        }
      }
      this.releaseReadyItems(db, mission.id, ["backlog"]);
      transitionState(db, "planVersion", plan.id, "confirmed", { set: { confirmed_at_ms: now } });
      // A default time limit follows the plan it now has to fit (ADR 0016); a limit a person named stays as it is.
      const wall = planWallLimit(mission.budget_wall_ms, mission.budget_wall_explicit === 1, tasks);
      if (wall.raised && wall.limitMs !== null) {
        db.prepare("UPDATE missions SET budget_wall_ms=? WHERE id=?").run(wall.limitMs, mission.id);
        this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.budgetChanged", payload: { missionId: mission.id, by: "brain", note: `Time limit set to ${minutesWord(wall.limitMs)} to fit the plan` } });
      }
      db.prepare("UPDATE missions SET active_plan_version_id=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(plan.id, now, mission.id, mission.version);
      this.store.emit(db, { aggregateType: "plan", aggregateId: plan.id, eventType: "plan.confirmed", payload: { missionId: mission.id, planVersionId: plan.id, digest: plan.digest } });
      if (!withinPolicy) wake(this.store, db, mission.id, "plan-resolved", `plan revision ${plan.revision} confirmed`);
    });
    return plan.id;
  }

  /**
   * ADR 0022: a task that needs tools must be planned on a way of working whose agent has them. The way of working is the task's
   * own workflow, else the workspace's default, else the general task workflow; a plan that names a tool its way of working lacks is refused.
   */
  private assertWayOfWorking(organizationId: string, workspaceId: string, tasks: readonly PlanTask[]): void {
    const defaults = wayOfWorking(this.store, workspaceId);
    for (const task of tasks) {
      if (task.assignment?.kind === "agent") continue; // a team member's agent is checked by team eligibility
      const tools = effectiveTools(task, defaults);
      if (tools.length === 0) continue;
      const workflowId = task.workflowId ?? defaults?.workflowId ?? GENERAL_TASK_WORKFLOW;
      const have = workflowAgentTools(this.store, organizationId, workflowId);
      if (have === undefined) continue; // an unknown workflow is reported when the task starts
      const missing = tools.filter((tool) => !have.includes(tool));
      if (missing.length > 0) {
        const alternatives = workflowsCovering(this.store, organizationId, tools);
        throw new BrainDomainError("INVALID_ARGUMENT", `task ${task.id} needs ${missing.join(", ")} but its way of working ${workflowId} lacks ${missing.length === 1 ? "it" : "them"}${alternatives.length ? `; use ${alternatives.slice(0, 3).join(" or ")}` : ""}`);
      }
    }
  }

  /**
   * A person sets a work item's priority, tags and due date (#116). A field left out stays; a null due date clears it. Priority changes the
   * order work is claimed in and nothing else: Done keeps its evidence rule (ADR 0022). The runs already started for the item follow at once.
   */
  private setDetails(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person sets a work item's priority, tags or due date");
    const item = this.workItemRow(actor, workspaceId, String(payload["workItemId"]));
    assertExpectedVersion(item.version, expectedVersion);
    if (item.state === "abandoned") throw new BrainDomainError("CONFLICT", "a replaced work item takes no changes");
    const priority = (payload["priority"] === undefined ? item.priority : String(payload["priority"])) as WorkItemPriority;
    if (!(priority in JOB_PRIORITY)) throw new BrainDomainError("INVALID_ARGUMENT", `unknown priority ${priority}`);
    const tags = payload["tags"] === undefined ? item.tags_json : JSON.stringify(normalizeTags(payload["tags"] as unknown[]));
    const dueAtMs = payload["dueAt"] === undefined ? item.due_at_ms : payload["dueAt"] === null ? null : Date.parse(String(payload["dueAt"]));
    if (dueAtMs !== null && !Number.isFinite(dueAtMs)) throw new BrainDomainError("INVALID_ARGUMENT", "dueAt must be a date and time");
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("UPDATE work_items SET priority=?,tags_json=?,due_at_ms=?,version=version+1,updated_at_ms=? WHERE id=?").run(priority, tags, dueAtMs, this.store.now(), item.id);
      if (priority !== item.priority) {
        for (const link of db.prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").all(item.id) as Array<{ run_id: string }>) this.runs?.setRunPriority(actor.organizationId, workspaceId, link.run_id, JOB_PRIORITY[priority]);
      }
      this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.detailsSet", payload: { workItemId: item.id, priority } });
    });
    return item.id;
  }

  /** The job priority a run dispatched for this work item starts with. */
  jobPriorityOf(actor: ActorContext, workspaceId: string, workItemId: string): number {
    return JOB_PRIORITY[this.workItemRow(actor, workspaceId, workItemId).priority];
  }

  /** An owner raises the token cap of one task; a task parked for budget is released to try again. */
  private raiseTaskCap(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person raises a task's spend cap");
    const item = this.workItemRow(actor, workspaceId, String(payload["workItemId"]));
    const maxTokens = Number(payload["maxTokens"]);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new BrainDomainError("INVALID_ARGUMENT", "maxTokens must be a positive integer");
    if (maxTokens <= taskTokenCap(item)) throw new BrainDomainError("INVALID_ARGUMENT", `the cap is ${taskTokenCap(item)} tokens; raise it above that`);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("UPDATE work_items SET token_cap=?,version=version+1,updated_at_ms=? WHERE id=?").run(maxTokens, this.store.now(), item.id);
      this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.spendCapRaised", payload: { workItemId: item.id, maxTokens } });
      if (item.parked === 1 && item.failure_class === "budget") {
        transitionState(db, "workItem", item.id, "ready", { set: { parked: 0, failed_attempts: 0, parked_diagnostic: null, blocked_reason: null, failure_class: null, next_action: "Retrying: the token cap was raised", updated_at_ms: this.store.now() }, bumpVersion: true });
        this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.unparked", payload: { workItemId: item.id, state: "ready" } });
      }
    });
    return item.id;
  }

  private sameTask(db: ReturnType<Store["workspaceDb"]>, prior: WorkItemRow, task: PlanTask, tools: readonly string[]): boolean {
    if (prior.title !== task.title || prior.workflow_id !== (task.workflowId ?? null)) return false;
    if (prior.required_tools_json !== JSON.stringify(tools)) return false;
    if (JSON.stringify(JSON.parse(prior.criteria_json)) !== JSON.stringify(task.criteria)) return false;
    if (JSON.stringify(prior.assignment_json ? JSON.parse(prior.assignment_json) : null) !== JSON.stringify(task.assignment ?? null)) return false;
    const dependencies = db.prepare("SELECT w.plan_task_id AS id FROM work_item_dependencies d JOIN work_items w ON w.id=d.depends_on_work_item_id WHERE d.work_item_id=? ORDER BY w.plan_task_id").all(prior.id) as Array<{ id: string }>;
    return JSON.stringify(dependencies.map((entry) => entry.id)) === JSON.stringify([...task.dependsOn].sort());
  }

  private transition(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const item = this.workItemRow(actor, workspaceId, String(payload["workItemId"]));
    assertExpectedVersion(item.version, expectedVersion);
    const next = String(payload["state"]) as WorkItemState;
    assertTransition("workItem", item.state, next);
    if (item.parked === 1 && actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a human unparks a parked work item");
    const db = this.db(actor, workspaceId);
    const reason = payload["reason"] ? String(payload["reason"]) : undefined;
    if (next === "blocked" && !reason) throw new BrainDomainError("INVALID_ARGUMENT", "a blocked work item needs a reason");
    this.store.inTx(db, () => {
      if (next === "ready") this.assertDependenciesDone(db, item.id);
      const evidenceDigest = payload["evidenceDigest"] ? String(payload["evidenceDigest"]) : item.evidence_digest;
      const signedOff = next === "done" ? this.assertEvidence(db, item, evidenceDigest, actor) : false;
      if (next === "done") finalizeHandoff(db, item.id, evidenceDigest as string);
      const nextAction = next === "done" ? "No further action" : next === "review" ? "Review verified results" : next === "blocked" ? reason ?? "Resolve blocker" : next === "ready" ? "Start this task" : next === "in-progress" ? "Complete and submit evidence" : next === "abandoned" ? "Superseded or abandoned" : "Wait for predecessor completion";
      const unpark = item.parked === 1 && next !== "blocked";
      const resetCount = unpark || next === "review" || next === "done";
      transitionState(db, "workItem", item.id, next, { set: { blocked_reason: next === "blocked" ? reason : null, evidence_digest: evidenceDigest ?? null, next_action: nextAction, updated_at_ms: this.store.now(), ...(resetCount ? { failed_attempts: 0 } : {}), ...(unpark ? { parked: 0, parked_diagnostic: null, failure_class: null, retry_after_ms: null } : {}), ...(next === "done" ? { failure_class: null, retry_after_ms: null } : {}) }, bumpVersion: true, and: { version: item.version } });
      if (unpark) this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.unparked", payload: { workItemId: item.id, state: next } });
      // A task sent back from review is a rejected sign-off on that task (issue #64).
      if (item.state === "review" && next === "in-progress") recordEvalCase(this.store, db, { workspaceId, source: `sent-back:${item.id}:${item.version}`, kind: "task-sent-back", missionId: item.mission_id, workItemId: item.id, findings: reason ? [reason] : [] });
      this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.transitioned", payload: { workItemId: item.id, state: next, ...(evidenceDigest ? { evidenceDigest } : {}), ...(signedOff ? { signedOffBy: actor.actorId } : {}) } });
      if (next === "done") { this.recordHealed(db, item); verifyOutputs(db, item.id); this.releaseReadyItems(db, item.mission_id); wake(this.store, db, item.mission_id, "work-verified", item.title); }
    });
    return item.id;
  }

  /**
   * What a work item waits for, in one place: the live item behind each edge. An edge left on an abandoned item (a replaced task, an old plan)
   * follows that task to the item that took its place, and gates nothing when the plan dropped the task. Nothing waits on work nobody does.
   */
  private effectiveDependencies(db: ReturnType<Store["workspaceDb"]>, workItemId: string): Array<{ id: string; state: string }> {
    const edges = db.prepare("SELECT w.id,w.state,w.mission_id,w.plan_task_id FROM work_item_dependencies d JOIN work_items w ON w.id=d.depends_on_work_item_id WHERE d.work_item_id=?").all(workItemId) as Array<{ id: string; state: string; mission_id: string; plan_task_id: string }>;
    const live = new Map<string, { id: string; state: string }>();
    for (const edge of edges) {
      if (edge.state !== "abandoned") { live.set(edge.id, { id: edge.id, state: edge.state }); continue; }
      const next = db.prepare("SELECT id,state FROM work_items WHERE mission_id=? AND plan_task_id=? AND state!='abandoned' ORDER BY created_at_ms DESC,id DESC LIMIT 1").get(edge.mission_id, edge.plan_task_id) as { id: string; state: string } | undefined;
      if (next) live.set(next.id, next);
    }
    return [...live.values()];
  }

  private assertDependenciesDone(db: ReturnType<Store["workspaceDb"]>, workItemId: string): void {
    const pending = this.effectiveDependencies(db, workItemId).filter((entry) => entry.state !== "done");
    if (pending.length > 0) throw new BrainDomainError("CONFLICT", `work item dependencies are not complete: ${pending.map((entry) => entry.id).join(", ")}`);
  }

  /** Done needs verified evidence; criteria supported only by model opinion also need a person (returns true when this person signs them off). */
  private assertEvidence(db: ReturnType<Store["workspaceDb"]>, item: WorkItemRow, digest: string | null, by: ActorContext): boolean {
    if (!digest) throw new BrainDomainError("EVIDENCE_MISSING", "Done requires verified evidence");
    const needed = JSON.parse(item.required_tools_json) as string[];
    if (needed.length > 0 && observedCalls(this.store, db, item.id, needed).succeeded === 0) {
      throw new BrainDomainError("EVIDENCE_MISSING", `Done requires a successful recorded call of ${needed.join(" or ")}; none was recorded, so nothing was observed`);
    }
    const bundle = db.prepare("SELECT state,manifest_json,job_id FROM evidence_bundles WHERE digest=?").get(digest) as { state: string; manifest_json: string; job_id: string } | undefined;
    if (!bundle || bundle.state !== "verified") throw new BrainDomainError("EVIDENCE_MISSING", "Done requires a verified evidence bundle");
    if (!this.producedByLinkedExecution(db, item.id, bundle.job_id)) throw new BrainDomainError("EVIDENCE_MISSING", "this evidence bundle was not produced by a run of this work item; bind the evidence of its own run");
    if (!db.prepare("SELECT 1 FROM verification_verdicts WHERE bundle_digest=? AND outcome='verified'").get(digest)) throw new BrainDomainError("EVIDENCE_MISSING", "evidence has no accepted independent verdict");
    const manifest = JSON.parse(bundle.manifest_json) as { checks?: Array<{ criterionId: string; status: string }> };
    const passed = new Set((manifest.checks ?? []).filter((check) => check.status === "passed").map((check) => check.criterionId));
    const criteria = JSON.parse(item.criteria_json) as string[];
    const missing = criteria.filter((criterion) => !passed.has(criterion) && !workflowCovers(manifest.checks, criteria));
    if (missing.length > 0) throw new BrainDomainError("EVIDENCE_MISSING", `verified evidence does not cover criteria: ${missing.join(", ")}`);
    const trust = trustForBundle(this.store, by.organizationId, db, digest);
    if (!trust || !needsSignOff(trust)) return false;
    if (by.kind !== "human") throw new BrainDomainError("EVIDENCE_MISSING", `Unverified: ${trust.unverified.join(", ")} rest on a model's opinion alone, so a person must sign off before this is Done`);
    return true;
  }

  /** The bundle's job belongs to a run (or session job) linked to this work item through its execution links. */
  producedByLinkedExecution(db: ReturnType<Store["workspaceDb"]>, workItemId: string, jobId: string): boolean {
    const links = db.prepare("SELECT run_id, job_id FROM execution_links WHERE work_item_id=?").all(workItemId) as Array<{ run_id: string; job_id: string | null }>;
    if (links.some((link) => link.job_id === jobId)) return true;
    const job = this.store.control.prepare("SELECT workflow_run_id FROM jobs WHERE id=?").get(jobId) as { workflow_run_id: string | null } | undefined;
    return job?.workflow_run_id != null && links.some((link) => link.run_id === job.workflow_run_id);
  }

  private releaseReadyItems(db: ReturnType<Store["workspaceDb"]>, missionId: string, states: readonly ("backlog" | "blocked")[] = ["backlog", "blocked"]): void {
    const candidates = db.prepare(`SELECT id FROM work_items WHERE mission_id=? AND parked=0 AND state IN (${states.map(() => "?").join(",")})`).all(missionId, ...states) as Array<{ id: string }>;
    for (const candidate of candidates) {
      const pending = this.effectiveDependencies(db, candidate.id).some((entry) => entry.state !== "done");
      if (!pending) transitionState(db, "workItem", candidate.id, "ready", { set: { blocked_reason: null, next_action: "Start this task", updated_at_ms: this.store.now() }, bumpVersion: true });
    }
  }

  private comment(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const item = this.workItemRow(actor, workspaceId, String(payload["workItemId"]));
    const mission = this.missionRow(actor, workspaceId, item.mission_id);
    const team = mission.active_plan_version_id ? (JSON.parse(this.planRow(actor, workspaceId, mission.active_plan_version_id).team_json) as TeamMember[]).map((member) => member.memberId) : [];
    const serving = item.assignment_json ? (JSON.parse(item.assignment_json) as { id?: string }).id : undefined;
    // Only a person's comment on live work is sent to the team (a mission message, ADR 0003); every comment is part of the thread.
    const { commentId, messageId } = recordComment(this.store, this.db(actor, workspaceId), {
      workItemId: item.id, missionId: mission.id, authorId: actor.actorId, text: String(payload["text"]), serving, team,
      send: actor.kind === "human" && mission.state !== "closed" && item.state !== "abandoned",
      ...(payload["correctionOf"] ? { correctionOf: String(payload["correctionOf"]) } : {}),
    });
    if (messageId) this.delivery?.deliver(actor.organizationId, workspaceId, messageId, false);
    return commentId;
  }

  /** Published agent definitions of the organization's active release, as eligibility sees them. */
  private agentCapabilities(organizationId: string): Record<string, AgentCapabilities> {
    const agents = activeReleaseRecord(this.store, organizationId)?.release.agents ?? {};
    return Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, { tools: agent.spec.tools.map((tool) => tool.id), engines: [...agent.spec.engine.anyOf], maxMicroUsd: agent.spec.maxMicroUsd }]));
  }

  /**
   * A scheduled Play start. The occurrence is a real mission started on behalf of the person who set up the automation, so ownership
   * and notification follow them. When the schedule repeats a finished mission, the occurrence takes that mission's budget and autonomy
   * and its plan is confirmed by the schedule only when every condition of ADR 0017 holds; otherwise the plan stays a proposal for a
   * person (#37) and Needs you says why.
   */
  startFromPlay(input: { organizationId: string; workspaceId: string; playId: string; startedBy: string; occurrenceId: string; automationId?: string; sourceMissionId?: string; autoConfirm?: boolean; subjects?: readonly { pack: "support" | "sre"; kind: "ticket" | "incident"; id: string }[] }): string {
    const play = activeReleaseRecord(this.store, input.organizationId)?.release.plays?.[input.playId];
    if (!play) throw new BrainDomainError("NOT_FOUND", `play ${input.playId} is not in the active release`);
    const actor = this.scheduleActor(input);
    const db = this.store.workspaceDb(input.workspaceId, input.organizationId);
    const existing = db.prepare("SELECT id FROM missions WHERE started_by_occurrence=?").get(input.occurrenceId) as { id: string } | undefined;
    if (existing) return existing.id;
    // One transaction: a crash between the mission, its plan decision and its occurrence marker must not leave a mission the retry would duplicate or a plan nobody decides.
    return this.store.inTx(db, () => {
      const terms = this.sourceTerms(db, input.sourceMissionId);
      const id = this.createMission(actor, input.workspaceId, { title: play.spec.title, playId: input.playId, ...terms.payload, ...(input.subjects ? { subjects: input.subjects } : {}) });
      db.prepare("UPDATE missions SET started_by_occurrence=?,budget_wall_explicit=COALESCE(?,budget_wall_explicit) WHERE id=?").run(input.occurrenceId, terms.wallExplicit, id);
      this.settleOccurrence(actor, input, db, id, { tasks: play.spec.plan.tasks, team: play.spec.team });
      return id;
    });
  }

  /**
   * A scheduled start of described work ("Repeat this" on a mission that came from plain words). Each occurrence is a real mission with
   * its own plan and Results, started on behalf of the person who scheduled it and idempotent per occurrence. The plan is the source
   * mission's confirmed plan (so every occurrence has the same task ids and results compare task by task), else one task named `result`.
   * The schedule confirms it only under the conditions of ADR 0017; the mission budget, the member cap and the workspace spend cap bound it.
   */
  startFromDescription(input: { organizationId: string; workspaceId: string; title: string; situation: string; startedBy: string; occurrenceId: string; automationId?: string; sourceMissionId?: string; autoConfirm?: boolean }): string {
    const db = this.store.workspaceDb(input.workspaceId, input.organizationId);
    const existing = db.prepare("SELECT id FROM missions WHERE started_by_occurrence=?").get(input.occurrenceId) as { id: string } | undefined;
    if (existing) return existing.id;
    const actor = this.scheduleActor(input);
    const described = describedWork(input.situation, input.title);
    const source = input.sourceMissionId ? db.prepare("SELECT p.tasks_json AS tasks, p.team_json AS team FROM missions m JOIN plan_versions p ON p.id=m.active_plan_version_id WHERE m.id=?").get(input.sourceMissionId) as { tasks: string; team: string } | undefined : undefined;
    const tasks: PlanTask[] = source
      ? (JSON.parse(source.tasks) as PlanTask[]).map(({ inputs: _inputs, criterionIds, ...task }) => {
        // The occurrence's criteria are read back from its situation text: a task keeps only the criteria that still exist there.
        const served = (criterionIds ?? []).filter((id) => Number(id.slice(1)) <= described.criteria.length);
        return served.length > 0 ? { ...task, criterionIds: served } : task;
      })
      : [{ id: "result", title: input.title.slice(0, 200), criteria: described.criteria, dependsOn: [], criterionIds: described.criteria.map((_, index) => `c${index + 1}`) }];
    const team = source ? JSON.parse(source.team) as TeamMember[] : [];
    // One transaction: a crash between the mission, its plan decision and its occurrence marker must not leave a mission the retry would duplicate.
    return this.store.inTx(db, () => {
      const terms = this.sourceTerms(db, input.sourceMissionId);
      const id = this.createMission(actor, input.workspaceId, { title: input.title.slice(0, 200), intent: described.intent, successCriteria: described.criteria, ...terms.payload });
      db.prepare("UPDATE missions SET started_by_occurrence=?,budget_wall_explicit=COALESCE(?,budget_wall_explicit) WHERE id=?").run(input.occurrenceId, terms.wallExplicit, id);
      this.proposePlan(actor, input.workspaceId, { missionId: id, origin: "template", summary: source ? "The plan of the mission this schedule repeats" : "The described work, as one task", tasks, team });
      this.settleOccurrence(actor, input, db, id, { tasks, team });
      return id;
    });
  }

  private scheduleActor(input: { organizationId: string; workspaceId: string; startedBy: string }): ActorContext {
    return { kind: "workflow", actorId: input.startedBy, organizationId: input.organizationId, workspaceId: input.workspaceId, scopes: [], authMethod: "service-credential", authGeneration: 1 };
  }

  /** What an occurrence inherits from the confirmed mission it repeats: its budget and autonomy as confirmed, and whether a person named its time limit. */
  private sourceTerms(db: ReturnType<Store["workspaceDb"]>, sourceMissionId: string | undefined): { payload: Record<string, unknown>; wallExplicit: number | null } {
    const row = sourceMissionId ? db.prepare("SELECT * FROM missions WHERE id=?").get(sourceMissionId) as (Parameters<typeof budgetOf>[0] & { policy_json: string; budget_wall_explicit: number }) | undefined : undefined;
    if (!row) return { payload: {}, wallExplicit: null };
    const preset = (JSON.parse(row.policy_json) as { preset?: AutonomyPreset }).preset;
    return { payload: { budget: budgetOf(row), ...(preset ? { autonomy: preset } : {}) }, wallExplicit: row.budget_wall_explicit };
  }

  /**
   * ADR 0017: the occurrence's first plan is confirmed by the schedule, on behalf of the person who created it, when every safety
   * condition holds; otherwise it stays a proposal and the reason is recorded for Needs you. Both outcomes are events on the plan, which is
   * the workspace audit trail.
   */
  private settleOccurrence(actor: ActorContext, input: { organizationId: string; workspaceId: string; startedBy: string; automationId?: string; sourceMissionId?: string; autoConfirm?: boolean; subjects?: readonly { kind: "ticket" | "incident" }[] }, db: ReturnType<Store["workspaceDb"]>, missionId: string, proposed: RepeatPlan): void {
    const plan = db.prepare("SELECT id, digest FROM plan_versions WHERE mission_id=? AND state='proposed' ORDER BY revision DESC LIMIT 1").get(missionId) as { id: string; digest: string } | undefined;
    if (!plan) return;
    const schedule: RepeatSchedule = { automationId: input.automationId ?? "unknown", createdBy: input.startedBy, ...(input.sourceMissionId ? { sourceMissionId: input.sourceMissionId } : {}), ...(input.subjects?.[0] ? { subjectKind: input.subjects[0].kind } : {}), autoConfirm: input.autoConfirm !== false };
    const verdict = repeatGate(this.store, db, { organizationId: input.organizationId, workspaceId: input.workspaceId, schedule, missionId, proposed });
    const base = { missionId, planVersionId: plan.id, digest: plan.digest, actorId: `schedule:${schedule.automationId}`, automationId: schedule.automationId, createdBy: schedule.createdBy };
    if (verdict.ok) {
      this.confirmPlan(actor, input.workspaceId, { planVersionId: plan.id }, undefined, true);
      this.store.emit(db, { aggregateType: "plan", aggregateId: plan.id, eventType: "plan.confirmedBySchedule", payload: { ...base, note: `confirmed by schedule ${schedule.automationId} created by ${schedule.createdBy}` } });
    } else {
      this.store.emit(db, { aggregateType: "plan", aggregateId: plan.id, eventType: "plan.heldBySchedule", payload: { ...base, reason: verdict.reason, ...(verdict.diff ? { diff: verdict.diff as unknown as JsonValue } : {}) } });
    }
  }

  /**
   * The mission, team member and owner a run's work belongs to, which is what the machine principal of its sessions is bound to (ADR 0032).
   * A coordinator run belongs to the coordinator member. Work outside any mission has no principal.
   */
  sessionBinding(organizationId: string, workspaceId: string, runId: string): { missionId: string; memberId: string | null; actingFor: string; workItemId?: string } | undefined {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const task = db.prepare("SELECT l.mission_id AS missionId, l.work_item_id AS workItemId, w.assignment_json AS assignment FROM execution_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.run_id=? ORDER BY l.created_at_ms DESC LIMIT 1").get(runId) as { missionId: string; workItemId: string; assignment: string | null } | undefined;
    // A delegated child acts as the member it was given, on no task of its own: its tools must not default to its parent's task (ADR 0053).
    const delegated = task ? undefined : delegatedRunOf(db, runId);
    if (delegated) {
      const owner = db.prepare("SELECT owner_id AS owner FROM missions WHERE id=?").get(delegated.missionId) as { owner: string } | undefined;
      return owner ? { missionId: delegated.missionId, memberId: delegated.memberId, actingFor: owner.owner } : undefined;
    }
    const coordinating = task ? undefined : db.prepare("SELECT mission_id AS missionId FROM mission_runs WHERE run_id=? AND purpose='coordinator'").get(runId) as { missionId: string } | undefined;
    const missionId = task?.missionId ?? coordinating?.missionId;
    if (!missionId) return undefined;
    const mission = db.prepare("SELECT owner_id AS owner, coordinator_member_id AS coordinator FROM missions WHERE id=?").get(missionId) as { owner: string; coordinator: string | null } | undefined;
    if (!mission) return undefined;
    return { missionId, memberId: task ? memberOf(task.assignment) : mission.coordinator, actingFor: mission.owner, ...(task ? { workItemId: task.workItemId } : {}) };
  }

  isOpen(organizationId: string, workspaceId: string, missionId: string): boolean {
    const row = this.store.workspaceDb(workspaceId, organizationId).prepare("SELECT state FROM missions WHERE id=?").get(missionId) as { state: string } | undefined;
    if (!row || row.state === "closed") return false;
    // A mission whose evidence is verified and only waits for a person's sign-off has finished its work: it must not stop the schedule's next run (hands-off).
    if (row.state === "verifying") return (this.store.workspaceDb(workspaceId, organizationId).prepare("SELECT state FROM mission_evidence_bundles WHERE mission_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(missionId) as { state: string } | undefined)?.state !== "verified";
    return true;
  }

  /** A human sets the workspace's daily and weekly spend cap; missions paused by it resume once the cap is raised (#55). */
  private setSpendCap(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only humans set the workspace spend cap");
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      setSpendCap(db, actor.actorId, this.store.now(), { daily: payload["dailyMicroUsd"] as number | undefined, weekly: payload["weeklyMicroUsd"] as number | undefined });
      for (const { id } of db.prepare("SELECT id FROM missions WHERE state='paused' AND pause_reason='budget'").all() as Array<{ id: string }>) wake(this.store, db, id, "budget-changed");
      this.store.emit(db, { aggregateType: "workspace", aggregateId: workspaceId, eventType: "mission.budgetChanged", payload: {} });
    });
    return workspaceId;
  }

  /**
   * The mission's owner hands it to another workspace member (ownership is the person a mission and its sessions act for).
   * Only the current owner or a workspace administrator may. The new owner must be an active human member who holds what the mission's sessions
   * need from the person they act for: the agent-session scopes, plus dispatch while the mission starts its own tasks. Attention items and
   * notifications read the owner at the time they are derived, so they follow at once. The mission's session principals are re-pointed in the
   * same step; running attempts keep their credentials and fences, and their principal now acts for the new owner.
   */
  private transferOwner(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only humans hand a mission to another owner");
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertExpectedVersion(mission.version, expectedVersion);
    assertNotClosed(mission);
    if (actor.actorId !== mission.owner_id && !actor.scopes.includes("workspace:admin")) throw new BrainDomainError("FORBIDDEN", "only the mission's owner or a workspace administrator hands it over");
    const newOwnerId = String(payload["newOwnerId"]);
    if (newOwnerId === mission.owner_id) throw new BrainDomainError("INVALID_ARGUMENT", "the mission already belongs to that person");
    const person = this.store.control.prepare("SELECT 1 FROM principals WHERE id=? AND organization_id=? AND kind='human' AND disabled_at_ms IS NULL").get(newOwnerId, actor.organizationId);
    if (!person || !hasWorkspaceMembership(this.store, newOwnerId, actor.organizationId, workspaceId)) throw new BrainDomainError("NOT_FOUND", "the new owner must be an active member of this workspace");
    const missing = this.missingForOwner(newOwnerId, actor.organizationId, workspaceId, mission.auto_start === 1);
    if (missing.length > 0) throw new BrainDomainError("FORBIDDEN", `the new owner could not stand behind this mission's sessions: missing ${missing.join(", ")}`);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("UPDATE missions SET owner_id=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?").run(newOwnerId, this.store.now(), mission.id, mission.version);
      this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.ownerChanged", payload: { missionId: mission.id, from: mission.owner_id, to: newOwnerId, by: actor.actorId } });
    });
    // The sessions of the mission act for whoever owns it now: running attempts keep their credential and fence, the principal behind them is re-pointed.
    this.store.control.prepare("UPDATE agent_principals SET acting_for=? WHERE mission_id=? AND acting_for<>?").run(newOwnerId, mission.id, newOwnerId);
    this.store.emit(this.store.control, { organizationId: actor.organizationId, workspaceId, aggregateType: "mission", aggregateId: mission.id, eventType: "mission.ownerTransferred",
      payload: { actorId: actor.actorId, missionId: mission.id, from: mission.owner_id, to: newOwnerId, message: `Handed over from ${this.nameOf(mission.owner_id)} to ${this.nameOf(newOwnerId)}` }, destinations: [`workspace:${workspaceId}`] });
    return mission.id;
  }

  /** The scopes a person lacks to stand behind a mission's sessions: the agent-session role, plus dispatch while the mission starts its own tasks. */
  private missingForOwner(principalId: string, organizationId: string, workspaceId: string, autoStart: boolean): string[] {
    const held = new Set(scopesForPrincipal(this.store, principalId, organizationId, workspaceId));
    return [...roleScopes("agent-session"), ...(autoStart ? ["workflow:dispatch"] : [])].filter((scope) => !held.has(scope));
  }

  /** The active people who could take a mission over (what the hand-over dialog offers): members of the workspace who hold what its sessions need. */
  ownerCandidates(actor: ActorContext, workspaceId: string): JsonValue {
    this.db(actor, workspaceId);
    const rows = this.store.control.prepare(`SELECT DISTINCT m.principal_id AS id, u.name AS name, u.email AS email FROM workspace_memberships m JOIN principals p ON p.id=m.principal_id AND p.organization_id=m.organization_id
      LEFT JOIN "user" u ON u.id=p.auth_subject_id WHERE m.workspace_id=? AND m.organization_id=? AND m.revoked_at_ms IS NULL AND p.kind='human' AND p.disabled_at_ms IS NULL ORDER BY m.principal_id`).all(workspaceId, actor.organizationId) as Array<{ id: string; name: string | null; email: string | null }>;
    return { items: rows.filter((row) => this.missingForOwner(row.id, actor.organizationId, workspaceId, false).length === 0)
      .map((row) => ({ principalId: row.id, displayName: (row.name || row.id).slice(0, 256), ...(row.email ? { email: row.email.slice(0, 320) } : {}) })) } as unknown as JsonValue;
  }

  /** A person as the audit trail reads them: the sign-in account's name, the id only when there is none. */
  private nameOf(principalId: string): string {
    const row = this.store.control.prepare('SELECT u.name AS name FROM principals p JOIN "user" u ON u.id=p.auth_subject_id WHERE p.id=?').get(principalId) as { name: string } | undefined;
    return (row?.name || principalId).slice(0, 120);
  }

  /** A human sets the mission's budget (the note names what changed); raising it is what lifts a budget pause on resume. */
  private setBudget(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only humans set a mission budget");
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertExpectedVersion(mission.version, expectedVersion);
    assertNotClosed(mission);
    const budget = payload["budget"] as { maxMicroUsd?: number; maxWallClockMs?: number; memberCap: number; attemptReserveMicroUsd?: number; finalAllowanceMicroUsd?: number; maxTokens?: number; attemptReserveTokens?: number };
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("UPDATE missions SET budget_micro_usd=?,budget_wall_ms=?,member_cap=?,attempt_reserve_micro_usd=?,final_allowance_micro_usd=?,budget_tokens=?,attempt_reserve_tokens=?,budget_wall_explicit=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(budget.maxMicroUsd ?? null, budget.maxWallClockMs ?? null, budget.memberCap, budget.attemptReserveMicroUsd ?? mission.attempt_reserve_micro_usd, budget.finalAllowanceMicroUsd ?? mission.final_allowance_micro_usd, budget.maxTokens ?? null, budget.attemptReserveTokens ?? mission.attempt_reserve_tokens, budget.maxWallClockMs !== undefined && budget.maxWallClockMs !== mission.budget_wall_ms ? 1 : mission.budget_wall_explicit, this.store.now(), mission.id, mission.version);
      this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.budgetChanged", payload: { missionId: mission.id, by: actor.actorId, note: limitChangeNote(mission, budget) } });
      wake(this.store, db, mission.id, "budget-changed");
    });
    return mission.id;
  }

  /** Mission-local admission for a run's next attempt; a run linked to no mission is interactive work. */
  admission(organizationId: string, workspaceId: string, runId: string): { missionId?: string; admitted: true; reserve: number; running: number } | { missionId?: string; admitted: false; reason: string; running: number } {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const work = db.prepare("SELECT mission_id FROM execution_links WHERE run_id=? LIMIT 1").get(runId) as { mission_id: string } | undefined;
    const coordinatorRun = work ? undefined : db.prepare("SELECT mission_id FROM mission_runs WHERE run_id=?").get(runId) as { mission_id: string } | undefined;
    // A delegated child is admitted like any member's attempt: it counts toward the member cap and spends the mission's budget (ADR 0053).
    const delegatedRun = work || coordinatorRun ? undefined : delegatedRunOf(db, runId);
    const link = work ?? coordinatorRun ?? (delegatedRun ? { mission_id: delegatedRun.missionId } : undefined);
    if (!link) {
      // A challenge's reviewer run is bound to no work item but is charged to the mission it reviews. It is found by its execution key
      // (the command id `challenge-<id>`), which exists before the challenge learns the run id.
      const challenged = db.prepare(`SELECT w.mission_id FROM workflow_runs r JOIN result_challenges c ON r.execution_key='challenge-' || c.id
        JOIN work_items w ON w.id=c.work_item_id WHERE r.id=?`).get(runId) as { mission_id: string } | undefined;
      if (!challenged) return this.store.inTx(db, () => admitOutsideMission(this.store, db));
      const decision = this.store.inTx(db, () => admitChallenge(this.store, db, challenged.mission_id));
      return { missionId: challenged.mission_id, ...decision };
    }
    const decision = this.store.inTx(db, () => admit(this.store, db, link.mission_id, Boolean(coordinatorRun), (missionId) => wake(this.store, db, missionId, "mission-paused", "budget exhausted; write the final checkpoint"), () => this.soleHuman(workspaceId)));
    return { missionId: link.mission_id, ...decision };
  }

  /** True when the workspace has exactly one person who could pause, resume or approve: nobody else could object to a time extension. */
  private soleHuman(workspaceId: string): boolean {
    const row = this.store.control.prepare(`SELECT COUNT(DISTINCT m.principal_id) AS n FROM workspace_memberships m JOIN principals p ON p.id=m.principal_id AND p.organization_id=m.organization_id
      WHERE m.workspace_id=? AND m.revoked_at_ms IS NULL AND p.kind='human' AND p.disabled_at_ms IS NULL AND m.role IN ('operator','workspace-lead','approver')`).get(workspaceId) as { n: number };
    return row.n === 1;
  }

  recordReservation(organizationId: string, workspaceId: string, input: { missionId?: string; runId: string; attemptId: string; microUsd: number; agentId?: string }): void {
    // The team member is the one the session's machine principal is bound to (ADR 0032), so spend and authority name the same member.
    const memberId = input.missionId ? this.sessionBinding(organizationId, workspaceId, input.runId)?.memberId : undefined;
    reserveSpend(this.store, this.store.workspaceDb(workspaceId, organizationId), { ...input, ...(memberId ? { memberId } : {}) });
  }

  /** Governor-internal: an attempt produced a version of a named output its plan task declares. */
  recordOutput(organizationId: string, workspaceId: string, input: Parameters<typeof recordOutputVersion>[2]): string {
    return recordOutputVersion(this.store, this.store.workspaceDb(workspaceId, organizationId), input);
  }

  private message(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertNotClosed(mission);
    if (actor.kind !== "human") this.assertTeammateMessage(actor, workspaceId, mission.id, payload);
    const answers = typeof payload["answersQuestionId"] === "string" ? payload["answersQuestionId"] : undefined;
    if (answers) this.assertAnswer(actor, workspaceId, mission.id, answers, payload);
    const team = mission.active_plan_version_id ? (JSON.parse(this.planRow(actor, workspaceId, mission.active_plan_version_id).team_json) as TeamMember[]).map((member) => member.memberId) : [];
    const messageId = sendMessage(this.store, this.db(actor, workspaceId), {
      missionId: mission.id, senderId: actor.actorId, recipient: payload["recipient"] as { kind: "mission" | "member"; memberId?: string },
      body: String(payload["body"]), team,
      ...(payload["workItemId"] ? { workItemId: String(payload["workItemId"]) } : {}), ...(payload["correctionOf"] ? { correctionOf: String(payload["correctionOf"]) } : {}),
      ...(answers ? { answersQuestionId: answers } : {}),
    });
    this.delivery?.deliver(actor.organizationId, workspaceId, messageId, payload["interrupt"] === true);
    // A message to the mission itself (no work item) wakes its coordinator (#38).
    if ((payload["recipient"] as { kind?: string } | undefined)?.kind === "mission" && !payload["workItemId"]) wake(this.store, this.db(actor, workspaceId), mission.id, "message", String(payload["body"]).slice(0, 200));
    return messageId;
  }

  /** A team member's session asks a person a question (ADR 0050): written once; it becomes a blocking attention item until a person answers it. */
  private ask(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind !== "agent" || !actor.memberId || !actor.attemptId) throw new BrainDomainError("FORBIDDEN", "only a team member's session asks a person a question");
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertNotClosed(mission);
    return recordQuestion(this.store, this.db(actor, workspaceId), {
      missionId: mission.id, memberId: actor.memberId, attemptId: actor.attemptId, askerId: actor.actorId, body: String(payload["body"]),
      ...(payload["workItemId"] ? { workItemId: String(payload["workItemId"]) } : {}),
    });
  }

  /**
   * Only a person answers a question, once, and the answer goes to the member that asked (never the mission, never a correction): a session that
   * could clear a person's blocking item by sending a message would hide the very thing the item is for. The answer is an ordinary message
   * to that member and authorizes nothing.
   */
  private assertAnswer(actor: ActorContext, workspaceId: string, missionId: string, questionId: string, payload: Readonly<Record<string, unknown>>): void {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only a person answers a question");
    const { question, answered } = questionOf(this.db(actor, workspaceId), questionId, missionId);
    if (answered) throw new BrainDomainError("CONFLICT", "this question has already been answered");
    const recipient = payload["recipient"] as { kind?: string; memberId?: string } | undefined;
    if (recipient?.kind !== "member" || recipient.memberId !== question.member_id) throw new BrainDomainError("INVALID_ARGUMENT", "an answer goes to the team member that asked");
    if (payload["correctionOf"]) throw new BrainDomainError("INVALID_ARGUMENT", "an answer is not a correction of an earlier message");
  }

  /**
   * A team member's session may tell another member something (ADR 0042). It names the member (never the mission, so it cannot wake the
   * coordinator in a loop), never itself, never interrupts a running session, and at most MAX_PENDING_TEAMMATE_MESSAGES of its messages wait
   * undelivered. The message is a claim like any other: it authorizes nothing.
   */
  private assertTeammateMessage(actor: ActorContext, workspaceId: string, missionId: string, payload: Readonly<Record<string, unknown>>): void {
    if (actor.kind !== "agent" || !actor.memberId) throw new BrainDomainError("FORBIDDEN", "only a person or a team member's session sends a mission message");
    const recipient = payload["recipient"] as { kind?: string; memberId?: string } | undefined;
    if (recipient?.kind !== "member" || !recipient.memberId) throw new BrainDomainError("FORBIDDEN", "a session messages a team member by name, not the mission");
    if (recipient.memberId === actor.memberId) throw new BrainDomainError("INVALID_ARGUMENT", "a session does not message its own team member");
    if (payload["interrupt"] === true) throw new BrainDomainError("FORBIDDEN", "only a person interrupts a running session");
    const waiting = this.db(actor, workspaceId).prepare("SELECT COUNT(*) AS n FROM mission_messages WHERE mission_id=? AND sender_id=? AND delivery='pending'").get(missionId, actor.actorId) as { n: number };
    if (waiting.n >= MAX_PENDING_TEAMMATE_MESSAGES && !payload["correctionOf"]) throw new BrainDomainError("CONFLICT", `${waiting.n} of your messages have not reached their member yet; wait for them to be read before sending more`);
  }

  /**
   * An administrator stopped every session of the workspace (ADR 0047). Every active mission pauses and says why, so nothing starts again until a
   * person resumes it, and the tasks the stopped runs carried return to ready with the reason as their next action: stopped, never failed or abandoned.
   */
  stopWork(organizationId: string, workspaceId: string, input: { reason: string; runIds: readonly string[] }): { missions: Array<{ missionId: string; title: string }>; tasks: number } {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    return this.store.inTx(db, () => {
      const now = this.store.now();
      const missions = (db.prepare("SELECT id, title FROM missions WHERE state='active' ORDER BY created_at_ms, id").all() as Array<{ id: string; title: string }>);
      for (const mission of missions) {
        transitionState(db, "mission", mission.id, "paused", { set: { pause_reason: "human", stop_note: input.reason, updated_at_ms: now }, bumpVersion: true });
        this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.stateChanged", payload: { missionId: mission.id, missionState: "paused" } });
      }
      let tasks = 0;
      for (const runId of input.runIds) {
        for (const item of db.prepare("SELECT w.id, w.mission_id FROM execution_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.run_id=? AND w.state='in-progress'").all(runId) as Array<{ id: string; mission_id: string }>) {
          transitionState(db, "workItem", item.id, "ready", { set: { next_action: "Stopped by an administrator: resume the mission to carry on", updated_at_ms: now }, bumpVersion: true });
          this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.transitioned", payload: { workItemId: item.id, state: "ready" } });
          tasks++;
        }
      }
      return { missions: missions.map((mission) => ({ missionId: mission.id, title: mission.title })), tasks };
    });
  }

  /** Mission lifecycle per issue #19: humans pause, resume and close; completion is proposed, never declared. */
  private changeState(actor: ActorContext, workspaceId: string, type: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertExpectedVersion(mission.version, expectedVersion);
    assertNotClosed(mission);
    const db = this.db(actor, workspaceId);
    const now = this.store.now();
    let next: Mission["state"]; const set: Record<string, unknown> = { updated_at_ms: now, pause_reason: null, stop_note: null };
    if (type === "mission.pause") { next = "paused"; set["pause_reason"] = "human"; }
    else if (type === "mission.resume") {
      if (mission.pause_reason === "budget" && !hasHeadroom(this.store, this.db(actor, workspaceId), mission.id)) throw new BrainDomainError("CONFLICT", "raise the limit that was reached (the mission budget, its token ceiling or the workspace spend cap) before resuming a budget pause");
      next = "active";
    } else if (type === "mission.proposeCompletion") next = "verifying";
    else {
      const outcome = String(payload["outcome"]) as MissionOutcome;
      if (outcome === "achieved" && (mission.state !== "verifying" || latestMissionBundle(db, mission.id)?.state !== "verified")) throw new BrainDomainError("EVIDENCE_MISSING", "achieved requires a verified mission verdict");
      next = "closed"; set["outcome"] = outcome;
    }
    if (next !== "closed" && mission.state === next) throw new BrainDomainError("CONFLICT", `mission is already ${next}`);
    this.store.inTx(db, () => {
      transitionState(db, "mission", mission.id, next, { set, bumpVersion: true, and: { version: mission.version } });
      if (set["outcome"] === "cancelled") {
        const open = db.prepare("SELECT id FROM work_items WHERE mission_id=? AND state NOT IN ('done','abandoned')").all(mission.id) as Array<{ id: string }>;
        for (const item of open) transitionState(db, "workItem", item.id, "abandoned", { set: { next_action: "Mission cancelled", updated_at_ms: now }, bumpVersion: true });
      }
      this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.stateChanged", payload: { missionId: mission.id, missionState: next } });
    });
    // A coordinator starts its mission's tasks itself, so lifting an administrator's stop wakes it; without one auto-start runs the ready tasks.
    if (type === "mission.resume" && mission.stop_note) wake(this.store, db, mission.id, "mission-resumed", "an administrator's stop was lifted");
    if (next === "closed") this.capitalization?.requestMissionRun(actor.organizationId, workspaceId, mission.id);
    if (next === "verifying") {
      const bundle = this.store.inTx(db, () => assembleMissionBundle(this.store, db, mission.id, mission.brief_version, this.servedCriteria(db, mission)));
      if (!bundle.complete) this.backToWork(actor, workspaceId, mission.id, latestMissionBundle(db, mission.id)?.findings ?? []);
    }
    return mission.id;
  }

  /** Verifying -> active with the verdict's findings routed to the coordinator as a message, never into the brief (#36). */
  private backToWork(actor: ActorContext, workspaceId: string, missionId: string, findings: readonly string[]): void {
    this.returnToActive(actor, workspaceId, missionId);
    if (findings.length > 0) sendMessage(this.store, this.db(actor, workspaceId), { missionId, senderId: "governor", recipient: { kind: "mission" }, body: `Mission verdict findings:\n- ${findings.join("\n- ")}`.slice(0, 8000), team: [] });
  }

  private handoff(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const item = this.workItemRow(actor, workspaceId, String(payload["workItemId"]));
    assertNotClosed(this.missionRow(actor, workspaceId, item.mission_id));
    return submitHandoff(this.store, this.db(actor, workspaceId), { workItemId: item.id, submittedBy: actor.actorId, notes: payload["notes"] as HandoffNotes });
  }

  /**
   * The verdict on the mission's evidence bundle. Through the command only a person records it (the registry admits no other actor), which is
   * independence L3; the Governor's hands-off path calls this directly as a workflow actor and claims no independence. A rejection needs findings.
   */
  private verdict(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    if (mission.state !== "verifying") throw new BrainDomainError("CONFLICT", "only a verifying mission takes a verdict");
    const db = this.db(actor, workspaceId);
    const outcome = String(payload["outcome"]) as "verified" | "rejected";
    const findings = ((payload["findings"] as string[] | undefined) ?? []).map((finding) => finding.trim()).filter((finding) => finding.length > 0);
    if (outcome === "rejected" && findings.length === 0) throw new BrainDomainError("INVALID_ARGUMENT", "a rejected verdict needs findings: say what to fix");
    this.store.inTx(db, () => {
      recordMissionVerdict(this.store, db, { missionId: mission.id, digest: String(payload["bundleDigest"]), outcome, findings, by: actor.actorId, ...(actor.kind === "human" ? { independence: "L3" as const } : {}) });
      // A rejected sign-off is a re-open: it becomes a regression case without anyone filing it (issue #64).
      if (outcome === "rejected") recordEvalCase(this.store, db, { workspaceId, source: `verdict:${String(payload["bundleDigest"])}`, kind: "rejected-verdict", missionId: mission.id, findings });
    });
    if (outcome === "rejected") this.backToWork(actor, workspaceId, mission.id, findings);
    return mission.id;
  }

  /** Governor-internal: a rejected or incomplete mission verdict returns a verifying mission to work. */
  returnToActive(actor: ActorContext, workspaceId: string, missionId: string): void {
    const mission = this.missionRow(actor, workspaceId, missionId);
    if (mission.state !== "verifying") return;
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      transitionState(db, "mission", mission.id, "active", { set: { updated_at_ms: this.store.now() }, bumpVersion: true });
      this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.stateChanged", payload: { missionId: mission.id, missionState: "active" } });
    });
  }

  private latestBrief(db: ReturnType<Store["workspaceDb"]>, mission: MissionRow): BriefRow {
    const row = db.prepare("SELECT * FROM mission_brief_versions WHERE mission_id=? ORDER BY version DESC LIMIT 1").get(mission.id) as BriefRow | undefined;
    return row ?? { mission_id: mission.id, version: mission.brief_version, intent: mission.intent, constraints_json: "[]", change: "created", rebased_from: null, created_by: mission.owner_id, created_at_ms: mission.created_at_ms };
  }

  private activeDecisions(db: ReturnType<Store["workspaceDb"]>, missionId: string): DecisionRow[] {
    return db.prepare("SELECT * FROM accepted_decisions WHERE mission_id=? AND superseded_by IS NULL ORDER BY introduced_version, id").all(missionId) as DecisionRow[];
  }

  private writeBrief(db: ReturnType<Store["workspaceDb"]>, actor: ActorContext, mission: MissionRow, base: BriefRow, intent: string, constraints: readonly string[], change: string, rebasedFrom: number | null): number {
    const version = base.version + 1;
    const now = this.store.now();
    db.prepare("INSERT INTO mission_brief_versions(mission_id,version,intent,constraints_json,change,rebased_from,created_by,created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
      .run(mission.id, version, intent, JSON.stringify(constraints), change, rebasedFrom, actor.actorId, now);
    db.prepare("UPDATE missions SET intent=?,brief_version=?,updated_at_ms=? WHERE id=?").run(intent, version, now, mission.id);
    this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.briefChanged", payload: { missionId: mission.id, briefVersion: version } });
    return version;
  }

  /**
   * Humans own intent and constraints. An edit names the brief version it was
   * made against; a stale human edit is rebased onto the latest version (and
   * records the version it was rebased from) so it is never lost to an agent.
   */
  private editBrief(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only humans edit a mission's intent and constraints");
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertNotClosed(mission);
    const db = this.db(actor, workspaceId);
    const baseVersion = Number(payload["baseVersion"]);
    this.store.inTx(db, () => {
      const latest = this.latestBrief(db, mission);
      if (baseVersion > latest.version) throw new BrainDomainError("CONFLICT", "brief version does not exist");
      const intent = payload["intent"] !== undefined ? String(payload["intent"]) : latest.intent;
      const constraints = payload["constraints"] !== undefined ? payload["constraints"] as string[] : JSON.parse(latest.constraints_json) as string[];
      assertBriefSize(intent, constraints, this.activeDecisions(db, mission.id).map((row) => row.statement));
      this.writeBrief(db, actor, mission, latest, intent, constraints, "edited", baseVersion < latest.version ? baseVersion : null);
    });
    return mission.id;
  }

  /**
   * Accepted decisions are immutable entries; a later one supersedes, never
   * edits. A coordinator accepts only within its autonomy policy and only
   * against the current brief version.
   */
  private acceptDecision(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertNotClosed(mission);
    const policy = JSON.parse(mission.policy_json) as AutonomyPolicy;
    if (actor.kind !== "human" && !policy.operations.includes("decision.accept")) throw new BrainDomainError("FORBIDDEN", "accepting this decision needs a human under the mission's autonomy policy");
    const db = this.db(actor, workspaceId);
    const id = this.store.id("decision");
    const source = payload["source"] as { kind: AcceptedDecision["source"]["kind"]; ref?: string };
    const supersedes = payload["supersedes"] ? String(payload["supersedes"]) : undefined;
    this.store.inTx(db, () => {
      const latest = this.latestBrief(db, mission);
      const base = Number(payload["baseVersion"]);
      if (base !== latest.version && (actor.kind !== "human" || base > latest.version)) throw new BrainDomainError("CONFLICT", `the brief changed since version ${base}; re-read version ${latest.version}`);
      const active = this.activeDecisions(db, mission.id);
      if (supersedes && !active.some((row) => row.id === supersedes)) throw new BrainDomainError("CONFLICT", "only an active decision of this mission can be superseded");
      const statement = String(payload["statement"]);
      assertBriefSize(latest.intent, JSON.parse(latest.constraints_json) as string[], [...active.filter((row) => row.id !== supersedes).map((row) => row.statement), statement]);
      const version = this.writeBrief(db, actor, mission, latest, latest.intent, JSON.parse(latest.constraints_json) as string[], supersedes ? "superseded" : "decision", base < latest.version ? base : null);
      db.prepare("INSERT INTO accepted_decisions(id,mission_id,statement,source_kind,source_ref,accepted_by,introduced_version,created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, mission.id, statement, source.kind, source.ref ?? null, actor.actorId, version, this.store.now());
      if (supersedes) db.prepare("UPDATE accepted_decisions SET superseded_by=? WHERE id=? AND superseded_by IS NULL").run(id, supersedes);
    });
    return id;
  }

  /** Only a human changes what the coordinator may do; each change is a new policy version. */
  private setPolicy(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only humans change a mission's autonomy policy");
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertExpectedVersion(mission.version, expectedVersion);
    assertNotClosed(mission);
    const current = JSON.parse(mission.policy_json) as AutonomyPolicy;
    const preset = payload["preset"] as AutonomyPreset | undefined;
    const operations = payload["operations"] as PlanOperation[] | undefined;
    const autoStart = typeof payload["autoStart"] === "boolean" ? payload["autoStart"] : undefined;
    if (!preset && !operations && autoStart === undefined) throw new BrainDomainError("INVALID_ARGUMENT", "a preset, an operation list or the auto-start setting is required");
    const db = this.db(actor, workspaceId);
    if (!preset && !operations) {
      // The auto-start switch alone: the autonomy policy is untouched.
      this.store.inTx(db, () => {
        db.prepare("UPDATE missions SET auto_start=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?").run(autoStart ? 1 : 0, this.store.now(), mission.id, mission.version);
        if (!autoStart) clearStartNotes(db, mission.id);
        this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.autoStartChanged", payload: { missionId: mission.id, autoStart: Boolean(autoStart) } });
      });
      return mission.id;
    }
    const next: AutonomyPolicy = operations
      ? { ...(preset ? { preset } : {}), operations: [...new Set(operations)].sort(), version: current.version + 1 }
      : { preset: preset as AutonomyPreset, operations: [...AUTONOMY_PRESETS[preset as AutonomyPreset]].sort(), version: current.version + 1 };
    const ceiling = this.ceiling(workspaceId);
    const beyond = next.operations.filter((operation) => !ceiling.includes(operation));
    if (beyond.length > 0) throw new BrainDomainError("FORBIDDEN", `the workspace autonomy ceiling does not allow ${beyond.join(", ")}`);
    this.store.inTx(db, () => {
      db.prepare("UPDATE missions SET policy_json=?,auto_start=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?").run(JSON.stringify(next), autoStart === undefined ? mission.auto_start : autoStart ? 1 : 0, this.store.now(), mission.id, mission.version);
      if (autoStart === false) clearStartNotes(db, mission.id);
      this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.policyChanged", payload: { missionId: mission.id } });
    });
    return mission.id;
  }

  private brief(actor: ActorContext, workspaceId: string, mission: MissionRow): MissionBrief {
    const db = this.db(actor, workspaceId);
    const latest = this.latestBrief(db, mission);
    const decisions = (db.prepare("SELECT * FROM accepted_decisions WHERE mission_id=? ORDER BY introduced_version, id").all(mission.id) as DecisionRow[]).map((row): AcceptedDecision => ({
      decisionId: row.id, missionId: row.mission_id, statement: row.statement,
      source: { kind: row.source_kind, ...(row.source_ref ? { ref: row.source_ref } : {}) }, acceptedBy: row.accepted_by,
      introducedInVersion: row.introduced_version, ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}), createdAt: iso(row.created_at_ms),
    }));
    const counts = db.prepare("SELECT state, COUNT(*) AS n FROM work_items WHERE mission_id=? AND state!='abandoned' GROUP BY state").all(mission.id) as Array<{ state: string; n: number }>;
    const constraints = JSON.parse(latest.constraints_json) as string[];
    return {
      missionId: mission.id, version: latest.version, intent: latest.intent, constraints, decisions,
      progress: { total: counts.reduce((sum, row) => sum + row.n, 0), byState: Object.fromEntries(counts.map((row) => [row.state, row.n])) },
      writtenChars: briefChars(latest.intent, constraints, decisions.filter((entry) => !entry.supersededBy).map((entry) => entry.statement)),
      updatedBy: latest.created_by, updatedAt: iso(latest.created_at_ms),
      history: (db.prepare("SELECT * FROM mission_brief_versions WHERE mission_id=? ORDER BY version DESC LIMIT 50").all(mission.id) as BriefRow[]).map((row) => ({
        version: row.version, intent: row.intent, constraints: JSON.parse(row.constraints_json) as string[], change: row.change as "created" | "edited" | "decision" | "superseded",
        createdBy: row.created_by, createdAt: iso(row.created_at_ms),
      })),
    };
  }

  /**
   * A run linked to work failed (a failed step or a rejected verdict). The
   * count is per work item across members, so reassignment never resets it;
   * at the mission's threshold the item parks with its last diagnostic and
   * waits for a human. Independent work and the mission carry on (issue #39).
   */
  recordRunFailure(organizationId: string, workspaceId: string, runId: string, diagnostic: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    this.store.inTx(db, () => {
      const items = db.prepare("SELECT w.* FROM execution_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.run_id=? AND w.state IN ('ready','in-progress','review')").all(runId) as WorkItemRow[];
      for (const item of items) this.failAttempt(db, organizationId, item, runId, diagnostic);
    });
  }

  /**
   * One failed attempt of a task, handled once per run. The failure gets a class (a code decided from the call record, the step's
   * error and the failed checks, never by a model) and the class its single remedy (ADR 0022): another way of working, a stronger
   * model on the next attempt, one question for a person, a wait for an outage, or a stop at the spend cap. A task that keeps failing
   * parks at the mission's threshold; every parked or healed failure leaves a lesson for the planner.
   */
  private failAttempt(db: ReturnType<Store["workspaceDb"]>, organizationId: string, item: WorkItemRow, runId: string, diagnostic: string): void {
    if (db.prepare("SELECT 1 FROM task_failures WHERE run_id=? AND work_item_id=?").get(runId, item.id)) return;
    const threshold = (db.prepare("SELECT parking_threshold AS n FROM missions WHERE id=?").get(item.mission_id) as { n: number }).n;
    const reason = this.failureReason(db, runId);
    const interrupted = this.interruptedReason(db, runId);
    const detail = (reason ? `${diagnostic}: ${reason}` : diagnostic).slice(0, 1024);
    const now = this.store.now();
    const retry = (failedAttempts: number, nextAction: string, extra: Record<string, unknown> = {}): void => {
      if (item.state === "review") transitionState(db, "workItem", item.id, "in-progress", { bumpVersion: true });
      if (item.state !== "ready") transitionState(db, "workItem", item.id, "ready", { set: { failed_attempts: failedAttempts, next_action: nextAction, updated_at_ms: now, ...extra }, bumpVersion: true });
      else {
        const columns = Object.keys(extra);
        db.prepare(`UPDATE work_items SET failed_attempts=?,next_action=?,${columns.map((column) => `${column}=?`).join(",")}${columns.length ? "," : ""}version=version+1,updated_at_ms=? WHERE id=?`).run(failedAttempts, nextAction, ...columns.map((column) => extra[column] as never), now, item.id);
      }
    };
    const park = (failedAttempts: number, blockedReason: string, nextAction: string, failureClass: FailureClass | null): void => {
      transitionState(db, "workItem", item.id, "blocked", { set: { failed_attempts: failedAttempts, parked: 1, parked_diagnostic: detail, blocked_reason: blockedReason, next_action: nextAction, ...(failureClass ? { failure_class: failureClass } : {}), updated_at_ms: now }, bumpVersion: true });
      this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.parked", payload: { workItemId: item.id, missionId: item.mission_id, state: "blocked", ...(failureClass ? { failureClass } : {}) } });
      if (failureClass) this.recordLesson(db, item, failureClass, "parked");
    };
    if (interrupted) {
      // The agent was interrupted over and over: stop at once, do not count it as a failure of the work, and ask for one click.
      transitionState(db, "workItem", item.id, "blocked", { set: { parked: 1, parked_diagnostic: interrupted, blocked_reason: PARKED_INTERRUPTED_REASON, next_action: "A person tries again, reassigns, edits or drops this work", updated_at_ms: now }, bumpVersion: true });
      this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.parked", payload: { workItemId: item.id, missionId: item.mission_id, state: "blocked" } });
      return;
    }
    const tools = JSON.parse(item.required_tools_json) as string[];
    const used = taskTokens(this.store, db, item.id);
    const cap = taskTokenCap(item);
    const runWorkflow = (db.prepare("SELECT json_extract(workflow_json,'$.metadata.id') AS id FROM run_inputs WHERE run_id=?").get(runId) as { id: string | null } | undefined)?.id;
    const earlier = db.prepare("SELECT diagnostic FROM task_failures WHERE work_item_id=?").all(item.id) as Array<{ diagnostic: string }>;
    const failedChecks = this.failedCheckIds(db, runId);
    const failureClass = classifyFailure({
      requiredTools: tools, agentTools: runWorkflow ? workflowAgentTools(this.store, organizationId, runWorkflow) : undefined, calls: observedCalls(this.store, db, item.id, tools),
      failedChecks, earlierSameChecks: failedChecks.length === 0 ? 0 : earlier.filter((row) => failedChecks.some((check) => row.diagnostic.includes(CHECK_WORDS[check] ?? check))).length,
      tokensUsed: used, tokenCap: cap, errorText: detail,
    });
    const remedy = REMEDY[failureClass];
    db.prepare("INSERT INTO task_failures(run_id,work_item_id,mission_id,failure_class,remedy,diagnostic,created_at_ms) VALUES (?,?,?,?,?,?,?)").run(runId, item.id, item.mission_id, failureClass, remedy, detail, now);
    this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.failureClassified", payload: { workItemId: item.id, runId, failureClass, remedy } });
    const failed = item.failed_attempts + 1;
    const counted = (): void => {
      if (failed >= threshold) park(failed, `Parked after ${failed} failed attempts`, "A human retries, reassigns, edits or drops this work", failureClass);
      else retry(failed, `Retry after failed attempt ${failed} of ${threshold}`, { failure_class: failureClass });
    };
    switch (remedy) {
      case "park-budget":
        park(failed, `Parked: the task used its token allowance (${used} of ${cap} tokens)`, "Raise this task's token cap, split it or drop it", failureClass);
        break;
      case "ask-one-question":
        park(failed, "Parked: a criterion cannot be met as written", "Split the task or answer one question, then try again", failureClass);
        break;
      case "switch-way-of-working": {
        const alternatives = workflowsCovering(this.store, organizationId, tools).filter((id) => id !== runWorkflow);
        if (alternatives.length === 0) park(failed, `Parked: no way of working has ${tools.join(" or ")}`, "Switch this task to a way of working whose agent has the tool", failureClass);
        else retry(failed, `Retrying with ${alternatives[0]}: its agent has ${tools.join(" or ")}`, { failure_class: failureClass });
        break;
      }
      case "wait-and-retry": {
        const waits = earlier.length === 0 ? 0 : (db.prepare("SELECT COUNT(*) AS n FROM task_failures WHERE work_item_id=? AND failure_class='tool-outage' AND run_id!=?").get(item.id, runId) as { n: number }).n;
        // Waiting out an outage is not a failure of the work, until the outage outlasts the waits.
        if (waits < OUTAGE_MAX_WAITS) retry(item.failed_attempts, "Waiting for a tool that is down; retrying shortly", { failure_class: failureClass, retry_after_ms: now + OUTAGE_WAIT_MS });
        else counted();
        break;
      }
      case "wait-for-quota": {
        const waits = (db.prepare("SELECT COUNT(*) AS n FROM task_failures WHERE work_item_id=? AND failure_class='quota' AND run_id!=?").get(item.id, runId) as { n: number }).n;
        // Waiting out a limit is not a failure of the work, until the limit outlasts the waits. The provider's own retry-after sets the wait (ADR 0033).
        if (waits < QUOTA_MAX_WAITS) {
          const waitMs = quotaWaitMs(detail);
          retry(item.failed_attempts, `The model provider's quota or rate limit was reached; trying again in ${waitWords(waitMs)}`, { failure_class: failureClass, retry_after_ms: now + waitMs });
        } else counted();
        break;
      }
      default:
        counted();
    }
  }

  /** Ids of the checks an independent verdict of the run did not pass. */
  private failedCheckIds(db: ReturnType<Store["workspaceDb"]>, runId: string): string[] {
    try {
      const verdict = db.prepare(`SELECT v.manifest_json FROM verification_verdicts v JOIN evidence_bundles b ON b.digest=v.bundle_digest
        WHERE json_extract(b.manifest_json,'$.workflowRunId')=? AND v.outcome!='verified' ORDER BY v.created_at_ms DESC LIMIT 1`).get(runId) as { manifest_json: string } | undefined;
      if (!verdict) return [];
      return ((JSON.parse(verdict.manifest_json) as { checks?: Array<{ checkId?: string; criterionId?: string; status?: string }> }).checks ?? []).filter((check) => check.status !== "passed").map((check) => check.checkId ?? check.criterionId ?? "check");
    } catch { return []; }
  }

  /** One lesson per task and outcome, given to the planner until it expires. Lessons are not knowledge: they claim no observed result. */
  private recordLesson(db: ReturnType<Store["workspaceDb"]>, item: WorkItemRow, failureClass: FailureClass, outcome: "healed" | "parked"): void {
    const now = this.store.now();
    db.prepare("INSERT OR IGNORE INTO lessons(id,work_item_id,mission_id,failure_class,outcome,task_title,lesson,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(this.store.id("lesson"), item.id, item.mission_id, failureClass, outcome, item.title, lessonText(failureClass, item.title, outcome), now, now + LESSON_TTL_MS);
  }

  /** A task that reaches Done after failing leaves a "healed" lesson with the class of its latest failure. */
  private recordHealed(db: ReturnType<Store["workspaceDb"]>, item: WorkItemRow): void {
    const last = db.prepare("SELECT failure_class FROM task_failures WHERE work_item_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(item.id) as { failure_class: FailureClass } | undefined;
    if (last) this.recordLesson(db, item, last.failure_class, "healed");
  }

  /**
   * A release was activated: parked work in active missions gets one automatic retry on it. Earlier failures ran on other agents, limits
   * and tools, so they say little about the next attempt; a retry that fails again parks the item as before. Never more than once for
   * the same release (parked_auto_retries), and only for work whose mission is still active. Returns how many items were retried.
   */
  retryParkedForRelease(organizationId: string, releaseDigest: string): number {
    let retried = 0;
    const workspaces = this.store.control.prepare("SELECT id FROM workspaces WHERE organization_id=? AND status='active'").all(organizationId) as Array<{ id: string }>;
    for (const workspace of workspaces) {
      try {
        const db = this.store.workspaceDb(workspace.id, organizationId);
        const parked = db.prepare("SELECT w.id FROM work_items w JOIN missions m ON m.id=w.mission_id WHERE w.state='blocked' AND w.parked=1 AND m.state='active' AND (w.failure_class IS NULL OR w.failure_class NOT IN ('budget','unmeetable-criterion'))").all() as Array<{ id: string }>;
        for (const row of parked) {
          if (this.store.control.prepare("SELECT 1 FROM parked_auto_retries WHERE work_item_id=? AND release_digest=?").get(row.id, releaseDigest)) continue;
          this.store.inTx(db, () => {
            this.assertDependenciesDone(db, row.id);
            transitionState(db, "workItem", row.id, "ready", { set: { parked: 0, failed_attempts: 0, failure_class: null, blocked_reason: null, next_action: "Retrying automatically: a new release was activated", updated_at_ms: this.store.now() }, bumpVersion: true });
            this.store.emit(db, { aggregateType: "workItem", aggregateId: row.id, eventType: "workItem.unparked", payload: { workItemId: row.id, state: "ready", automatic: true, releaseDigest } });
          });
          this.store.control.prepare("INSERT OR IGNORE INTO parked_auto_retries(work_item_id,release_digest,organization_id,workspace_id,retried_at_ms) VALUES (?,?,?,?,?)").run(row.id, releaseDigest, organizationId, workspace.id, this.store.now());
          retried++;
        }
      } catch { /* one workspace that cannot be read never blocks an activation or the other workspaces */ }
    }
    return retried;
  }

  /** The plain sentence of a run whose agent was interrupted too many times, when that is why it failed. */
  private interruptedReason(db: ReturnType<Store["workspaceDb"]>, runId: string): string | undefined {
    try {
      for (const row of db.prepare("SELECT o.output_json FROM step_outputs o JOIN workflow_steps s ON s.run_id=o.run_id AND s.step_id=o.step_id WHERE o.run_id=? AND s.state='failed'").all(runId) as Array<{ output_json: string }>) {
        const out = JSON.parse(row.output_json) as { code?: unknown; error?: unknown };
        if (out.code === "AGENT_INTERRUPTED" && typeof out.error === "string") return out.error.slice(0, 300);
      }
    } catch { /* fall through */ }
    return undefined;
  }

  /** Why a failed run failed, in words: the agent's own error, or the checks an independent verdict did not pass. */
  private failureReason(db: ReturnType<Store["workspaceDb"]>, runId: string): string | undefined {
    try {
      // The failed attempt's own reason (redacted and short, kept when the attempt ended) comes first: it is what the run page and Logs show too.
      const attempt = this.store.control.prepare("SELECT a.failure_reason AS reason FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.workflow_run_id=? AND a.failure_reason IS NOT NULL ORDER BY a.attempt_no DESC LIMIT 1").get(runId) as { reason: string } | undefined;
      if (attempt?.reason) return attempt.reason;
      for (const row of db.prepare("SELECT o.output_json FROM step_outputs o JOIN workflow_steps s ON s.run_id=o.run_id AND s.step_id=o.step_id WHERE o.run_id=? AND s.state='failed'").all(runId) as Array<{ output_json: string }>) {
        const error = (JSON.parse(row.output_json) as { error?: unknown }).error;
        if (typeof error === "string" && error) return error.slice(0, 300);
      }
      const verdict = db.prepare(`SELECT v.manifest_json FROM verification_verdicts v JOIN evidence_bundles b ON b.digest=v.bundle_digest
        WHERE json_extract(b.manifest_json,'$.workflowRunId')=? AND v.outcome!='verified' ORDER BY v.created_at_ms DESC LIMIT 1`).get(runId) as { manifest_json: string } | undefined;
      if (!verdict) return undefined;
      const checks = (JSON.parse(verdict.manifest_json) as { checks?: Array<{ checkId?: string; criterionId?: string; status?: string }> }).checks ?? [];
      const failedChecks = checks.filter((check) => check.status !== "passed").map((check) => CHECK_WORDS[check.checkId ?? check.criterionId ?? ""] ?? check.checkId ?? check.criterionId ?? "a check");
      return failedChecks.length > 0 ? `the independent check did not pass: ${failedChecks.join("; ")}` : "the independent check did not verify the result";
    } catch { return undefined; }
  }

  /**
   * A run linked to work succeeded. Its in-progress work item moves to review:
   * the run finishing is not proof, so Done still needs the verified evidence
   * bundle and an independent verdict (ADR 0004: an event, not a held run).
   */
  recordRunSuccess(organizationId: string, workspaceId: string, runId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    this.store.inTx(db, () => {
      const items = db.prepare("SELECT w.* FROM execution_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.run_id=? AND w.state='in-progress'").all(runId) as WorkItemRow[];
      const autoStart = new Map((db.prepare("SELECT id FROM missions WHERE auto_start=1 AND state='active'").all() as Array<{ id: string }>).map((row) => [row.id, true]));
      for (const item of items) {
        // ADR 0022: a run that finished without one successful call of the tools its task needs observed nothing; that is a failed attempt, not a result.
        const needed = JSON.parse(item.required_tools_json) as string[];
        if (needed.length > 0 && observedCalls(this.store, db, item.id, needed).succeeded === 0) {
          this.failAttempt(db, organizationId, item, runId, `The run finished, but no successful call of ${needed.join(" or ")} was recorded, so nothing was observed`);
          continue;
        }
        try { recordTaskResult(this.store, db, item.id); } catch (cause) { if (!(cause instanceof BrainDomainError)) throw cause; /* a result that cannot be versioned never blocks the task */ }
        transitionState(db, "workItem", item.id, "review", { set: { next_action: "The run finished: review the results and submit evidence", updated_at_ms: this.store.now() }, bumpVersion: true });
        this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.transitioned", payload: { workItemId: item.id, state: "review" } });
        if (autoStart.get(item.mission_id)) this.autoComplete(db, item, runId, organizationId);
      }
    });
  }

  /**
   * Recovery and completion for auto-start missions, idempotent and run on every
   * sweep: a run that succeeded while the Governor was not looking (a restart,
   * a release without this rule) still moves its work forward, and a mission
   * whose work is all Done and independently verified finishes by itself.
   */
  reconcileFinished(organizationId: string, workspaceId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    // Backlog work whose every live dependency is Done is ready, whatever moved last: a replan or a restart never leaves a task waiting on nothing.
    const waiting = db.prepare("SELECT DISTINCT w.mission_id AS id FROM work_items w JOIN missions m ON m.id=w.mission_id AND m.state='active' WHERE w.parked=0 AND w.state='backlog'").all() as Array<{ id: string }>;
    for (const entry of waiting) this.store.inTx(db, () => this.releaseReadyItems(db, entry.id, ["backlog"]));
    const rows = db.prepare(`SELECT w.*, l.run_id AS link_run FROM work_items w
      JOIN missions m ON m.id=w.mission_id AND m.state='active' AND m.auto_start=1
      JOIN execution_links l ON l.work_item_id=w.id JOIN workflow_runs r ON r.id=l.run_id AND r.state='succeeded'
      WHERE w.state IN ('in-progress','review') ORDER BY l.created_at_ms`).all() as Array<WorkItemRow & { link_run: string }>;
    for (const row of rows) {
      if (row.state === "in-progress") this.recordRunSuccess(organizationId, workspaceId, row.link_run);
      else this.store.inTx(db, () => this.autoComplete(db, row, row.link_run, organizationId));
    }
  }

  completeFinishedMissions(organizationId: string, workspaceId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const missions = db.prepare(`SELECT * FROM missions m WHERE m.state='active' AND m.auto_start=1
      AND EXISTS (SELECT 1 FROM work_items w WHERE w.mission_id=m.id AND w.state!='abandoned')
      AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.mission_id=m.id AND w.state NOT IN ('done','abandoned'))
      AND NOT EXISTS (SELECT 1 FROM mission_wakes k WHERE k.mission_id=m.id AND k.consumed_by_run IS NULL)
      AND NOT EXISTS (SELECT 1 FROM mission_runs r JOIN workflow_runs wr ON wr.id=r.run_id WHERE r.mission_id=m.id AND wr.state NOT IN ('succeeded','failed','cancelled','partial'))`).all() as MissionRow[];
    for (const mission of missions) {
      const actor: ActorContext = { kind: "workflow", actorId: mission.owner_id, organizationId, workspaceId, scopes: [], authMethod: "service-credential", authGeneration: 1 };
      try {
        this.changeState(actor, workspaceId, "mission.proposeCompletion", { missionId: mission.id });
        const bundle = latestMissionBundle(db, mission.id);
        if (!bundle || bundle.state === "incomplete") continue;
        // Every task is Done on its own independent verified verdict; the Governor records the mission-level verdict over that complete bundle.
        this.verdict(actor, workspaceId, { missionId: mission.id, bundleDigest: bundle.digest, outcome: "verified", findings: [] });
        this.changeState(actor, workspaceId, "mission.close", { missionId: mission.id, outcome: "achieved" });
      } catch (cause) {
        if (!(cause instanceof BrainDomainError)) throw cause;
      }
    }
  }

  /**
   * An auto-start mission needs no person between a verified run and Done: the
   * run's own verified evidence (independent verdict included) is bound, the
   * Governor writes the handoff from the run's summary, and the item moves to
   * Done, which releases its dependents. Any shortfall (no verified bundle, an
   * unpassed check) leaves the item in review for a person.
   */
  private autoComplete(db: ReturnType<Store["workspaceDb"]>, item: WorkItemRow, runId: string, organizationId: string): void {
    const bundles = db.prepare("SELECT digest, job_id FROM evidence_bundles WHERE state='verified' ORDER BY created_at_ms DESC").all() as Array<{ digest: string; job_id: string }>;
    const bundle = bundles.find((entry) => this.producedByLinkedExecution(db, item.id, entry.job_id));
    if (!bundle) return;
    try {
      this.store.inTx(db, () => {
        this.assertEvidence(db, item, bundle.digest, { kind: "workflow", actorId: "governor", organizationId, scopes: [], authMethod: "service-credential", authGeneration: 1 } as ActorContext);
        const outputs = db.prepare("SELECT output_json FROM step_outputs WHERE run_id=? ORDER BY rowid").all(runId) as Array<{ output_json: string }>;
        const summary = outputs.map((row) => { const parsed = JSON.parse(row.output_json) as { summary?: unknown }; return typeof parsed.summary === "string" ? parsed.summary : ""; }).find((text) => text.length > 0) ?? "The run finished and its evidence was independently verified.";
        submitHandoff(this.store, db, { workItemId: item.id, submittedBy: "governor", notes: { summary: summary.slice(0, 2000) } });
        finalizeHandoff(db, item.id, bundle.digest);
        transitionState(db, "workItem", item.id, "done", { set: { evidence_digest: bundle.digest, blocked_reason: null, next_action: "No further action", failed_attempts: 0, failure_class: null, retry_after_ms: null, updated_at_ms: this.store.now() }, bumpVersion: true });
        this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.transitioned", payload: { workItemId: item.id, state: "done", evidenceDigest: bundle.digest } });
        this.recordHealed(db, item);
        verifyOutputs(db, item.id);
        this.releaseReadyItems(db, item.mission_id);
        wake(this.store, db, item.mission_id, "work-verified", item.title);
      });
    } catch (cause) {
      if (!(cause instanceof BrainDomainError)) throw cause;
    }
  }

  /**
   * Ready work the Governor may start by itself: missions whose auto-start
   * switch is on that are active; a coordinator only plans, the Governor starts
   * a coordinated mission's work like any other's (ADR 0050). Each mission lists its free member slots (the
   * member cap minus in-progress work), whether its budget still has headroom,
   * and its ready, unparked items oldest first.
   */
  autoStartPlan(organizationId: string, workspaceId: string): Array<{ defaultWorkflowId: string | null; wayOfWorkingId: string | null; missionId: string; ownerId: string; slots: number; memberCap: number; headroom: boolean; items: Array<{ workItemId: string; title: string; criteria: string[]; upstream: Array<{ title: string; summary: string; deliverable?: string }>; memberId: string | null; workflowId: string | null; failedAttempts: number; runs: number; nextAction: string; requiredTools: string[]; failureClass: FailureClass | null; secondAttempt: boolean }> }> {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    // Only missions with ready work can contribute: a workspace keeps every mission it ever ran, and walking all of them on each command
    // (several prepared statements apiece) made every command slower as history grew (steady benchmark, trial over trial).
    const missions = db.prepare(`SELECT id, owner_id, member_cap FROM missions WHERE state='active' AND auto_start=1
      AND id IN (SELECT mission_id FROM work_items WHERE state='ready' AND parked=0) ORDER BY rowid`).all() as Array<{ id: string; owner_id: string; member_cap: number }>;
    const plan = [];
    for (const mission of missions) {
      const now = this.store.now();
      // The spend cap holds at dispatch too: a task that has used its tokens across attempts stops here, parked as budget, never retried automatically.
      for (const candidate of db.prepare("SELECT * FROM work_items WHERE mission_id=? AND state='ready' AND parked=0").all(mission.id) as WorkItemRow[]) {
        const used = taskTokens(this.store, db, candidate.id);
        if (used >= taskTokenCap(candidate) && (db.prepare("SELECT 1 FROM execution_links WHERE work_item_id=? LIMIT 1").get(candidate.id))) {
          this.store.inTx(db, () => {
            transitionState(db, "workItem", candidate.id, "blocked", { set: { parked: 1, parked_diagnostic: `The task used ${used} of ${taskTokenCap(candidate)} tokens across its attempts`, blocked_reason: `Parked: the task used its token allowance (${used} of ${taskTokenCap(candidate)} tokens)`, next_action: "Raise this task's token cap, split it or drop it", failure_class: "budget", updated_at_ms: now }, bumpVersion: true });
            this.store.emit(db, { aggregateType: "workItem", aggregateId: candidate.id, eventType: "workItem.parked", payload: { workItemId: candidate.id, missionId: candidate.mission_id, state: "blocked", failureClass: "budget" } });
            this.recordLesson(db, candidate, "budget", "parked");
          });
        }
      }
      const items = (db.prepare("SELECT * FROM work_items WHERE mission_id=? AND state='ready' AND parked=0 AND (retry_after_ms IS NULL OR retry_after_ms<=?) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at_ms, id").all(mission.id, now) as WorkItemRow[]);
      if (items.length === 0) continue;
      const running = (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE mission_id=? AND state='in-progress'").get(mission.id) as { n: number }).n;
      plan.push({
        wayOfWorkingId: wayOfWorking(this.store, workspaceId)?.workflowId ?? null,
        defaultWorkflowId: (db.prepare("SELECT workflow_id AS id FROM work_items WHERE mission_id=? AND workflow_id IS NOT NULL ORDER BY (SELECT COUNT(*) FROM work_items x WHERE x.mission_id=work_items.mission_id AND x.workflow_id=work_items.workflow_id) DESC, created_at_ms LIMIT 1").get(mission.id) as { id: string } | undefined)?.id ?? null,
        missionId: mission.id, ownerId: mission.owner_id, memberCap: mission.member_cap, slots: Math.max(0, mission.member_cap - running), headroom: hasHeadroom(this.store, db, mission.id),
        items: items.map((item) => ({ workItemId: item.id, title: item.title, criteria: JSON.parse(item.criteria_json) as string[], upstream: this.upstreamResults(db, item.id), memberId: memberOf(item.assignment_json), workflowId: item.workflow_id, failedAttempts: item.failed_attempts, runs: (db.prepare("SELECT COUNT(*) AS n FROM execution_links WHERE work_item_id=?").get(item.id) as { n: number }).n, nextAction: item.next_action, requiredTools: JSON.parse(item.required_tools_json) as string[], failureClass: item.failure_class, secondAttempt: item.failed_attempts > 0 && item.failure_class === "model-slip" })),
      });
    }
    return plan;
  }

  /**
   * The earlier mission this one was started from (the Today box records it in the brief as "Started from the earlier mission "<title>"
   * (<id>)") and what of it can seed this plan: the mission itself as a reuse item, and each of its verified outputs, pinned by exact
   * version as typed inputs. Only an achieved, closed mission of this workspace counts, and the list is bounded.
   */
  startedFrom(actor: ActorContext, workspaceId: string, missionId: string): { sourceMissionId: string; refs: string[]; inputs: OutputInput[] } | undefined {
    const db = this.db(actor, workspaceId);
    const brief = db.prepare("SELECT constraints_json FROM mission_brief_versions WHERE mission_id=? ORDER BY version DESC LIMIT 1").get(missionId) as { constraints_json: string } | undefined;
    if (!brief) return undefined;
    let sourceMissionId: string | undefined;
    for (const constraint of JSON.parse(brief.constraints_json) as string[]) sourceMissionId ??= /^Started from the earlier mission ".*" \(([\w-]{3,100})\);/su.exec(constraint)?.[1];
    if (!sourceMissionId || sourceMissionId === missionId) return undefined;
    const source = db.prepare("SELECT state, outcome FROM missions WHERE id=?").get(sourceMissionId) as { state: string; outcome: string | null } | undefined;
    if (!source || source.state !== "closed" || source.outcome !== "achieved") return undefined;
    const versions = db.prepare(`SELECT o.name AS name, (SELECT v.id FROM output_versions v WHERE v.output_id=o.id AND v.verified=1 ORDER BY v.created_at_ms DESC, v.id DESC LIMIT 1) AS versionId
      FROM mission_outputs o WHERE o.mission_id=? ORDER BY o.created_at_ms, o.rowid`).all(sourceMissionId) as Array<{ name: string; versionId: string | null }>;
    const pinned = versions.filter((row): row is { name: string; versionId: string } => row.versionId !== null).slice(0, PINNED_INPUT_LIMIT);
    return {
      sourceMissionId,
      refs: [`mission:${sourceMissionId}`, ...pinned.map((row) => `output:${row.versionId}`)],
      inputs: pinned.map((row) => ({ output: row.name, missionId: sourceMissionId, versionId: row.versionId })),
    };
  }

  /** The verified results a work item's task pins as inputs, as quoted upstream material: each bounded, labelled as earlier verified work. */
  private pinnedResults(db: ReturnType<Store["workspaceDb"]>, workItemId: string): Array<{ title: string; summary: string; deliverable?: string }> {
    let inputs: readonly OutputInput[];
    try { inputs = taskOf(db, workItemId).task.inputs ?? []; } catch { return []; }
    const results: Array<{ title: string; summary: string; deliverable?: string }> = [];
    for (const input of inputs.slice(0, PINNED_INPUT_LIMIT)) {
      const version = input.versionId ? db.prepare("SELECT artifact_digest AS digest FROM output_versions WHERE id=? AND verified=1").get(input.versionId) as { digest: string } | undefined : undefined;
      if (!version) continue;
      let text: string;
      try { text = new TextDecoder().decode(readVerified(this.store, version.digest)); } catch { continue; }
      const from = input.missionId ? (db.prepare("SELECT title FROM missions WHERE id=?").get(input.missionId) as { title: string } | undefined)?.title : undefined;
      results.push({ title: `Earlier verified result "${input.output}"${from ? ` of "${from}"` : ""}`, summary: "Verified in an earlier mission. A starting input to build on, not proof that any criterion of this task is met.", deliverable: text.slice(0, PINNED_INPUT_CHARS) });
    }
    return results;
  }

  /**
   * What the direct dependencies of a work item concluded: their current handoff summaries and, when the latest succeeded run
   * that carried them out wrote a deliverable, that deliverable (the run's immutable step output). The caller bounds how much
   * of it reaches the brief.
   */
  private upstreamResults(db: ReturnType<Store["workspaceDb"]>, workItemId: string): Array<{ title: string; summary: string; deliverable?: string }> {
    return [...this.pinnedResults(db, workItemId), ...dependencyHandoffs(db, workItemId).map((handoff) => {
      const deliverable = this.deliverableOf(db, handoff.workItemId);
      return {
        title: (db.prepare("SELECT title FROM work_items WHERE id=?").get(handoff.workItemId) as { title: string } | undefined)?.title ?? handoff.workItemId,
        summary: handoff.notes.summary,
        ...(deliverable ? { deliverable } : {}),
      };
    })];
  }

  /** What an independent re-check of a result reads: the task, its criteria and the deliverable the finished run wrote (issue #50). */
  resultOf(actor: ActorContext, workspaceId: string, workItemId: string): { missionId: string; title: string; state: WorkItemState; criteria: string[]; deliverable?: string; spendCapReached: boolean; missionBudgetReached: boolean } {
    const item = this.workItemRow(actor, workspaceId, workItemId);
    const db = this.db(actor, workspaceId);
    const deliverable = this.deliverableOf(db, item.id);
    // A challenge is a model run charged to the mission it reviews (its budget and usage) and bound by the workspace spend cap.
    const spendCapReached = capReached(db, this.store.now(), 0);
    const missionBudgetReached = !spendCapReached && !this.store.inTx(db, () => admitChallenge(this.store, db, item.mission_id)).admitted;
    return { missionId: item.mission_id, title: item.title, state: item.state, criteria: JSON.parse(item.criteria_json) as string[], spendCapReached, missionBudgetReached, ...(deliverable ? { deliverable } : {}) };
  }

  private deliverableOf(db: ReturnType<Store["workspaceDb"]>, workItemId: string): string | undefined {
    return taskResult(db, workItemId)?.text;
  }

  /** Says, on a ready work item, why the Governor has not started it. Writes only when the text changes. */
  noteStartBlocker(organizationId: string, workspaceId: string, workItemId: string, text: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    // A note is advice, not a state change: it leaves the version (and so every pending edit) and the order of work untouched.
    db.prepare(`UPDATE work_items SET next_action=?
      WHERE id=? AND state='ready' AND next_action!=?`).run(text.slice(0, 500), workItemId, text.slice(0, 500));
  }

  /**
   * Why a task cannot take a run that resumes a session from its checkpoint now; undefined when it can. A resumed run takes the task over from
   * whatever is waiting (a retry, or a person after repeated failures), so only a run already going, finished work or a stopped mission refuse it.
   */
  resumeBlocker(actor: ActorContext, workspaceId: string, workItemId: string): string | undefined {
    const item = this.workItemRow(actor, workspaceId, workItemId);
    const mission = this.missionRow(actor, workspaceId, item.mission_id);
    if (mission.state !== "active") return `The mission is ${mission.state}, so no new work starts on it.`;
    if (!["ready", "in-progress", "blocked"].includes(item.state)) return `The task is ${item.state === "review" ? "waiting for review" : item.state}, so it no longer needs this work.`;
    const going = this.db(actor, workspaceId).prepare("SELECT 1 AS ok FROM execution_links l JOIN workflow_runs r ON r.id=l.run_id WHERE l.work_item_id=? AND r.state IN ('created','validated','ready','running','suspended')").get(item.id);
    return going ? "A run for this task is already going, so it cannot also be resumed." : undefined;
  }

  linkExecution(actor: ActorContext, workspaceId: string, workItemId: string, runId: string, options: { resumed?: boolean } = {}): void {
    const item = this.workItemRow(actor, workspaceId, workItemId);
    const mission = this.missionRow(actor, workspaceId, item.mission_id);
    if (mission.state !== "active") throw new BrainDomainError("CONFLICT", `a ${mission.state} mission starts no new work sessions`);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      pinInputs(db, item.id, runId);
      db.prepare("INSERT OR IGNORE INTO execution_links(mission_id,work_item_id,run_id,created_at_ms) VALUES (?,?,?,?)").run(item.mission_id, item.id, runId, this.store.now());
      // A person resuming a stopped task releases it from the wait it was parked in; the run then starts it like any other.
      if (options.resumed && item.state === "blocked") {
        transitionState(db, "workItem", item.id, "ready", { set: { parked: 0, failed_attempts: 0, parked_diagnostic: null, blocked_reason: null, failure_class: null, next_action: "Resumed from a saved checkpoint", updated_at_ms: this.store.now() }, bumpVersion: true });
        this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.unparked", payload: { workItemId: item.id, state: "ready" } });
        item.state = "ready";
      }
      if (item.state === "ready") {
        this.assertDependenciesDone(db, item.id);
        transitionState(db, "workItem", item.id, "in-progress", { set: { next_action: "Complete and submit evidence", updated_at_ms: this.store.now() }, bumpVersion: true });
      }
    });
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, resourceId?: string, limit = 100, filter: WorkItemFilter = {}): JsonValue {
    const db = this.db(actor, workspaceId);
    if (queryType === "missions.list") {
      const rows = db.prepare("SELECT * FROM missions ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as MissionRow[];
      return { items: rows.map((row) => this.mission(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "evalCases.list") return listEvalCases(db, limit) as unknown as JsonValue;
    if (queryType === "missionOutputs.get") return outputDetail(db, String(resourceId)) as unknown as JsonValue;
    if (queryType === "missionOutputs.list") return { items: listOutputs(db, this.missionRow(actor, workspaceId, String(resourceId)).id) } as unknown as JsonValue;
    if (queryType === "pullRequests.list") {
      if (!resourceId) throw new BrainDomainError("INVALID_ARGUMENT", "a work item or an approval is required");
      return { items: listPullRequests(db, resourceId) } as unknown as JsonValue;
    }
    if (queryType === "workItemComments.list") return { items: listComments(this.store, db, actor.organizationId, this.workItemRow(actor, workspaceId, String(resourceId)).id, limit) } as unknown as JsonValue;
    if (queryType === "missionMessages.list") return { items: listMessages(this.store, db, this.missionRow(actor, workspaceId, String(resourceId)).id, limit) } as unknown as JsonValue;
    if (queryType === "missions.timeline") return missionTimeline(this.store, db, actor.organizationId, workspaceId, this.missionRow(actor, workspaceId, String(resourceId)).id, limit) as unknown as JsonValue;
    if (queryType === "handoffs.forWorkItem") return { items: dependencyHandoffs(db, this.workItemRow(actor, workspaceId, String(resourceId)).id) } as unknown as JsonValue;
    if (queryType === "missionBundles.latest") return (latestMissionBundle(db, this.missionRow(actor, workspaceId, String(resourceId)).id, modelRoutesUsable(this.store, workspaceId)) ?? null) as unknown as JsonValue;
    if (queryType === "missions.forSubject") {
      const rows = db.prepare("SELECT m.* FROM mission_subjects s JOIN missions m ON m.id=s.mission_id WHERE s.subject_id=? ORDER BY m.created_at_ms DESC LIMIT ?").all(String(resourceId), limit) as MissionRow[];
      return { items: rows.map((row) => this.mission(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "missions.brief") return this.brief(actor, workspaceId, this.missionRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "missions.get") {
      const row = this.missionRow(actor, workspaceId, String(resourceId));
      const watching = Boolean(db.prepare("SELECT 1 FROM mission_watchers WHERE principal_id=? AND mission_id=?").get(actor.actorId, row.id));
      return { ...this.mission(workspaceId, row), watching } as unknown as JsonValue;
    }
    if (queryType === "usage.run") return runUsage(this.store, db, workspaceId, String(resourceId)) as unknown as JsonValue;
    if (queryType === "usage.task") {
      const item = this.workItemRow(actor, workspaceId, String(resourceId));
      settleAll(this.store, db);
      const planned = (JSON.parse(this.planRow(actor, workspaceId, item.plan_version_id).tasks_json) as PlanTask[]).find((task) => task.id === item.plan_task_id);
      return { scope: "task", id: item.id, usage: taskUsage(db, item.id), ...(planned && (planned.estimatedMinutes !== undefined || planned.maxMicroUsd !== undefined) ? { planEstimate: { ...(planned.estimatedMinutes !== undefined ? { estimatedMinutes: planned.estimatedMinutes } : {}), ...(planned.maxMicroUsd !== undefined ? { maxMicroUsd: planned.maxMicroUsd } : {}) } } : {}) } as unknown as JsonValue;
    }
    if (queryType === "usage.mission") {
      const mission = this.missionRow(actor, workspaceId, String(resourceId));
      settleAll(this.store, db);
      return { scope: "mission", id: mission.id, usage: missionUsage(db, mission.id), breakdown: missionBreakdown(db, mission.id) } as unknown as JsonValue;
    }
    if (queryType === "usage.agent") { settleAll(this.store, db); return { scope: "agent", id: String(resourceId), ...agentUsage(db, String(resourceId)) } as unknown as JsonValue; }
    if (queryType === "usage.member") {
      // One member of one mission: `<missionId>:<memberId>` (a member id is a plan's own label, a mission id never ends in one).
      const [missionPart, memberId = ""] = String(resourceId).split(/:(?=[^:]*$)/u);
      const mission = this.missionRow(actor, workspaceId, missionPart ?? "");
      settleAll(this.store, db);
      return { scope: "member", id: String(resourceId), ...memberUsage(db, mission.id, memberId) } as unknown as JsonValue;
    }
    if (queryType === "usage.series") {
      // `resourceId` is `<scope>:<id>` (`workspace`, `mission:<missionId>`, `agent:<agentId>`); `limit` is the number of days ending today.
      const [scope = "", ...rest] = String(resourceId ?? "workspace").split(":");
      const id = rest.join(":");
      const days = Math.min(limit, SERIES_MAX_DAYS);
      settleAll(this.store, db);
      if (scope === "workspace") return spendSeries(db, "workspace", workspaceId, this.store.now(), days) as unknown as JsonValue;
      if (scope === "mission") return spendSeries(db, "mission", this.missionRow(actor, workspaceId, id).id, this.store.now(), days) as unknown as JsonValue;
      if (scope === "agent" && id) return spendSeries(db, "agent", id, this.store.now(), days) as unknown as JsonValue;
      throw new BrainDomainError("INVALID_ARGUMENT", "usage.series needs workspace, mission:<id> or agent:<id>");
    }
    if (queryType === "usage.verifiedCost") { settleAll(this.store, db); return verifiedCost(db, this.store.now(), 30) as unknown as JsonValue; }
    if (queryType === "usage.workspace") { settleAll(this.store, db); return { scope: "workspace", id: workspaceId, usage: workspaceUsage(db), outsideMissions: outsideMissionsUsage(db), spendCap: spendCapOf(db, this.store.now()) } as unknown as JsonValue; }
    if (queryType === "plans.estimate") return planEstimate(this.plan(workspaceId, this.planRow(actor, workspaceId, String(resourceId))), db) as unknown as JsonValue;
    if (queryType === "plans.get") return this.plan(workspaceId, this.planRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "workItems.list") {
      // Every filter narrows in SQL before the page limit, so the board of a busy workspace never loses older matching work behind newer work.
      const { missionId = null, memberId = null, priority = null, tag = null } = filter;
      const rows = db.prepare(`SELECT * FROM work_items WHERE state!='abandoned'
        AND (? IS NULL OR mission_id=?) AND (? IS NULL OR json_extract(assignment_json,'$.id')=?) AND (? IS NULL OR priority=?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value=?)) ORDER BY updated_at_ms DESC,id LIMIT ?`)
        .all(missionId, missionId, memberId, memberId, priority, priority, tag, tag, limit) as WorkItemRow[];
      return { items: rows.map((row) => this.workItem(actor, workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "lessons.list") return { items: this.lessons(db, limit) } as unknown as JsonValue;
    if (queryType === "workItems.get") return this.workItem(actor, workspaceId, this.workItemRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "executionLinks.list") {
      const rows = db.prepare("SELECT * FROM execution_links ORDER BY created_at_ms DESC,run_id LIMIT ?").all(limit) as Array<{ mission_id: string; work_item_id: string; run_id: string; job_id: string | null; attempt_id: string | null; session_id: string | null; created_at_ms: number }>;
      const items: ExecutionLink[] = rows.map((row) => ({
        missionId: row.mission_id, workItemId: row.work_item_id, runId: row.run_id,
        ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}),
        createdAt: iso(row.created_at_ms),
      }));
      return { items } as unknown as JsonValue;
    }
    throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `unsupported work query ${queryType}`);
  }

  /** Lessons from healed or parked failures that have not expired, newest first: what the planner is told. */
  lessons(db: ReturnType<Store["workspaceDb"]>, limit: number): Array<{ lessonId: string; failureClass: FailureClass; outcome: "healed" | "parked"; taskTitle: string; lesson: string; createdAt: string; expiresAt: string }> {
    return (db.prepare("SELECT id, failure_class, outcome, task_title, lesson, created_at_ms, expires_at_ms FROM lessons WHERE expires_at_ms>? ORDER BY created_at_ms DESC, id LIMIT ?").all(this.store.now(), limit) as Array<{ id: string; failure_class: FailureClass; outcome: "healed" | "parked"; task_title: string; lesson: string; created_at_ms: number; expires_at_ms: number }>)
      .map((row) => ({ lessonId: row.id, failureClass: row.failure_class, outcome: row.outcome, taskTitle: row.task_title, lesson: row.lesson, createdAt: iso(row.created_at_ms), expiresAt: iso(row.expires_at_ms) }));
  }

  /** The planner's "Lessons from earlier work" lines for a workspace, bounded; empty when there are none. */
  lessonsPrompt(actor: ActorContext, workspaceId: string): string {
    const items = this.lessons(this.db(actor, workspaceId), 4);
    return items.length === 0 ? "" : `Lessons from earlier work in this workspace (what went wrong and what to do differently):\n${items.map((item) => `- ${item.lesson}`).join("\n")}`.slice(0, 700);
  }

}

/** Notes the auto-start sweep leaves on ready work; switching auto-start off restores the plain prompt. */
export const START_NOTE_PREFIXES = ["Needs input before it can start", "Waiting for budget", "Waiting for a free member", "Could not start automatically"] as const;

function clearStartNotes(db: ReturnType<Store["workspaceDb"]>, missionId: string): void {
  for (const prefix of START_NOTE_PREFIXES) db.prepare(`UPDATE work_items SET next_action='Start this task'
    WHERE mission_id=? AND state='ready' AND next_action LIKE ?`).run(missionId, `${prefix}%`);
}

/**
 * The intent and success criteria in a described piece of work: the situation text "Repeat this" writes
 * ("<intent>\n\nDone when:\n- <criterion>..."). Bounded so a long description still fits the mission brief.
 */
export function describedWork(situation: string, fallbackTitle: string): { intent: string; criteria: string[] } {
  const marker = /\n\s*Done when:\s*\n/iu.exec(situation);
  const head = marker ? situation.slice(0, marker.index) : situation;
  const criteria = marker
    ? situation.slice(marker.index + marker[0].length).split("\n").map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/u, "").trim()).filter(Boolean).map((line) => line.slice(0, 500)).slice(0, 12)
    : [];
  const intent = head.trim().slice(0, BRIEF_CHAR_CAP - 2000) || fallbackTitle;
  return { intent, criteria: criteria.length > 0 ? criteria : ["The written result addresses the request and states its assumptions"] };
}

function assertNotClosed(mission: { state: string }): void {
  if (mission.state === "closed") throw new BrainDomainError("CONFLICT", "a closed mission is terminal; start a follow-up mission");
}

function briefChars(intent: string, constraints: readonly string[], decisions: readonly string[]): number {
  return intent.length + constraints.reduce((sum, entry) => sum + entry.length, 0) + decisions.reduce((sum, entry) => sum + entry.length, 0);
}

function assertBriefSize(intent: string, constraints: readonly string[], decisions: readonly string[]): void {
  const size = briefChars(intent, constraints, decisions);
  if (size > BRIEF_CHAR_CAP) throw new BrainDomainError("INVALID_ARGUMENT", `the mission brief would hold ${size} characters; condense it to at most ${BRIEF_CHAR_CAP}`);
}
