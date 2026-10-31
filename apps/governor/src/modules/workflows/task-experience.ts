import type { ActorContext, CommandReceipt, ConversationView, JsonValue, ObjectivePlanRequest, ObjectivePlanView, PlanTask, PlanVersion, TaskContext, TaskDraft, TaskOrigin, TaskPrepareRequest, WorkflowCatalogEntry } from "@brain/contracts";
import { payloadValidator } from "@brain/contracts/validate";
import type { Store } from "../../application/store";
import { authorizeCommand, requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";

interface Host { query(actor: ActorContext, query: unknown): JsonValue; dispatch(actor: ActorContext, command: unknown): { receipt: CommandReceipt } }
interface DraftRow { id: string; actor_id: string; workflow_id: string; workflow_json: string; config_digest: string; input_json: string; origin_json: string | null; title: string; command_id: string; conversation_id?: string | null; state: "review" | "started"; run_id: string | null; created_at_ms: number }
interface MessageRow { id: string; role: "user" | "assistant"; text: string; state: "pending" | "done" | "failed"; run_id: string | null; draft_id: string | null }
interface PlanningRow { objective_id: string; actor_id: string; run_id: string; state: "running" | "ready" | "failed"; plan_version_id: string | null; error: string | null }
export class TaskExperience {
  constructor(private readonly s: Store, private readonly host: Host) {}
  private db(actor: ActorContext, workspaceId: string) { requireWorkspaceRead(this.s, actor, workspaceId); return this.s.workspaceDb(workspaceId, actor.organizationId); }
  private catalog(actor: ActorContext, workspaceId: string): WorkflowCatalogEntry[] {
    return (this.host.query(actor, { queryType: "workflows.list", workspaceId }) as unknown as { snapshot: { items: WorkflowCatalogEntry[] } }).snapshot.items;
  }
  private draft(actor: ActorContext, workspaceId: string, id: string): DraftRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM task_drafts WHERE id=? AND actor_id=?").get(id, actor.actorId) as DraftRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "Task draft not found"); return row;
  }
  private view(workspaceId: string, row: DraftRow): TaskDraft {
    return { id: row.id, workspaceId, title: row.title, workflow: JSON.parse(row.workflow_json), configDigest: row.config_digest, input: JSON.parse(row.input_json), ...(row.origin_json ? { origin: JSON.parse(row.origin_json) } : {}), state: row.state, ...(row.run_id ? { runId: row.run_id } : {}), createdAt: new Date(row.created_at_ms).toISOString() };
  }
  getDraft(actor: ActorContext, workspaceId: string, id: string): TaskDraft { return this.view(workspaceId, this.draft(actor, workspaceId, id)); }
  context(actor: ActorContext, workspaceId: string, origin: TaskOrigin): TaskContext {
    const db = this.db(actor, workspaceId);
    const table = { "work-item": "work_items", ticket: "tickets", incident: "incidents" }[origin.kind];
    if (!table) throw new BrainDomainError("INVALID_ARGUMENT", "Choose a card, ticket or incident");
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(origin.id) as { title: string; criteria_json?: string } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "Work item not found in this workspace");
    const criteria = row.criteria_json ? JSON.parse(row.criteria_json) as unknown[] : [];
    let input: JsonValue = { situation: row.title + (criteria.length ? `\nAcceptance criteria: ${criteria.map(String).join("; ")}` : "") };
    let workflowId = "operations-triage";
    if (origin.kind === "ticket") {
      const ticket = this.host.query(actor, { queryType: "ticket.get", workspaceId, resourceId: origin.id }) as unknown as { snapshot: { body?: string } };
      input = { title: row.title, body: ticket.snapshot.body ?? "" }; workflowId = "support-draft";
    }
    const drafts = db.prepare("SELECT title,run_id FROM task_drafts WHERE json_extract(origin_json,'$.kind')=? AND json_extract(origin_json,'$.id')=? AND run_id IS NOT NULL ORDER BY created_at_ms DESC LIMIT 100").all(origin.kind, origin.id) as { title: string; run_id: string }[];
    const runs = drafts.map((draft) => ({ title: draft.title, runId: draft.run_id, state: (db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(draft.run_id) as { state: string } | undefined)?.state ?? "unknown" }));
    return { origin, title: row.title, workflowId, input, runs };
  }
  prepare(actor: ActorContext, request: TaskPrepareRequest): TaskDraft {
    authorizeCommand(actor, "workflow.dispatch");
    const db = this.db(actor, request.workspaceId);
    if (request.origin) this.context(actor, request.workspaceId, request.origin);
    const entry = this.catalog(actor, request.workspaceId).find((item) => item.release.id === request.workflowId);
    if (!entry) throw new BrainDomainError("NOT_FOUND", "This task is not available in the active release");
    const valid = payloadValidator(entry.inputSchema as object)(request.input);
    if (!valid.ok) throw new BrainDomainError("INVALID_ARGUMENT", valid.errors.join("; "));
    const id = this.s.id("draft");
    db.prepare("INSERT INTO task_drafts(id,actor_id,workflow_id,workflow_json,config_digest,input_json,origin_json,title,command_id,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,'review',?)").run(id, actor.actorId, entry.release.id, JSON.stringify(entry.release), entry.configDigest, JSON.stringify(request.input), request.origin ? JSON.stringify(request.origin) : null, entry.definition.spec.presentation?.title ?? entry.release.id.replaceAll("-", " "), this.s.id("start"), this.s.now());
    return this.getDraft(actor, request.workspaceId, id);
  }
  start(actor: ActorContext, workspaceId: string, id: string): TaskDraft {
    authorizeCommand(actor, "workflow.dispatch");
    const db = this.db(actor, workspaceId); const row = this.draft(actor, workspaceId, id);
    if (row.run_id) return this.view(workspaceId, row);
    // Recover acceptance before inspecting the current release: a lost response
    // must still recover the original run after an intervening activation.
    let receipt: CommandReceipt | undefined;
    try { receipt = (this.host.query(actor, { queryType: "command.get", commandId: row.command_id }) as unknown as { snapshot: { receipt: CommandReceipt } }).snapshot.receipt; }
    catch (error) { if (!(error instanceof BrainDomainError) || error.code !== "NOT_FOUND") throw error; }
    if (!receipt) {
      const current = this.catalog(actor, workspaceId).find((item) => item.release.id === row.workflow_id);
      if (!current || current.configDigest !== row.config_digest || current.release.digest !== JSON.parse(row.workflow_json).digest) throw new BrainDomainError("CONFLICT", "The task changed since this review. Return to the form and review the current version; your inputs are retained.");
      if (row.origin_json) this.context(actor, workspaceId, JSON.parse(row.origin_json) as TaskOrigin);
      const origin = row.origin_json ? JSON.parse(row.origin_json) as TaskOrigin : undefined;
      receipt = this.host.dispatch(actor, { contractVersion: "brain.command/v1", commandId: row.command_id, commandType: "workflow.dispatch", workspaceId, idempotencyKey: row.command_id, payload: { workflow: JSON.parse(row.workflow_json), input: JSON.parse(row.input_json), ...(origin?.kind === "work-item" ? { workItemId: origin.id } : {}) } }).receipt;
    }
    if (!receipt.accepted || !receipt.resourceId) throw new BrainDomainError("CONFLICT", "Task start was not accepted");
    db.prepare("UPDATE task_drafts SET state='started',run_id=? WHERE id=? AND actor_id=?").run(receipt.resourceId, id, actor.actorId);
    return this.getDraft(actor, workspaceId, id);
  }
  startObjectivePlan(actor: ActorContext, request: ObjectivePlanRequest): ObjectivePlanView {
    authorizeCommand(actor, "workflow.dispatch");
    const db = this.db(actor, request.workspaceId);
    let objectiveId = request.objectiveId;
    let title = request.title;
    let intent = request.intent;
    let successCriteria = request.successCriteria;
    if (objectiveId) {
      const current = this.host.query(actor, { queryType: "objectives.get", workspaceId: request.workspaceId, resourceId: objectiveId }) as unknown as { snapshot: { title: string; intent: string; successCriteria: string[] } };
      title = current.snapshot.title; intent = current.snapshot.intent; successCriteria = current.snapshot.successCriteria;
    } else {
      if (!title || !intent || !successCriteria) throw new BrainDomainError("INVALID_ARGUMENT", "title, intent and successCriteria are required for a new objective");
      const created = this.host.dispatch(actor, { contractVersion: "brain.command/v1", commandId: `objective-${request.requestId}`, commandType: "objective.create", workspaceId: request.workspaceId, idempotencyKey: `objective-${request.requestId}`, payload: { title, intent, successCriteria } }).receipt;
      objectiveId = created.resourceId;
    }
    if (!objectiveId || !title || !intent || !successCriteria) throw new BrainDomainError("CONFLICT", "objective could not be prepared");
    const guide = this.catalog(actor, request.workspaceId).find((entry) => entry.release.id === "plan-guide");
    if (!guide) throw new BrainDomainError("UNSUPPORTED_CAPABILITY", "this release has no governed plan assistant");
    const capabilities = JSON.stringify(this.catalog(actor, request.workspaceId).filter((entry) => !entry.definition.spec.presentation?.system).slice(0, 20).map((entry) => ({ id: entry.release.id, title: entry.definition.spec.presentation?.title, description: entry.definition.spec.presentation?.description })));
    const commandId = `plan-run-${request.requestId}`;
    const started = this.host.dispatch(actor, { contractVersion: "brain.command/v1", commandId, commandType: "workflow.dispatch", workspaceId: request.workspaceId, idempotencyKey: commandId, payload: { workflow: guide.release, input: { title, intent, successCriteria, capabilities } } }).receipt;
    if (!started.accepted || !started.resourceId) throw new BrainDomainError("CONFLICT", "plan assistant could not be started");
    db.prepare("INSERT INTO planning_requests(objective_id,actor_id,run_id,state,created_at_ms,updated_at_ms) VALUES (?,?,?,'running',?,?) ON CONFLICT(objective_id) DO UPDATE SET run_id=excluded.run_id,state='running',plan_version_id=NULL,error=NULL,updated_at_ms=excluded.updated_at_ms")
      .run(objectiveId, actor.actorId, started.resourceId, this.s.now(), this.s.now());
    return { objectiveId, runId: started.resourceId, state: "running" };
  }

  objectivePlan(actor: ActorContext, workspaceId: string, objectiveId: string): ObjectivePlanView {
    const db = this.db(actor, workspaceId);
    const row = db.prepare("SELECT * FROM planning_requests WHERE objective_id=? AND actor_id=?").get(objectiveId, actor.actorId) as PlanningRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "planning request not found");
    if (row.state === "ready" && row.plan_version_id) {
      const plan = this.host.query(actor, { queryType: "plans.get", workspaceId, resourceId: row.plan_version_id }) as unknown as { snapshot: PlanVersion };
      return { objectiveId, runId: row.run_id, state: "ready", planVersionId: row.plan_version_id, plan: plan.snapshot };
    }
    if (row.state === "failed") return { objectiveId, runId: row.run_id, state: "failed", ...(row.error ? { error: row.error } : {}) };
    const run = this.host.query(actor, { queryType: "job.get", workspaceId, resourceId: row.run_id }) as unknown as { snapshot: { workflowState?: string; runOutputs?: Record<string, JsonValue> } };
    if (run.snapshot.workflowState === "succeeded") {
      const output = run.snapshot.runOutputs?.["propose"] as { summary?: string; tasks?: PlanTask[] } | undefined;
      try {
        if (!output?.tasks) throw new BrainDomainError("INVALID_CONTRACT", "plan assistant returned no task list");
        const commandId = `plan-proposal-${row.run_id}`;
        const proposed = this.host.dispatch(actor, { contractVersion: "brain.command/v1", commandId, commandType: "plan.propose", workspaceId, idempotencyKey: commandId, payload: { objectiveId, origin: "agent", summary: output.summary ?? "", tasks: output.tasks } }).receipt;
        if (!proposed.accepted || !proposed.resourceId) throw new BrainDomainError("CONFLICT", "plan proposal was not accepted");
        db.prepare("UPDATE planning_requests SET state='ready',plan_version_id=?,updated_at_ms=? WHERE objective_id=?").run(proposed.resourceId, this.s.now(), objectiveId);
        return this.objectivePlan(actor, workspaceId, objectiveId);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 1024) : "plan proposal failed validation";
        db.prepare("UPDATE planning_requests SET state='failed',error=?,updated_at_ms=? WHERE objective_id=?").run(message, this.s.now(), objectiveId);
        return { objectiveId, runId: row.run_id, state: "failed", error: message };
      }
    }
    if (["failed", "cancelled", "partial", "blocked"].includes(run.snapshot.workflowState ?? "")) {
      const error = "The plan assistant did not produce an independently validated proposal. Review the run or choose another strategy.";
      db.prepare("UPDATE planning_requests SET state='failed',error=?,updated_at_ms=? WHERE objective_id=?").run(error, this.s.now(), objectiveId);
      return { objectiveId, runId: row.run_id, state: "failed", error };
    }
    return { objectiveId, runId: row.run_id, state: "running" };
  }

  conversations(actor: ActorContext, workspaceId: string): { id: string; preview: string; updatedAt: string }[] {
    return (this.db(actor, workspaceId).prepare("SELECT c.id,COALESCE((SELECT substr(text,1,160) FROM conversation_messages WHERE conversation_id=c.id AND role='user' ORDER BY created_at_ms LIMIT 1),'New conversation') AS preview,COALESCE((SELECT MAX(created_at_ms) FROM conversation_messages WHERE conversation_id=c.id),c.created_at_ms) AS updated FROM conversations c WHERE c.actor_id=? ORDER BY updated DESC,c.id DESC LIMIT 20").all(actor.actorId) as { id: string; preview: string; updated: number }[]).map((row) => ({ id: row.id, preview: row.preview, updatedAt: new Date(row.updated).toISOString() }));
  }
  createConversation(actor: ActorContext, workspaceId: string, id: string): ConversationView {
    authorizeCommand(actor, "workflow.dispatch");
    const db = this.db(actor, workspaceId);
    db.prepare("INSERT OR IGNORE INTO conversations(id,actor_id,created_at_ms) VALUES (?,?,?)").run(id, actor.actorId, this.s.now());
    return this.conversation(actor, workspaceId, id);
  }
  conversation(actor: ActorContext, workspaceId: string, id: string): ConversationView {
    const db = this.db(actor, workspaceId);
    if (!db.prepare("SELECT 1 FROM conversations WHERE id=? AND actor_id=?").get(id, actor.actorId)) throw new BrainDomainError("NOT_FOUND", "Conversation not found");
    const rows = db.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY created_at_ms,id LIMIT 100").all(id) as MessageRow[];
    for (const row of rows.filter((message) => message.role === "assistant" && message.state === "pending" && message.run_id)) {
      const run = this.host.query(actor, { queryType: "job.get", workspaceId, resourceId: row.run_id }) as unknown as { snapshot: { workflowState?: string; runOutputs?: Record<string, JsonValue> } };
      if (run.snapshot.workflowState === "succeeded") {
        const output = run.snapshot.runOutputs?.["respond"] as { reply?: unknown; workflowId?: unknown; input?: JsonValue; questions?: unknown } | undefined;
        let text = typeof output?.reply === "string" ? output.reply.slice(0, 2000) : "Choose a task from the catalog to continue.";
        if (Array.isArray(output?.questions)) text += "\n" + output.questions.filter((value): value is string => typeof value === "string").slice(0, 3).join("\n");
        let draftId: string | undefined;
        if (typeof output?.workflowId === "string" && output.input && this.catalog(actor, workspaceId).some((entry) => entry.release.id === output.workflowId && !entry.definition.spec.presentation?.system)) {
          try { draftId = this.prepare(actor, { workspaceId, workflowId: output.workflowId, input: output.input }).id; }
          catch (error) { if (!(error instanceof BrainDomainError) || !["INVALID_ARGUMENT", "NOT_FOUND", "FORBIDDEN"].includes(error.code)) throw error; text += "\nMore input is needed before a task can be prepared. You can also choose the task and complete its form."; }
        }
        db.prepare("UPDATE conversation_messages SET state='done',text=?,draft_id=? WHERE id=? AND state='pending'").run(text, draftId ?? null, row.id);
      } else if (["failed", "cancelled", "partial", "blocked"].includes(run.snapshot.workflowState ?? "")) {
        db.prepare("UPDATE conversation_messages SET state='failed',text=? WHERE id=?").run("Brain could not prepare a verified proposal. You can choose a task directly, or send a new message after checking the model connection.", row.id);
      }
    }
    const updated = db.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY created_at_ms,id LIMIT 100").all(id) as MessageRow[];
    return { id, workspaceId, messages: updated.map((row) => ({ id: row.id, role: row.role, text: row.text, state: row.state, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.draft_id ? { draftId: row.draft_id } : {}) })) };
  }
  message(actor: ActorContext, workspaceId: string, threadId: string, id: string, text: string): ConversationView {
    authorizeCommand(actor, "workflow.dispatch");
    if (!text.trim() || text.length > 4000) throw new BrainDomainError("INVALID_ARGUMENT", "Enter a message of at most 4000 characters");
    const current = this.conversation(actor, workspaceId, threadId); const db = this.db(actor, workspaceId);
    const existing = db.prepare("SELECT text FROM conversation_messages WHERE id=? AND conversation_id=? AND role='user'").get(id, threadId) as { text: string } | undefined;
    if (existing && existing.text !== text) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "This message was already sent with different text");
    if (!existing && (current.messages.length >= 98 || current.messages.some((m) => m.state === "pending"))) throw new BrainDomainError("CONFLICT", "Wait for the current proposal, or start a new conversation");
    const recovered = db.prepare("SELECT * FROM task_drafts WHERE id=? AND actor_id=?").get(`chat-intent-${id}`, actor.actorId) as DraftRow | undefined;
    if (recovered) {
      if (recovered.conversation_id !== threadId) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "This message ID belongs to another conversation");
      if (JSON.parse(recovered.input_json).message !== text) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "This message was already sent with different text");
      const started = this.start(actor, workspaceId, recovered.id);
      this.s.inTx(db, () => {
        db.prepare("INSERT OR IGNORE INTO conversation_messages(id,conversation_id,role,text,state,created_at_ms) VALUES (?,?,'user',?,'done',?)").run(id, threadId, text, recovered.created_at_ms);
        db.prepare("INSERT OR IGNORE INTO conversation_messages(id,conversation_id,role,text,state,run_id,created_at_ms) VALUES (?,?,'assistant',?,'pending',?,?)").run(`${id}-reply`, threadId, "Preparing a task proposal…", started.runId, recovered.created_at_ms + 1);
      });
      return this.conversation(actor, workspaceId, threadId);
    }
    const guide = this.catalog(actor, workspaceId).find((entry) => entry.release.id === "task-guide");
    if (!guide) throw new BrainDomainError("UNSUPPORTED_CAPABILITY", "This release has no conversational assistant. Choose a task directly.");
    const assistantId = `${id}-reply`;
    const candidates = this.catalog(actor, workspaceId).filter((entry) => !entry.definition.spec.presentation?.system && !["agent-smoke", "task-guide"].includes(entry.release.id)).slice(0, 8).map((entry) => ({ id: entry.release.id, title: entry.definition.spec.presentation?.title ?? entry.release.id, description: entry.definition.spec.presentation?.description ?? "", inputSchema: entry.inputSchema }));
    const tasks: typeof candidates = [];
    for (const candidate of candidates) { if (JSON.stringify([...tasks, candidate]).length <= 16000) tasks.push(candidate); }
    const recent = current.messages.filter((message) => message.state !== "pending" && message.id !== id).slice(-10).map((message) => ({ role: message.role, text: message.text }));
    while (JSON.stringify(recent).length > 16000) recent.shift();
    const command = db.prepare("SELECT run_id FROM conversation_messages WHERE id=? AND conversation_id=?").get(assistantId, threadId) as { run_id: string | null } | undefined;
    if (command?.run_id) return this.conversation(actor, workspaceId, threadId);
    const request = { contractVersion: "brain.command/v1", commandId: `guide-${id}`, idempotencyKey: `guide-${id}`, commandType: "workflow.dispatch", workspaceId, payload: { workflow: guide.release, input: { message: text, history: JSON.stringify(recent), tasks: JSON.stringify(tasks) } } };
    // Persist exact command bytes so a transport retry cannot change its history/catalog.
    const intentId = `chat-intent-${id}`;
    const pending = db.prepare("SELECT input_json FROM task_drafts WHERE id=? AND actor_id=?").get(intentId, actor.actorId) as { input_json: string } | undefined;
    if (!pending) db.prepare("INSERT INTO task_drafts(id,actor_id,workflow_id,workflow_json,config_digest,input_json,title,command_id,conversation_id,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?, 'review',?)").run(intentId, actor.actorId, guide.release.id, JSON.stringify(guide.release), guide.configDigest, JSON.stringify(request.payload.input), "Ask Brain", request.commandId, threadId, Math.max(this.s.now(), Number((db.prepare("SELECT MAX(created_at_ms) AS latest FROM conversation_messages WHERE conversation_id=?").get(threadId) as { latest: number | null }).latest ?? 0) + 1));
    const intent = this.draft(actor, workspaceId, intentId);
    const started = this.start(actor, workspaceId, intentId);
    this.s.inTx(db, () => {
      db.prepare("INSERT OR IGNORE INTO conversation_messages(id,conversation_id,role,text,state,created_at_ms) VALUES (?,?,'user',?,'done',?)").run(id, threadId, text, intent.created_at_ms);
      db.prepare("INSERT OR IGNORE INTO conversation_messages(id,conversation_id,role,text,state,run_id,created_at_ms) VALUES (?,?,'assistant',?,'pending',?,?)").run(assistantId, threadId, "Preparing a task proposal…", started.runId, intent.created_at_ms + 1);
    });
    return this.conversation(actor, workspaceId, threadId);
  }
}
