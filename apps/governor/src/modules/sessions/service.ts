import { domainDigest } from "@brain/contracts";
import type { ActorContext, BrainSession, Delegation, JsonValue, PortableCheckpoint, SessionBudget, SessionScope, WorkItemMessage } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { assertExpectedVersion } from "../../domain/states";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

export interface SessionCommand {
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly expectedVersion?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

type SessionRow = {
  id: string; job_id: string | null; attempt_id: string | null; mode: BrainSession["mode"];
  work_item_id: string | null; parent_session_id: string | null; root_session_id: string | null;
  agent_id: string; task: string; engine_id: string; adapter_digest: string; state: BrainSession["state"];
  checkpoint_digest: string | null; checkpoint_json: string | null; event_sequence: number;
  delegation_depth: number; budget_json: string; scope_json: string; worktree_id: string;
  created_by: string; version: number; created_at_ms: number; updated_at_ms: number;
};

type DelegationRow = {
  id: string; parent_session_id: string; child_session_id: string; work_item_id: string;
  state: Delegation["state"]; reviewer_id: string | null; evidence_digest: string | null;
  created_at_ms: number; reviewed_at_ms: number | null;
};

type MessageRow = {
  id: string; work_item_id: string; session_id: string | null; sender_id: string;
  sender_kind: WorkItemMessage["senderKind"]; body: string; correction_of: string | null; created_at_ms: number;
};

const ACTIVE_SESSION_STATES = new Set(["starting", "running", "waiting", "stopping"]);
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

function budgetOf(payload: Readonly<Record<string, unknown>>): SessionBudget {
  return payload["budget"] as unknown as SessionBudget;
}

function scopeOf(payload: Readonly<Record<string, unknown>>): SessionScope {
  return payload["scope"] as unknown as SessionScope;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSubset(child: readonly string[], parent: readonly string[], label: string): void {
  const allowed = new Set(parent);
  const escaped = child.filter((entry) => !allowed.has(entry));
  if (escaped.length > 0) throw new BrainDomainError("FORBIDDEN", `${label} exceed the parent delegation: ${escaped.join(", ")}`);
}

function assertBudgetWithin(child: SessionBudget, available: SessionBudget): void {
  if (child.maxTokens > available.maxTokens || child.maxMicroUsd > available.maxMicroUsd || child.maxTurns > available.maxTurns) {
    throw new BrainDomainError("BUDGET_EXHAUSTED", "child budget exceeds the parent's unreserved budget");
  }
}

export class SessionService {
  constructor(private readonly store: Store) {}

  private db(actor: ActorContext, workspaceId: string) {
    requireWorkspaceRead(this.store, actor, workspaceId);
    return this.store.workspaceDb(workspaceId, actor.organizationId);
  }

  private row(actor: ActorContext, workspaceId: string, id: string): SessionRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "session not found");
    return row;
  }

  private delegationRow(actor: ActorContext, workspaceId: string, id: string): DelegationRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM delegations WHERE id=?").get(id) as DelegationRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "delegation not found");
    return row;
  }

  private checkpoint(row: SessionRow): PortableCheckpoint | undefined {
    if (!row.checkpoint_json) return undefined;
    return { ...(JSON.parse(row.checkpoint_json) as Omit<PortableCheckpoint, "digest">), digest: row.checkpoint_digest ?? ZERO_DIGEST };
  }

  private view(workspaceId: string, row: SessionRow): BrainSession {
    const budget = row.job_id ? this.store.control.prepare("SELECT micro_usd,settled_micro_usd FROM budget_reservations WHERE job_id=?").get(row.job_id) as { micro_usd: number; settled_micro_usd: number } | undefined : undefined;
    const checkpoint = this.checkpoint(row);
    return {
      sessionId: row.id, workspaceId, mode: row.mode,
      ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      ...(row.work_item_id ? { workItemId: row.work_item_id } : {}),
      ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
      rootSessionId: row.root_session_id ?? row.id, agentId: row.agent_id, task: row.task,
      engine: { id: row.engine_id, version: row.mode === "managed" && !row.attempt_id ? "unbound" : "1", adapterDigest: row.adapter_digest, features: [] },
      state: row.state, usedTokens: 0, usedMicroUsd: Number(budget?.settled_micro_usd ?? 0), reservedMicroUsd: Number(budget?.micro_usd ?? 0),
      lastEventSequence: row.event_sequence, delegationDepth: row.delegation_depth,
      budget: JSON.parse(row.budget_json) as SessionBudget, scope: JSON.parse(row.scope_json) as SessionScope,
      worktreeId: row.worktree_id, ...(checkpoint ? { checkpoint } : {}),
      version: row.version, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  private delegation(workspaceId: string, row: DelegationRow): Delegation {
    const child = this.store.workspaceDb(workspaceId, this.organizationForWorkspace(workspaceId)).prepare("SELECT * FROM sessions WHERE id=?").get(row.child_session_id) as SessionRow;
    return {
      delegationId: row.id, workspaceId, parentSessionId: row.parent_session_id, childSessionId: row.child_session_id,
      workItemId: row.work_item_id, agentId: child.agent_id, task: child.task, depth: child.delegation_depth,
      budget: JSON.parse(child.budget_json) as SessionBudget, scope: JSON.parse(child.scope_json) as SessionScope,
      worktreeId: child.worktree_id, state: row.state,
      ...(row.reviewer_id ? { reviewerId: row.reviewer_id } : {}), ...(row.evidence_digest ? { evidenceDigest: row.evidence_digest } : {}),
      createdAt: iso(row.created_at_ms), ...(row.reviewed_at_ms ? { reviewedAt: iso(row.reviewed_at_ms) } : {}),
    };
  }

  private organizationForWorkspace(workspaceId: string): string {
    const row = this.store.control.prepare("SELECT organization_id FROM workspaces WHERE id=?").get(workspaceId) as { organization_id: string } | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "workspace not found");
    return row.organization_id;
  }

  apply(actor: ActorContext, command: SessionCommand): string {
    const workspaceId = command.workspaceId;
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    switch (command.commandType) {
      case "session.create": return this.create(actor, workspaceId, command.payload);
      case "session.checkpoint": return this.saveCheckpoint(actor, workspaceId, command.payload, command.expectedVersion);
      case "session.delegate": return this.delegate(actor, workspaceId, command.payload);
      case "delegation.review": return this.review(actor, workspaceId, command.payload);
      case "workItem.message": return this.message(actor, workspaceId, command.payload);
      default: throw new BrainDomainError("INVALID_CONTRACT", `unsupported session command ${command.commandType}`);
    }
  }

  private create(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const db = this.db(actor, workspaceId);
    const resumeId = payload["resumeFromSessionId"] ? String(payload["resumeFromSessionId"]) : "";
    const source = resumeId ? this.row(actor, workspaceId, resumeId) : undefined;
    const checkpoint = source ? this.checkpoint(source) : undefined;
    if (source && (!checkpoint || !["waiting", "stopped", "failed"].includes(source.state))) {
      throw new BrainDomainError("CONFLICT", "resume requires a checkpoint from a session with no active writer");
    }
    const workItemId = source?.work_item_id ?? String(payload["workItemId"]);
    if (!db.prepare("SELECT 1 FROM work_items WHERE id=? AND state!='abandoned'").get(workItemId)) throw new BrainDomainError("NOT_FOUND", "work item not found");
    const agentId = source?.agent_id ?? String(payload["agentId"]);
    const task = checkpoint?.nextAction ?? String(payload["task"]);
    const budget = source ? JSON.parse(source.budget_json) as SessionBudget : budgetOf(payload);
    const scope = source ? JSON.parse(source.scope_json) as SessionScope : scopeOf(payload);
    const worktreeId = source?.worktree_id ?? String(payload["worktreeId"]);
    if (source && (workItemId !== String(payload["workItemId"]) || agentId !== String(payload["agentId"]) || task !== String(payload["task"]) || worktreeId !== String(payload["worktreeId"]) || !sameJson(budget, budgetOf(payload)) || !sameJson(scope, scopeOf(payload)))) {
      throw new BrainDomainError("FORBIDDEN", "resume cannot expand or replace checkpoint authority");
    }
    const id = this.store.id("ses");
    this.store.inTx(db, () => {
      this.assertWorktreeAvailable(db, worktreeId, source?.root_session_id ?? id);
      const now = this.store.now();
      db.prepare(`INSERT INTO sessions(id,mode,work_item_id,parent_session_id,root_session_id,agent_id,task,engine_id,adapter_digest,state,delegation_depth,budget_json,scope_json,worktree_id,created_by,created_at_ms,updated_at_ms)
        VALUES (?,'managed',?,?,?,?,?,? ,?,'waiting',?,?,?,?,?,?,?)`).run(
        id, workItemId, source?.id ?? null, source?.root_session_id ?? id, agentId, task, String(payload["engineId"]), ZERO_DIGEST,
        source?.delegation_depth ?? 0, JSON.stringify(budget), JSON.stringify(scope), worktreeId, actor.actorId, now, now,
      );
      if (source && checkpoint) db.prepare("UPDATE sessions SET checkpoint_digest=?,checkpoint_json=? WHERE id=?").run(checkpoint.digest, JSON.stringify(checkpoint), id);
      this.store.emit(db, { aggregateType: "session", aggregateId: id, eventType: source ? "session.resumed" : "session.created", payload: { sessionId: id, workItemId, ...(source ? { resumeFromSessionId: source.id } : {}) } });
    });
    return id;
  }

  private saveCheckpoint(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const session = this.row(actor, workspaceId, String(payload["sessionId"]));
    assertExpectedVersion(session.version, expectedVersion);
    const input = payload["checkpoint"] as unknown as Omit<PortableCheckpoint, "digest">;
    if (input.worktreeId !== session.worktree_id || input.eventCursor > session.event_sequence) throw new BrainDomainError("CONFLICT", "checkpoint does not match the session's worktree or committed event cursor");
    const digest = domainDigest("brain:session-checkpoint:v1", { sessionId: session.id, ...input } as unknown as JsonValue);
    const checkpoint: PortableCheckpoint = { ...input, digest };
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      db.prepare("UPDATE sessions SET checkpoint_digest=?,checkpoint_json=?,state='waiting',version=version+1,updated_at_ms=? WHERE id=? AND version=?")
        .run(digest, JSON.stringify(checkpoint), this.store.now(), session.id, session.version);
      this.store.emit(db, { aggregateType: "session", aggregateId: session.id, eventType: "session.checkpointed", payload: { sessionId: session.id, checkpointDigest: digest } });
    });
    return session.id;
  }

  private delegate(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const parent = this.row(actor, workspaceId, String(payload["parentSessionId"]));
    if (!ACTIVE_SESSION_STATES.has(parent.state)) throw new BrainDomainError("CONFLICT", "delegation requires an active parent session");
    if (parent.delegation_depth >= 3) throw new BrainDomainError("FORBIDDEN", "maximum delegation depth is three");
    const agentId = String(payload["agentId"]);
    if (agentId === parent.agent_id) throw new BrainDomainError("FORBIDDEN", "cross-agent delegation requires a different child agent");
    const parentBudget = JSON.parse(parent.budget_json) as SessionBudget;
    const parentScope = JSON.parse(parent.scope_json) as SessionScope;
    const childBudget = budgetOf(payload);
    const childScope = scopeOf(payload);
    assertSubset(childScope.allowedPaths, parentScope.allowedPaths, "allowed paths");
    assertSubset(childScope.allowedTools, parentScope.allowedTools, "allowed tools");
    const scope: SessionScope = {
      allowedPaths: childScope.allowedPaths,
      allowedTools: childScope.allowedTools,
      prohibitedPaths: [...new Set([...parentScope.prohibitedPaths, ...childScope.prohibitedPaths])],
    };
    const worktreeId = String(payload["worktreeId"]);
    const childId = this.store.id("ses");
    const delegationId = this.store.id("del");
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      const siblings = db.prepare(`SELECT s.budget_json FROM delegations d JOIN sessions s ON s.id=d.child_session_id
        WHERE d.parent_session_id=? AND d.state IN ('active','accepted')`).all(parent.id) as Array<{ budget_json: string }>;
      const reserved = siblings.reduce((total, sibling) => {
        const value = JSON.parse(sibling.budget_json) as SessionBudget;
        return { maxTokens: total.maxTokens + value.maxTokens, maxMicroUsd: total.maxMicroUsd + value.maxMicroUsd, maxTurns: total.maxTurns + value.maxTurns };
      }, { maxTokens: 0, maxMicroUsd: 0, maxTurns: 0 });
      assertBudgetWithin(childBudget, {
        maxTokens: parentBudget.maxTokens - reserved.maxTokens,
        maxMicroUsd: parentBudget.maxMicroUsd - reserved.maxMicroUsd,
        maxTurns: parentBudget.maxTurns - reserved.maxTurns,
      });
      this.assertWorktreeAvailable(db, worktreeId, parent.root_session_id ?? parent.id);
      const now = this.store.now();
      db.prepare(`INSERT INTO sessions(id,mode,work_item_id,parent_session_id,root_session_id,agent_id,task,engine_id,adapter_digest,state,delegation_depth,budget_json,scope_json,worktree_id,created_by,created_at_ms,updated_at_ms)
        VALUES (?,'managed',?,?,?,?,?,? ,?,'waiting',?,?,?,?,?,?,?)`).run(
        childId, parent.work_item_id, parent.id, parent.root_session_id ?? parent.id, agentId, String(payload["task"]), String(payload["engineId"]), ZERO_DIGEST,
        parent.delegation_depth + 1, JSON.stringify(childBudget), JSON.stringify(scope), worktreeId, actor.actorId, now, now,
      );
      db.prepare("INSERT INTO delegations(id,parent_session_id,child_session_id,work_item_id,state,created_at_ms) VALUES (?,?,?,?,'active',?)")
        .run(delegationId, parent.id, childId, parent.work_item_id, now);
      this.store.emit(db, { aggregateType: "session", aggregateId: parent.id, eventType: "session.delegated", payload: { delegationId, parentSessionId: parent.id, childSessionId: childId, workItemId: parent.work_item_id } });
    });
    return delegationId;
  }

  private assertWorktreeAvailable(db: ReturnType<Store["workspaceDb"]>, worktreeId: string, rootSessionId: string): void {
    if (!worktreeId) throw new BrainDomainError("INVALID_ARGUMENT", "worktreeId required");
    const conflict = db.prepare(`SELECT id FROM sessions WHERE root_session_id=? AND worktree_id=? AND state IN ('starting','running','stopping') LIMIT 1`).get(rootSessionId, worktreeId);
    if (conflict) throw new BrainDomainError("CONFLICT", "active writers cannot share a worktree");
  }

  private review(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const delegation = this.delegationRow(actor, workspaceId, String(payload["delegationId"]));
    if (delegation.state !== "active") throw new BrainDomainError("CONFLICT", "delegation review is already final");
    const parent = this.row(actor, workspaceId, delegation.parent_session_id);
    const child = this.row(actor, workspaceId, delegation.child_session_id);
    if (actor.actorId === parent.created_by || actor.actorId === child.agent_id) throw new BrainDomainError("FORBIDDEN", "delegation review requires an independent reviewer");
    if (!child.job_id || !child.attempt_id) throw new BrainDomainError("EVIDENCE_MISSING", "child session has no executed attempt to review");
    const evidenceDigest = String(payload["evidenceDigest"]);
    const decision = String(payload["decision"]);
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      const bundle = db.prepare("SELECT state,job_id FROM evidence_bundles WHERE digest=?").get(evidenceDigest) as { state: string; job_id: string } | undefined;
      if (!bundle || bundle.job_id !== child.job_id || (decision === "accepted" && bundle.state !== "verified")) throw new BrainDomainError("EVIDENCE_MISSING", "review evidence must belong to the child job and have the required verified state");
      const verdict = db.prepare("SELECT evaluator_attempt_id,outcome FROM verification_verdicts WHERE bundle_digest=? ORDER BY created_at_ms DESC LIMIT 1").get(evidenceDigest) as { evaluator_attempt_id: string; outcome: string } | undefined;
      if (!verdict || verdict.evaluator_attempt_id === child.attempt_id || (decision === "accepted" && verdict.outcome !== "verified") || (decision === "rejected" && verdict.outcome === "verified")) {
        throw new BrainDomainError("EVIDENCE_MISSING", "review requires an independent evaluator verdict matching the decision");
      }
      const now = this.store.now();
      db.prepare("UPDATE delegations SET state=?,reviewer_id=?,evidence_digest=?,reviewed_at_ms=? WHERE id=? AND state='active'")
        .run(decision, actor.actorId, evidenceDigest, now, delegation.id);
      db.prepare("UPDATE sessions SET state=?,version=version+1,updated_at_ms=? WHERE id=?").run(decision === "accepted" ? "stopped" : "failed", now, child.id);
      this.store.emit(db, { aggregateType: "delegation", aggregateId: delegation.id, eventType: "delegation.reviewed", payload: { delegationId: delegation.id, childSessionId: child.id, decision, evidenceDigest, reviewerId: actor.actorId } });
    });
    return delegation.id;
  }

  private message(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>): string {
    const workItemId = String(payload["workItemId"]);
    if (!this.db(actor, workspaceId).prepare("SELECT 1 FROM work_items WHERE id=?").get(workItemId)) throw new BrainDomainError("NOT_FOUND", "work item not found");
    const sessionId = payload["sessionId"] ? String(payload["sessionId"]) : "";
    if (sessionId && this.row(actor, workspaceId, sessionId).work_item_id !== workItemId) throw new BrainDomainError("FORBIDDEN", "session and message work item differ");
    const correctionOf = payload["correctionOf"] ? String(payload["correctionOf"]) : "";
    const db = this.db(actor, workspaceId);
    if (correctionOf && !db.prepare("SELECT 1 FROM work_item_messages WHERE id=? AND work_item_id=?").get(correctionOf, workItemId)) throw new BrainDomainError("NOT_FOUND", "corrected message not found in this work item");
    const id = this.store.id("msg");
    db.prepare("INSERT INTO work_item_messages(id,work_item_id,session_id,sender_id,sender_kind,body,correction_of,created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, workItemId, sessionId || null, actor.actorId, actor.kind, String(payload["body"]), correctionOf || null, this.store.now());
    return id;
  }

  workItemForDispatch(actor: ActorContext, workspaceId: string, sessionId: string): string {
    const session = this.row(actor, workspaceId, sessionId);
    if (session.mode !== "managed" || session.state !== "waiting" || session.job_id || !session.work_item_id) throw new BrainDomainError("CONFLICT", "only an unbound managed session can be dispatched");
    return session.work_item_id;
  }

  attachRun(actor: ActorContext, workspaceId: string, sessionId: string, runId: string): void {
    const session = this.row(actor, workspaceId, sessionId);
    if (session.mode !== "managed" || session.state !== "waiting") throw new BrainDomainError("CONFLICT", "managed session is not available for dispatch");
    const db = this.db(actor, workspaceId);
    this.store.inTx(db, () => {
      const updated = db.prepare("UPDATE execution_links SET session_id=? WHERE work_item_id=? AND run_id=?").run(sessionId, session.work_item_id, runId);
      if (updated.changes !== 1) throw new BrainDomainError("CONFLICT", "session execution link was not created");
      db.prepare("UPDATE sessions SET state='starting',version=version+1,updated_at_ms=? WHERE id=?").run(this.store.now(), sessionId);
    });
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, resourceId?: string, limit = 100): JsonValue {
    const db = this.db(actor, workspaceId);
    if (queryType === "sessions.list") {
      const rows = db.prepare("SELECT * FROM sessions ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as SessionRow[];
      return { items: rows.map((row) => this.view(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "session.get") return this.view(workspaceId, this.row(actor, workspaceId, String(resourceId))) as unknown as JsonValue;
    if (queryType === "delegations.list") {
      const rows = db.prepare("SELECT * FROM delegations ORDER BY created_at_ms DESC,id LIMIT ?").all(limit) as DelegationRow[];
      return { items: rows.map((row) => this.delegation(workspaceId, row)) } as unknown as JsonValue;
    }
    if (queryType === "workItemMessages.list") {
      const rows = resourceId
        ? db.prepare("SELECT * FROM work_item_messages WHERE work_item_id=? ORDER BY created_at_ms,id LIMIT ?").all(resourceId, limit) as MessageRow[]
        : db.prepare("SELECT * FROM work_item_messages ORDER BY created_at_ms,id LIMIT ?").all(limit) as MessageRow[];
      const items = rows.map((row): WorkItemMessage => ({
        messageId: row.id, workItemId: row.work_item_id, ...(row.session_id ? { sessionId: row.session_id } : {}),
        senderId: row.sender_id, senderKind: row.sender_kind, body: row.body,
        ...(row.correction_of ? { correctionOf: row.correction_of } : {}), createdAt: iso(row.created_at_ms),
      }));
      return { items } as unknown as JsonValue;
    }
    throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `unsupported session query ${queryType}`);
  }
}

export function recordAttemptSession(store: Store, input: {
  organizationId: string; workspaceId: string; jobId: string; attemptId: string;
  engineId: string; adapterDigest: string; sessionId?: string;
}): void {
  const db = store.workspaceDb(input.workspaceId, input.organizationId);
  const now = store.now();
  if (input.sessionId) {
    const updated = db.prepare(`UPDATE sessions SET job_id=?,attempt_id=?,engine_id=?,adapter_digest=?,state='running',version=version+1,updated_at_ms=?
      WHERE id=? AND mode='managed' AND job_id IS NULL AND state IN ('waiting','starting')`)
      .run(input.jobId, input.attemptId, input.engineId, input.adapterDigest, now, input.sessionId);
    if (updated.changes !== 1) throw new BrainDomainError("CONFLICT", "managed session cannot bind this attempt");
    db.prepare("UPDATE execution_links SET job_id=?,attempt_id=? WHERE session_id=?").run(input.jobId, input.attemptId, input.sessionId);
    return;
  }
  const id = `ses-${input.jobId}`;
  db.prepare(`INSERT INTO sessions(id,job_id,attempt_id,mode,agent_id,task,engine_id,adapter_digest,state,root_session_id,worktree_id,created_by,created_at_ms,updated_at_ms)
    VALUES (?,?,?,'native','',?, ?,?,'running',?,?,?, ?,?)
    ON CONFLICT(id) DO UPDATE SET attempt_id=excluded.attempt_id,engine_id=excluded.engine_id,adapter_digest=excluded.adapter_digest,state='running',updated_at_ms=excluded.updated_at_ms`)
    .run(id, input.jobId, input.attemptId, `job ${input.jobId}`, input.engineId, input.adapterDigest, id, `read-only:${input.workspaceId}`, "runner", now, now);
}
