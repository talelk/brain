import { domainDigest } from "@brain/contracts";
import type { ActorContext, ExecutionLink, JsonValue, Objective, PlanAssignment, PlanTask, PlanVersion, WorkBoardView, WorkItem, WorkItemState } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { assertExpectedVersion, assertTransition } from "../../domain/states";
import { assertPlanTasks } from "../../domain/work-plan";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

export interface WorkCommand {
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly expectedVersion?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

type ObjectiveRow = {
  id: string; title: string; intent: string; success_criteria_json: string; owner_id: string;
  active_plan_version_id: string | null; version: number; created_at_ms: number; updated_at_ms: number;
};
type PlanRow = {
  id: string; objective_id: string; revision: number; digest: string; state: PlanVersion["state"];
  origin: PlanVersion["origin"]; created_by: string; summary: string | null; tasks_json: string;
  created_at_ms: number; confirmed_at_ms: number | null;
};
type WorkItemRow = {
  id: string; objective_id: string; plan_version_id: string; plan_task_id: string; title: string;
  state: WorkItemState; criteria_json: string; assignment_json: string | null; workflow_id: string | null;
  next_action: string; blocked_reason: string | null; scheduled_at_ms: number | null; evidence_digest: string | null;
  version: number; created_at_ms: number; updated_at_ms: number;
};

export class WorkService {
  constructor(private readonly store: Store) {}

  private db(actor: ActorContext, workspaceId: string) {
    requireWorkspaceRead(this.store, actor, workspaceId);
    return this.store.workspaceDb(workspaceId, actor.organizationId);
  }

  private objectiveRow(actor: ActorContext, workspaceId: string, id: string): ObjectiveRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM objectives WHERE id=?").get(id) as ObjectiveRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "objective not found");
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

  private objective(workspaceId: string, row: ObjectiveRow): Objective {
    return {
      objectiveId: row.id, workspaceId, title: row.title, intent: row.intent,
      successCriteria: JSON.parse(row.success_criteria_json) as string[], ownerId: row.owner_id,
      ...(row.active_plan_version_id ? { activePlanVersionId: row.active_plan_version_id } : {}),
      version: row.version, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  private plan(workspaceId: string, row: PlanRow): PlanVersion {
    return {
      planVersionId: row.id, objectiveId: row.objective_id, workspaceId, revision: row.revision,
      digest: row.digest, state: row.state, origin: row.origin, createdBy: row.created_by,
      ...(row.summary ? { summary: row.summary } : {}), tasks: JSON.parse(row.tasks_json) as PlanTask[],
      createdAt: iso(row.created_at_ms), ...(row.confirmed_at_ms ? { confirmedAt: iso(row.confirmed_at_ms) } : {}),
    };
  }

  private workItem(actor: ActorContext, workspaceId: string, row: WorkItemRow): WorkItem {
    const dependsOn = (this.db(actor, workspaceId).prepare("SELECT depends_on_work_item_id AS id FROM work_item_dependencies WHERE work_item_id=? ORDER BY depends_on_work_item_id").all(row.id) as Array<{ id: string }>).map((entry) => entry.id);
    return {
      workItemId: row.id, objectiveId: row.objective_id, planVersionId: row.plan_version_id,
      planTaskId: row.plan_task_id, workspaceId, title: row.title, state: row.state,
      criteria: JSON.parse(row.criteria_json) as string[], dependsOn,
      ...(row.assignment_json ? { assignment: JSON.parse(row.assignment_json) as PlanAssignment } : {}),
      ...(row.workflow_id ? { workflowId: row.workflow_id } : {}), nextAction: row.next_action,
      ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
      ...(row.scheduled_at_ms ? { scheduledAt: iso(row.scheduled_at_ms) } : {}),
      ...(row.evidence_digest ? { evidenceDigest: row.evidence_digest } : {}),
      version: row.version, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  apply(actor: ActorContext, command: WorkCommand): string {
    const workspaceId = command.workspaceId;
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    switch (command.commandType) {
      case "objective.create": return this.createObjective(actor, workspaceId, command.payload);
      case "plan.propose": return this.proposePlan(actor, workspaceId, command.payload);
      case "plan.confirm": return this.confirmPlan(actor, workspaceId, command.payload, command.expectedVersion);
      case "workItem.transition": return this.transition(actor, workspaceId, command.payload, command.expectedVersion);
      case "workItem.comment": return this.comment(actor, workspaceId, command.payload);
      default: throw new BrainDomainError("INVALID_CONTRACT", `unsupported work command ${command.commandType}`);
    }
  }

  private createObjective(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const db = this.db(actor, workspaceId);
    const id = this.store.id("obj");
    this.store.inTx(db, () => {
      db.prepare("INSERT INTO objectives(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?)")
        .run(id, String(payload["title"]), String(payload["intent"]), JSON.stringify(payload["successCriteria"]), actor.actorId, this.store.now(), this.store.now());
      this.store.emit(db, { aggregateType: "objective", aggregateId: id, eventType: "objective.created", payload: { objectiveId: id } });
    });
    return id;
  }

  private proposePlan(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const objective = this.objectiveRow(actor, workspaceId, String(payload["objectiveId"]));
    const tasks = payload["tasks"] as unknown as PlanTask[];
    assertPlanTasks(tasks);
    const db = this.db(actor, workspaceId);
    const id = this.store.id("plan");
    const origin = String(payload["origin"]) as PlanVersion["origin"];
    const summary = payload["summary"] ? String(payload["summary"]) : undefined;
    const digest = domainDigest("brain:plan-version:v1", { objectiveId: objective.id, origin, summary: summary ?? null, tasks } as unknown as JsonValue);
    this.store.inTx(db, () => {
      const revision = (db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM plan_versions WHERE objective_id=?").get(objective.id) as { next: number }).next;
      db.prepare("INSERT INTO plan_versions(id,objective_id,revision,digest,state,origin,created_by,summary,tasks_json,created_at_ms) VALUES (?,?,?,?,'proposed',?,?,?,?,?)")
        .run(id, objective.id, revision, digest, origin, actor.actorId, summary ?? null, JSON.stringify(tasks), this.store.now());
      this.store.emit(db, { aggregateType: "plan", aggregateId: id, eventType: "plan.proposed", payload: { objectiveId: objective.id, planVersionId: id, digest } });
    });
    return id;
  }

  private confirmPlan(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const plan = this.planRow(actor, workspaceId, String(payload["planVersionId"]));
    const objective = this.objectiveRow(actor, workspaceId, plan.objective_id);
    assertExpectedVersion(objective.version, expectedVersion);
    if (plan.state !== "proposed") throw new BrainDomainError("CONFLICT", "only a proposed plan version can be confirmed");
    const tasks = JSON.parse(plan.tasks_json) as PlanTask[];
    assertPlanTasks(tasks);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      const priorActive = objective.active_plan_version_id;
      if (priorActive) {
        assertTransition("planVersion", "confirmed", "superseded");
        db.prepare("UPDATE plan_versions SET state='superseded' WHERE id=? AND state='confirmed'").run(priorActive);
      }
      assertTransition("planVersion", plan.state, "confirmed");
      const previous = db.prepare("SELECT * FROM work_items WHERE objective_id=? AND state!='abandoned' ORDER BY created_at_ms DESC,id DESC").all(objective.id) as WorkItemRow[];
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
        db.prepare(`INSERT INTO work_items(id,objective_id,plan_version_id,plan_task_id,title,state,criteria_json,assignment_json,workflow_id,next_action,created_at_ms,updated_at_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, objective.id, plan.id, task.id, task.title, state, JSON.stringify(task.criteria),
          task.assignment ? JSON.stringify(task.assignment) : null, task.workflowId ?? null,
          state === "ready" ? "Start this task" : "Wait for predecessor completion", now, now);
      }
      for (const item of previous) {
        if (retained.has(item.id) || item.state === "done") continue;
        db.prepare("UPDATE work_items SET state='abandoned',next_action=?,version=version+1,updated_at_ms=? WHERE id=?")
          .run(`Superseded by plan revision ${plan.revision}`, now, item.id);
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
      db.prepare("UPDATE plan_versions SET state='confirmed',confirmed_at_ms=? WHERE id=?").run(now, plan.id);
      db.prepare("UPDATE objectives SET active_plan_version_id=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(plan.id, now, objective.id, objective.version);
      this.store.emit(db, { aggregateType: "plan", aggregateId: plan.id, eventType: "plan.confirmed", payload: { objectiveId: objective.id, planVersionId: plan.id, digest: plan.digest } });
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
    const db = this.db(actor, workspaceId);
    const reason = payload["reason"] ? String(payload["reason"]) : undefined;
    if (next === "blocked" && !reason) throw new BrainDomainError("INVALID_ARGUMENT", "a blocked work item needs a reason");
    this.store.inTx(db, () => {
      if (next === "ready") this.assertDependenciesDone(db, item.id);
      const evidenceDigest = payload["evidenceDigest"] ? String(payload["evidenceDigest"]) : item.evidence_digest;
      if (next === "done") this.assertEvidence(db, item, evidenceDigest);
      const nextAction = next === "done" ? "No further action" : next === "review" ? "Review verified results" : next === "blocked" ? reason ?? "Resolve blocker" : next === "ready" ? "Start this task" : next === "in-progress" ? "Complete and submit evidence" : next === "abandoned" ? "Superseded or abandoned" : "Wait for predecessor completion";
      db.prepare("UPDATE work_items SET state=?,blocked_reason=?,evidence_digest=?,next_action=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(next, next === "blocked" ? reason : null, evidenceDigest ?? null, nextAction, this.store.now(), item.id, item.version);
      this.store.emit(db, { aggregateType: "workItem", aggregateId: item.id, eventType: "workItem.transitioned", payload: { workItemId: item.id, state: next, ...(evidenceDigest ? { evidenceDigest } : {}) } });
      if (next === "done") this.releaseReadyItems(db, item.objective_id);
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

  private releaseReadyItems(db: ReturnType<Store["workspaceDb"]>, objectiveId: string): void {
    const candidates = db.prepare("SELECT id FROM work_items WHERE objective_id=? AND state IN ('backlog','blocked')").all(objectiveId) as Array<{ id: string }>;
    for (const candidate of candidates) {
      const pending = db.prepare("SELECT 1 FROM work_item_dependencies d JOIN work_items w ON w.id=d.depends_on_work_item_id WHERE d.work_item_id=? AND w.state!='done' LIMIT 1").get(candidate.id);
      if (!pending) db.prepare("UPDATE work_items SET state='ready',blocked_reason=NULL,next_action='Start this task',version=version+1,updated_at_ms=? WHERE id=?").run(this.store.now(), candidate.id);
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

  linkExecution(actor: ActorContext, workspaceId: string, workItemId: string, runId: string): void {
    const item = this.workItemRow(actor, workspaceId, workItemId);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("INSERT OR IGNORE INTO execution_links(work_item_id,run_id,created_at_ms) VALUES (?,?,?)").run(item.id, runId, this.store.now());
      if (item.state === "ready") {
        this.assertDependenciesDone(db, item.id);
        db.prepare("UPDATE work_items SET state='in-progress',next_action='Complete and submit evidence',version=version+1,updated_at_ms=? WHERE id=?").run(this.store.now(), item.id);
      }
    });
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, resourceId?: string, limit = 100): JsonValue {
    const db = this.db(actor, workspaceId);
    if (queryType === "objectives.list") {
      const rows = db.prepare("SELECT * FROM objectives ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as ObjectiveRow[];
      return { items: rows.map((row) => this.objective(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "objectives.get") return this.objective(workspaceId, this.objectiveRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "plans.get") return this.plan(workspaceId, this.planRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "workItems.list") {
      const rows = db.prepare("SELECT * FROM work_items WHERE state!='abandoned' ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as WorkItemRow[];
      return { items: rows.map((row) => this.workItem(actor, workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "workItems.get") return this.workItem(actor, workspaceId, this.workItemRow(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "workBoard.get") {
      const objectives = (db.prepare("SELECT * FROM objectives ORDER BY updated_at_ms DESC,id LIMIT 100").all() as ObjectiveRow[]).map((row) => this.objective(workspaceId, row));
      const items = (db.prepare("SELECT * FROM work_items WHERE state!='abandoned' ORDER BY created_at_ms,id LIMIT 1000").all() as WorkItemRow[]).map((row) => this.workItem(actor, workspaceId, row));
      const executions = (db.prepare("SELECT * FROM execution_links ORDER BY created_at_ms DESC,run_id LIMIT 1000").all() as Array<{ work_item_id: string; run_id: string; job_id: string | null; attempt_id: string | null; session_id: string | null; created_at_ms: number }>).map((row): ExecutionLink => ({
        workItemId: row.work_item_id, runId: row.run_id,
        ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
        ...(row.session_id ? { sessionId: row.session_id } : {}), createdAt: iso(row.created_at_ms),
      }));
      return { workspaceId, objectives, items, executions } satisfies WorkBoardView as unknown as JsonValue;
    }
    throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `unsupported work query ${queryType}`);
  }
}
