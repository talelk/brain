import { domainDigest } from "@brain/contracts";
import type { AcceptedDecision, ActorContext, AutonomyPolicy, AutonomyPreset, ExecutionLink, JsonValue, Mission, MissionBrief, MissionOutcome, PlanAssignment, PlanOperation, PlanTask, PlanVersion, TeamMember, WorkItem, WorkItemState } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { assertExpectedVersion, assertTransition, transitionState } from "../../domain/states";
import { assertPlanTasks } from "../../domain/work-plan";
import { AUTONOMY_PRESETS, assertTeamEligible, beyondPolicy, diffPlan, policyFor, teamOperations, withinCeiling, type AgentCapabilities } from "../../domain/mission-policy";
import { activeReleaseRecord } from "../configuration/index";
import { pump, wake, coordinatorInput, type CoordinatorPort } from "./coordinator";
import { admit, budgetOf, clockSet, hasHeadroom, reserve as reserveSpend, settle, usageOf } from "./budget";
import { listMessages, listOutputs, outputDetail, pinInputs, recordOutputVersion, sendMessage, verifyOutputs } from "./outputs";
import { assembleMissionBundle, dependencyHandoffs, finalizeHandoff, latestMissionBundle, recordMissionVerdict, submitHandoff } from "../evidence/index";
import type { HandoffNotes } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

export interface MissionCommand {
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly expectedVersion?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

type MissionRow = {
  id: string; title: string; intent: string; success_criteria_json: string; owner_id: string;
  active_plan_version_id: string | null; state: Mission["state"]; pause_reason: "human" | "budget" | null;
  outcome: MissionOutcome | null; brief_version: number; policy_json: string; parking_threshold: number;
  budget_micro_usd: number | null; budget_wall_ms: number | null; member_cap: number; attempt_reserve_micro_usd: number; final_allowance_micro_usd: number;
  coordinator_member_id: string | null; coordinator_workflow: string | null;
  active_ms: number; active_since_ms: number | null;
  version: number; created_at_ms: number; updated_at_ms: number;
};
type BriefRow = { mission_id: string; version: number; intent: string; constraints_json: string; change: string; rebased_from: number | null; created_by: string; created_at_ms: number };
type DecisionRow = { id: string; mission_id: string; statement: string; source_kind: AcceptedDecision["source"]["kind"]; source_ref: string | null; accepted_by: string; introduced_version: number; superseded_by: string | null; created_at_ms: number };

/** Work that has started is never changed or abandoned by replanning (issue #39). */
const STARTED: ReadonlySet<WorkItemState> = new Set(["in-progress", "review", "blocked", "done"]);
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
  version: number; created_at_ms: number; updated_at_ms: number;
};

/** Live message delivery is the sessions module's, bound at the composition root. */
export interface MissionDeliveryPort {
  deliver(organizationId: string, workspaceId: string, messageId: string, interrupt: boolean): unknown;
}

export class MissionService {
  constructor(private readonly store: Store, private readonly delivery?: MissionDeliveryPort, private readonly coordinatorPort?: CoordinatorPort, private readonly capitalization?: { requestMissionRun(organizationId: string, workspaceId: string, missionId: string): string }) {}

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
    return {
      budget: budgetOf(row), usage: usageOf(db, row, this.store.now()),
      subjects: (db.prepare("SELECT pack, kind, subject_id FROM mission_subjects WHERE mission_id=? ORDER BY kind, subject_id").all(row.id) as Array<{ pack: "support" | "sre"; kind: "ticket" | "incident"; subject_id: string }>).map((entry) => ({ pack: entry.pack, kind: entry.kind, id: entry.subject_id })),
      missionId: row.id, workspaceId, title: row.title, intent: row.intent,
      successCriteria: JSON.parse(row.success_criteria_json) as string[], ownerId: row.owner_id,
      ...(row.active_plan_version_id ? { activePlanVersionId: row.active_plan_version_id } : {}),
      state: row.state, ...(row.pause_reason ? { pauseReason: row.pause_reason } : {}), ...(row.outcome ? { outcome: row.outcome } : {}),
      briefVersion: row.brief_version, autonomyPolicy: JSON.parse(row.policy_json) as AutonomyPolicy, parkingThreshold: row.parking_threshold,
      version: row.version, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
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
    const dependsOn = (this.db(actor, workspaceId).prepare("SELECT depends_on_work_item_id AS id FROM work_item_dependencies WHERE work_item_id=? ORDER BY depends_on_work_item_id").all(row.id) as Array<{ id: string }>).map((entry) => entry.id);
    return {
      workItemId: row.id, missionId: row.mission_id, planVersionId: row.plan_version_id,
      planTaskId: row.plan_task_id, workspaceId, title: row.title, state: row.state,
      criteria: JSON.parse(row.criteria_json) as string[], dependsOn,
      ...(row.assignment_json ? { assignment: JSON.parse(row.assignment_json) as PlanAssignment } : {}),
      ...(row.workflow_id ? { workflowId: row.workflow_id } : {}), nextAction: row.next_action,
      ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
      ...(row.scheduled_at_ms ? { scheduledAt: iso(row.scheduled_at_ms) } : {}),
      ...(row.evidence_digest ? { evidenceDigest: row.evidence_digest } : {}),
      failedAttempts: row.failed_attempts, parked: row.parked === 1,
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
      case "mission.budget.set": return this.setBudget(actor, workspaceId, command.payload, command.expectedVersion);
      case "handoff.submit": return this.handoff(actor, workspaceId, command.payload);
      case "mission.verdict.record": return this.verdict(actor, workspaceId, command.payload);
      case "plan.propose": return this.proposePlan(actor, workspaceId, command.payload);
      case "plan.confirm": return this.confirmPlan(actor, workspaceId, command.payload, command.expectedVersion);
      case "workItem.transition": return this.transition(actor, workspaceId, command.payload, command.expectedVersion);
      case "workItem.comment": return this.comment(actor, workspaceId, command.payload);
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
      const budget = (payload["budget"] as { maxMicroUsd?: number; maxWallClockMs?: number; memberCap?: number; attemptReserveMicroUsd?: number; finalAllowanceMicroUsd?: number } | undefined) ?? play?.spec.budget ?? {};
      db.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,policy_json,parking_threshold,budget_micro_usd,budget_wall_ms,member_cap,attempt_reserve_micro_usd,active_since_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, String(payload["title"]), intent, JSON.stringify(successCriteria), actor.actorId, JSON.stringify(policy), Number(payload["parkingThreshold"] ?? play?.spec.parkingThreshold ?? 3),
          budget.maxMicroUsd ?? null, budget.maxWallClockMs ?? null, budget.memberCap ?? 3, budget.attemptReserveMicroUsd ?? 0, now, now, now);
      if (budget.finalAllowanceMicroUsd) db.prepare("UPDATE missions SET final_allowance_micro_usd=? WHERE id=?").run(budget.finalAllowanceMicroUsd, id);
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
    const team = (payload["team"] as TeamMember[] | undefined) ?? [];
    assertPlanTasks(tasks);
    assertTeamEligible(team, tasks, this.agentCapabilities(actor.organizationId));
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
    const started = new Set((db.prepare("SELECT plan_task_id AS id, state FROM work_items WHERE mission_id=? AND state!='abandoned'").all(mission.id) as Array<{ id: string; state: WorkItemState }>)
      .filter((row) => STARTED.has(row.state)).map((row) => row.id));
    const diff = diffPlan(confirmed, tasks, started);
    const policy = JSON.parse(mission.policy_json) as AutonomyPolicy;
    const beyond = [...new Set([...beyondPolicy(diff, policy), ...teamOperations(JSON.parse(active.team_json) as TeamMember[], team).filter((operation) => !policy.operations.includes(operation))])].sort();
    return { autoConfirm: actor.kind === "agent" && mission.state === "active" && beyond.length === 0, beyond };
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
    this.gate(actor, workspaceId, mission, tasks, JSON.parse(plan.team_json) as TeamMember[]);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      const priorActive = mission.active_plan_version_id;
      if (priorActive) transitionState(db, "planVersion", priorActive, "superseded");
      const previous = db.prepare("SELECT * FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY created_at_ms DESC,id DESC").all(mission.id) as WorkItemRow[];
      const latestByTask = new Map<string, WorkItemRow>();
      for (const item of previous) if (!latestByTask.has(item.plan_task_id)) latestByTask.set(item.plan_task_id, item);
      const selected = new Map<string, string>();
      const retained = new Set<string>();
      const now = this.store.now();
      for (const task of tasks) {
        const prior = latestByTask.get(task.id);
        if (prior && prior.plan_version_id === priorActive && this.sameTask(db, prior, task)) {
          selected.set(task.id, prior.id);
          retained.add(prior.id);
          continue;
        }
        const id = this.store.id("work");
        selected.set(task.id, id);
        const state: WorkItemState = task.dependsOn.length === 0 ? "ready" : "backlog";
        // Failed attempts follow the plan task across members: reassignment never resets the parking count.
        const carried = prior && prior.state !== "done" ? prior.failed_attempts : 0;
        db.prepare(`INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,assignment_json,workflow_id,next_action,failed_attempts,created_at_ms,updated_at_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, mission.id, plan.id, task.id, task.title, state, JSON.stringify(task.criteria),
          task.assignment ? JSON.stringify(task.assignment) : null, task.workflowId ?? null,
          state === "ready" ? "Start this task" : "Wait for predecessor completion", carried, now, now);
      }
      for (const item of previous) {
        if (retained.has(item.id) || STARTED.has(item.state)) continue;
        transitionState(db, "workItem", item.id, "abandoned", { set: { next_action: `Superseded by plan revision ${plan.revision}`, updated_at_ms: now }, bumpVersion: true });
      }
      for (const task of tasks) {
        const workItemId = selected.get(task.id);
        if (!workItemId || retained.has(workItemId)) continue;
        for (const dependency of task.dependsOn) {
          const dependencyId = selected.get(dependency);
          if (!dependencyId) throw new BrainDomainError("INTERNAL_ERROR", "confirmed plan dependency was not materialized");
          db.prepare("INSERT INTO work_item_dependencies(work_item_id,depends_on_work_item_id) VALUES (?,?)").run(workItemId, dependencyId);
        }
      }
      transitionState(db, "planVersion", plan.id, "confirmed", { set: { confirmed_at_ms: now } });
      db.prepare("UPDATE missions SET active_plan_version_id=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(plan.id, now, mission.id, mission.version);
      this.store.emit(db, { aggregateType: "plan", aggregateId: plan.id, eventType: "plan.confirmed", payload: { missionId: mission.id, planVersionId: plan.id, digest: plan.digest } });
      if (!withinPolicy) wake(this.store, db, mission.id, "plan-resolved", `plan revision ${plan.revision} confirmed`);
    });
    return plan.id;
  }

  private sameTask(db: ReturnType<Store["workspaceDb"]>, prior: WorkItemRow, task: PlanTask): boolean {
    if (prior.title !== task.title || prior.workflow_id !== (task.workflowId ?? null)) return false;
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
      if (next === "done") { this.assertEvidence(db, item, evidenceDigest); finalizeHandoff(db, item.id, evidenceDigest as string); }
      const nextAction = next === "done" ? "No further action" : next === "review" ? "Review verified results" : next === "blocked" ? reason ?? "Resolve blocker" : next === "ready" ? "Start this task" : next === "in-progress" ? "Complete and submit evidence" : next === "abandoned" ? "Superseded or abandoned" : "Wait for predecessor completion";
      const unpark = item.parked === 1 && next !== "blocked";
      const resetCount = unpark || next === "review" || next === "done";
      transitionState(db, "workItem", item.id, next, { set: { blocked_reason: next === "blocked" ? reason : null, evidence_digest: evidenceDigest ?? null, next_action: nextAction, updated_at_ms: this.store.now(), ...(resetCount ? { failed_attempts: 0 } : {}), ...(unpark ? { parked: 0, parked_diagnostic: null } : {}) }, bumpVersion: true, and: { version: item.version } });
      if (unpark) this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.unparked", payload: { workItemId: item.id, state: next } });
      this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.transitioned", payload: { workItemId: item.id, state: next, ...(evidenceDigest ? { evidenceDigest } : {}) } });
      if (next === "done") { verifyOutputs(db, item.id); this.releaseReadyItems(db, item.mission_id); wake(this.store, db, item.mission_id, "work-verified", item.title); }
    });
    return item.id;
  }

  private assertDependenciesDone(db: ReturnType<Store["workspaceDb"]>, workItemId: string): void {
    const pending = db.prepare("SELECT w.id,w.state FROM work_item_dependencies d JOIN work_items w ON w.id=d.depends_on_work_item_id WHERE d.work_item_id=? AND w.state!='done'").all(workItemId) as Array<{ id: string; state: string }>;
    if (pending.length > 0) throw new BrainDomainError("CONFLICT", `work item dependencies are not complete: ${pending.map((entry) => entry.id).join(", ")}`);
  }

  private assertEvidence(db: ReturnType<Store["workspaceDb"]>, item: WorkItemRow, digest: string | null): void {
    if (!digest) throw new BrainDomainError("EVIDENCE_MISSING", "Done requires verified evidence");
    const bundle = db.prepare("SELECT state,manifest_json FROM evidence_bundles WHERE digest=?").get(digest) as { state: string; manifest_json: string } | undefined;
    if (!bundle || bundle.state !== "verified") throw new BrainDomainError("EVIDENCE_MISSING", "Done requires a verified evidence bundle");
    if (!db.prepare("SELECT 1 FROM verification_verdicts WHERE bundle_digest=? AND outcome='verified'").get(digest)) throw new BrainDomainError("EVIDENCE_MISSING", "evidence has no accepted independent verdict");
    const manifest = JSON.parse(bundle.manifest_json) as { checks?: Array<{ criterionId: string; status: string }> };
    const passed = new Set((manifest.checks ?? []).filter((check) => check.status === "passed").map((check) => check.criterionId));
    const criteria = JSON.parse(item.criteria_json) as string[];
    const missing = criteria.filter((criterion) => !passed.has(criterion));
    if (missing.length > 0) throw new BrainDomainError("EVIDENCE_MISSING", `verified evidence does not cover criteria: ${missing.join(", ")}`);
  }

  private releaseReadyItems(db: ReturnType<Store["workspaceDb"]>, missionId: string): void {
    const candidates = db.prepare("SELECT id FROM work_items WHERE mission_id=? AND parked=0 AND state IN ('backlog','blocked')").all(missionId) as Array<{ id: string }>;
    for (const candidate of candidates) {
      const pending = db.prepare("SELECT 1 FROM work_item_dependencies d JOIN work_items w ON w.id=d.depends_on_work_item_id WHERE d.work_item_id=? AND w.state!='done' LIMIT 1").get(candidate.id);
      if (!pending) transitionState(db, "workItem", candidate.id, "ready", { set: { blocked_reason: null, next_action: "Start this task", updated_at_ms: this.store.now() }, bumpVersion: true });
    }
  }

  private comment(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const item = this.workItemRow(actor, workspaceId, String(payload["workItemId"]));
    const db = this.db(actor, workspaceId);
    const id = this.store.id("comment");
    db.prepare("INSERT INTO work_item_comments(id,work_item_id,actor_id,body,created_at_ms) VALUES (?,?,?,?,?)")
      .run(id, item.id, actor.actorId, String(payload["text"]), this.store.now());
    return id;
  }

  /** Published agent definitions of the organization's active release, as eligibility sees them. */
  private agentCapabilities(organizationId: string): Record<string, AgentCapabilities> {
    const agents = activeReleaseRecord(this.store, organizationId)?.release.agents ?? {};
    return Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, { tools: agent.spec.tools.map((tool) => tool.id), engines: [...agent.spec.engine.anyOf], maxMicroUsd: agent.spec.maxMicroUsd }]));
  }

  /**
   * A scheduled or triggered start of a Play (T52): the mission is started on
   * behalf of the person who set up the automation, so ownership and
   * notification follow them; its plan and team wait for human confirmation.
   */
  startFromPlay(input: { organizationId: string; workspaceId: string; playId: string; startedBy: string; occurrenceId: string; subjects?: readonly { pack: "support" | "sre"; kind: "ticket" | "incident"; id: string }[] }): string {
    const play = activeReleaseRecord(this.store, input.organizationId)?.release.plays?.[input.playId];
    if (!play) throw new BrainDomainError("NOT_FOUND", `play ${input.playId} is not in the active release`);
    const actor: ActorContext = { kind: "workflow", actorId: input.startedBy, organizationId: input.organizationId, workspaceId: input.workspaceId, scopes: [], authMethod: "service-credential", authGeneration: 1 };
    const existing = this.store.workspaceDb(input.workspaceId, input.organizationId).prepare("SELECT id FROM missions WHERE started_by_occurrence=?").get(input.occurrenceId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = this.createMission(actor, input.workspaceId, { title: play.spec.title, playId: input.playId, ...(input.subjects ? { subjects: input.subjects } : {}) });
    this.store.workspaceDb(input.workspaceId, input.organizationId).prepare("UPDATE missions SET started_by_occurrence=? WHERE id=?").run(input.occurrenceId, id);
    return id;
  }

  isOpen(organizationId: string, workspaceId: string, missionId: string): boolean {
    const row = this.store.workspaceDb(workspaceId, organizationId).prepare("SELECT state FROM missions WHERE id=?").get(missionId) as { state: string } | undefined;
    return Boolean(row && row.state !== "closed");
  }

  /** A human sets the mission's budget; raising it is what lifts a budget pause on resume. */
  private setBudget(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "only humans set a mission budget");
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertExpectedVersion(mission.version, expectedVersion);
    assertNotClosed(mission);
    const budget = payload["budget"] as { maxMicroUsd?: number; maxWallClockMs?: number; memberCap: number; attemptReserveMicroUsd?: number; finalAllowanceMicroUsd?: number };
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("UPDATE missions SET budget_micro_usd=?,budget_wall_ms=?,member_cap=?,attempt_reserve_micro_usd=?,final_allowance_micro_usd=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(budget.maxMicroUsd ?? null, budget.maxWallClockMs ?? null, budget.memberCap, budget.attemptReserveMicroUsd ?? mission.attempt_reserve_micro_usd, budget.finalAllowanceMicroUsd ?? mission.final_allowance_micro_usd, this.store.now(), mission.id, mission.version);
      this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.budgetChanged", payload: { missionId: mission.id } });
      wake(this.store, db, mission.id, "budget-changed");
    });
    return mission.id;
  }

  /** Mission-local admission for a run's next attempt; a run linked to no mission is interactive work. */
  admission(organizationId: string, workspaceId: string, runId: string): { missionId?: string; admitted: true; reserve: number; running: number } | { missionId: string; admitted: false; reason: string; running: number } {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const work = db.prepare("SELECT mission_id FROM execution_links WHERE run_id=? LIMIT 1").get(runId) as { mission_id: string } | undefined;
    const coordinatorRun = work ? undefined : db.prepare("SELECT mission_id FROM mission_runs WHERE run_id=?").get(runId) as { mission_id: string } | undefined;
    const link = work ?? coordinatorRun;
    if (!link) return { admitted: true, reserve: 0, running: 0 };
    const decision = this.store.inTx(db, () => admit(this.store, db, link.mission_id, Boolean(coordinatorRun), (missionId) => wake(this.store, db, missionId, "mission-paused", "budget exhausted; write the final checkpoint")));
    return { missionId: link.mission_id, ...decision };
  }

  recordReservation(organizationId: string, workspaceId: string, input: { missionId: string; runId: string; attemptId: string; microUsd: number }): void {
    reserveSpend(this.store, this.store.workspaceDb(workspaceId, organizationId), input);
  }

  /** Governor-internal: an attempt produced a version of a named output its plan task declares. */
  recordOutput(organizationId: string, workspaceId: string, input: Parameters<typeof recordOutputVersion>[2]): string {
    return recordOutputVersion(this.store, this.store.workspaceDb(workspaceId, organizationId), input);
  }

  private message(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind !== "human") throw new BrainDomainError("FORBIDDEN", "mission messages come from humans");
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertNotClosed(mission);
    const team = mission.active_plan_version_id ? (JSON.parse(this.planRow(actor, workspaceId, mission.active_plan_version_id).team_json) as TeamMember[]).map((member) => member.memberId) : [];
    const messageId = sendMessage(this.store, this.db(actor, workspaceId), {
      missionId: mission.id, senderId: actor.actorId, recipient: payload["recipient"] as { kind: "mission" | "member"; memberId?: string },
      body: String(payload["body"]), team,
      ...(payload["workItemId"] ? { workItemId: String(payload["workItemId"]) } : {}), ...(payload["correctionOf"] ? { correctionOf: String(payload["correctionOf"]) } : {}),
    });
    this.delivery?.deliver(actor.organizationId, workspaceId, messageId, payload["interrupt"] === true);
    // A message to the mission itself (no work item) wakes its coordinator (#38).
    if ((payload["recipient"] as { kind?: string } | undefined)?.kind === "mission" && !payload["workItemId"]) wake(this.store, this.db(actor, workspaceId), mission.id, "message", String(payload["body"]).slice(0, 200));
    return messageId;
  }

  /** Mission lifecycle per issue #19: humans pause, resume and close; completion is proposed, never declared. */
  private changeState(actor: ActorContext, workspaceId: string, type: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    assertExpectedVersion(mission.version, expectedVersion);
    assertNotClosed(mission);
    const db = this.db(actor, workspaceId);
    const now = this.store.now();
    let next: Mission["state"]; const set: Record<string, unknown> = { updated_at_ms: now, pause_reason: null };
    if (type === "mission.pause") { next = "paused"; set["pause_reason"] = "human"; }
    else if (type === "mission.resume") {
      if (mission.pause_reason === "budget" && !hasHeadroom(this.store, this.db(actor, workspaceId), mission.id)) throw new BrainDomainError("CONFLICT", "raise the mission budget before resuming a budget pause");
      next = "active";
    } else if (type === "mission.proposeCompletion") next = "verifying";
    else {
      const outcome = String(payload["outcome"]) as MissionOutcome;
      if (outcome === "achieved" && (mission.state !== "verifying" || latestMissionBundle(db, mission.id)?.state !== "verified")) throw new BrainDomainError("EVIDENCE_MISSING", "achieved requires a verified mission verdict");
      next = "closed"; set["outcome"] = outcome;
    }
    if (next !== "closed" && mission.state === next) throw new BrainDomainError("CONFLICT", `mission is already ${next}`);
    this.store.inTx(db, () => {
      transitionState(db, "mission", mission.id, next, { set: { ...set, ...clockSet(next, mission, now) }, bumpVersion: true, and: { version: mission.version } });
      if (set["outcome"] === "cancelled") {
        const open = db.prepare("SELECT id FROM work_items WHERE mission_id=? AND state NOT IN ('done','abandoned')").all(mission.id) as Array<{ id: string }>;
        for (const item of open) transitionState(db, "workItem", item.id, "abandoned", { set: { next_action: "Mission cancelled", updated_at_ms: now }, bumpVersion: true });
      }
      this.store.emit(db, { aggregateType: "mission", aggregateId: mission.id, eventType: "mission.stateChanged", payload: { missionId: mission.id, missionState: next } });
    });
    if (next === "closed") this.capitalization?.requestMissionRun(actor.organizationId, workspaceId, mission.id);
    if (next === "verifying") {
      const bundle = this.store.inTx(db, () => assembleMissionBundle(this.store, db, mission.id, mission.brief_version));
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

  /** An independent verdict on the mission's evidence bundle; a team agent can never record it. */
  private verdict(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    if (actor.kind === "agent") throw new BrainDomainError("FORBIDDEN", "a team member cannot judge its own mission");
    const mission = this.missionRow(actor, workspaceId, String(payload["missionId"]));
    if (mission.state !== "verifying") throw new BrainDomainError("CONFLICT", "only a verifying mission takes a verdict");
    const db = this.db(actor, workspaceId);
    const outcome = String(payload["outcome"]) as "verified" | "rejected";
    const findings = (payload["findings"] as string[] | undefined) ?? [];
    this.store.inTx(db, () => recordMissionVerdict(this.store, db, { missionId: mission.id, digest: String(payload["bundleDigest"]), outcome, findings, by: actor.actorId }));
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
    if (!preset && !operations) throw new BrainDomainError("INVALID_ARGUMENT", "a preset or an operation list is required");
    const next: AutonomyPolicy = operations
      ? { ...(preset ? { preset } : {}), operations: [...new Set(operations)].sort(), version: current.version + 1 }
      : { preset: preset as AutonomyPreset, operations: [...AUTONOMY_PRESETS[preset as AutonomyPreset]].sort(), version: current.version + 1 };
    const ceiling = this.ceiling(workspaceId);
    const beyond = next.operations.filter((operation) => !ceiling.includes(operation));
    if (beyond.length > 0) throw new BrainDomainError("FORBIDDEN", `the workspace autonomy ceiling does not allow ${beyond.join(", ")}`);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("UPDATE missions SET policy_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?").run(JSON.stringify(next), this.store.now(), mission.id, mission.version);
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
      for (const item of items) {
        const threshold = (db.prepare("SELECT parking_threshold AS n FROM missions WHERE id=?").get(item.mission_id) as { n: number }).n;
        const failed = item.failed_attempts + 1;
        const detail = diagnostic.slice(0, 1024);
        const now = this.store.now();
        if (failed >= threshold) {
          transitionState(db, "workItem", item.id, "blocked", { set: { failed_attempts: failed, parked: 1, parked_diagnostic: detail, blocked_reason: `Parked after ${failed} failed attempts`, next_action: "A human retries, reassigns, edits or drops this work", updated_at_ms: now }, bumpVersion: true });
          this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.parked", payload: { workItemId: item.id, missionId: item.mission_id, state: "blocked" } });
        } else {
          if (item.state !== "ready") transitionState(db, "workItem", item.id, item.state === "review" ? "in-progress" : "ready", { set: { failed_attempts: failed, next_action: `Retry after failed attempt ${failed} of ${threshold}`, updated_at_ms: now }, bumpVersion: true });
          else db.prepare("UPDATE work_items SET failed_attempts=?,version=version+1,updated_at_ms=? WHERE id=?").run(failed, now, item.id);
        }
      }
    });
  }

  linkExecution(actor: ActorContext, workspaceId: string, workItemId: string, runId: string): void {
    const item = this.workItemRow(actor, workspaceId, workItemId);
    const mission = this.missionRow(actor, workspaceId, item.mission_id);
    if (mission.state !== "active") throw new BrainDomainError("CONFLICT", `a ${mission.state} mission starts no new work sessions`);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      pinInputs(db, item.id, runId);
      db.prepare("INSERT OR IGNORE INTO execution_links(mission_id,work_item_id,run_id,created_at_ms) VALUES (?,?,?,?)").run(item.mission_id, item.id, runId, this.store.now());
      if (item.state === "ready") {
        this.assertDependenciesDone(db, item.id);
        transitionState(db, "workItem", item.id, "in-progress", { set: { next_action: "Complete and submit evidence", updated_at_ms: this.store.now() }, bumpVersion: true });
      }
    });
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, resourceId?: string, limit = 100): JsonValue {
    const db = this.db(actor, workspaceId);
    if (queryType === "missions.list") {
      const rows = db.prepare("SELECT * FROM missions ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as MissionRow[];
      return { items: rows.map((row) => this.mission(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "missionOutputs.get") return outputDetail(db, String(resourceId)) as unknown as JsonValue;
    if (queryType === "missionOutputs.list") return { items: listOutputs(db, this.missionRow(actor, workspaceId, String(resourceId)).id) } as unknown as JsonValue;
    if (queryType === "missionMessages.list") return { items: listMessages(db, this.missionRow(actor, workspaceId, String(resourceId)).id, limit) } as unknown as JsonValue;
    if (queryType === "handoffs.forWorkItem") return { items: dependencyHandoffs(db, this.workItemRow(actor, workspaceId, String(resourceId)).id) } as unknown as JsonValue;
    if (queryType === "missionBundles.latest") return (latestMissionBundle(db, this.missionRow(actor, workspaceId, String(resourceId)).id) ?? null) as unknown as JsonValue;
    if (queryType === "missions.forSubject") {
      const rows = db.prepare("SELECT m.* FROM mission_subjects s JOIN missions m ON m.id=s.mission_id WHERE s.subject_id=? ORDER BY m.created_at_ms DESC LIMIT ?").all(String(resourceId), limit) as MissionRow[];
      return { items: rows.map((row) => this.mission(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "missions.brief") return this.brief(actor, workspaceId, this.missionRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "missions.get") return this.mission(workspaceId, this.missionRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "plans.get") return this.plan(workspaceId, this.planRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "workItems.list") {
      const rows = db.prepare("SELECT * FROM work_items WHERE state!='abandoned' ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as WorkItemRow[];
      return { items: rows.map((row) => this.workItem(actor, workspaceId, row)) } as unknown as JsonValue;
    }
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
