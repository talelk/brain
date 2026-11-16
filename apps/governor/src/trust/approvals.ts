import {
  approvalSubjectDigest, BrainError, domainDigest, type Approval, type ApprovalState, type ApprovalSubject, type BrainFile, type Digest, type Effect, type JsonValue, type SnapshotManifest, type ToolOutcome,
} from "@brain/contracts";
import type { Governor } from "../app";
import { tx, type Db } from "../db";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { attemptEnded } from "../tasks/orchestrator";
import { attemptOf, needOf, newId, payloadOf, queueAttempt, setState, taskOf, utcDay, type AttemptRow, type TaskRow } from "../tasks/store";
import { manifestOf } from "../workspace/store";

/**
 * Approvals (docs/architecture.md section 7). A call with an effect is bound to a subject: the tool and its definition, the input, the task
 * and its snapshot. A standing approval of `brain.toml` covers it at once; otherwise a person decides, on exactly the subject they were shown.
 */
const PENDING_FOR_MS = 7 * 86_400_000;

/** What a pull request would carry: the patch, and the commit it is made on when one is known. */
export interface PullRequestChange { readonly patchDigest?: Digest | undefined; readonly baseCommit?: string | undefined }

/** What an approver is shown and what their decision is bound to. */
export function approvalSubject(manifest: SnapshotManifest, call: { tool: string; input: JsonValue; taskId: string; snapshotDigest: Digest } & PullRequestChange): ApprovalSubject {
  return {
    tool: call.tool, toolDigest: domainDigest("brain:tool:v1", (manifest.tools[call.tool] ?? null) as unknown as JsonValue), input: call.input, inputDigest: domainDigest("brain:tool-input:v1", call.input),
    taskId: call.taskId, snapshotDigest: call.snapshotDigest, ...(call.patchDigest !== undefined ? { patchDigest: call.patchDigest } : {}), ...(call.baseCommit !== undefined ? { baseCommit: call.baseCommit } : {}),
  };
}

/**
 * Whether a standing approval covers a call: the call names at least one target (a string among its inputs), every string it names is a
 * listed target, the day's uses are under `per_day`, and `until` has not passed (`today` and `until` are `YYYY-MM-DD`).
 */
export function standingCovers(standing: BrainFile["approvals"][string] | undefined, input: JsonValue, usedToday: number, today: string): boolean {
  if (!standing || input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const named = Object.values(input).filter((value): value is string => typeof value === "string");
  return named.length > 0 && named.every((value) => standing.targets.includes(value)) && usedToday < standing.per_day && today <= standing.until;
}

// --- recorded calls ---

/** The row of a call: the attempt's own call id, except in an `act` attempt, which carries the id of the call it was approved to run. */
export const callRowId = (attempt: AttemptRow, callId: string): string => (payloadOf(attempt).act?.callId === callId ? callId : `${attempt.id}:${callId}`);

export function openCall(gov: Gov, attempt: AttemptRow, callId: string, call: { tool: string; effect: Effect; input: JsonValue }): string {
  const id = callRowId(attempt, callId);
  gov.db.prepare("INSERT OR IGNORE INTO tool_calls(id, workspace_id, task_id, attempt_id, tool, effect, input_json, input_digest, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, attempt.workspace_id, attempt.task_id, attempt.id, call.tool, call.effect, JSON.stringify(call.input), domainDigest("brain:tool-input:v1", call.input), gov.clock.nowMs());
  return id;
}
/** Records how a call ended, once. A call that was held is finished later, by the attempt that carries it out. */
export function finishCall(gov: Gov, id: string, outcome: ToolOutcome, output: JsonValue): void {
  const done = gov.db.prepare("UPDATE tool_calls SET outcome=?, output_json=?, finished_at_ms=? WHERE id=? AND outcome IN ('pending','held')").run(outcome, JSON.stringify(output), gov.clock.nowMs(), id);
  if (done.changes === 0) return;
  const call = gov.db.prepare("SELECT workspace_id, task_id, attempt_id, tool, effect, input_digest FROM tool_calls WHERE id=?").get(id) as { workspace_id: string; task_id: string; attempt_id: string; tool: string; effect: Effect; input_digest: Digest };
  append(gov.db, { type: "tool.called", workspaceId: call.workspace_id, subject: `task:${call.task_id}`, payload: { callId: id, tool: call.tool, effect: call.effect, inputDigest: call.input_digest, outcome }, actor: { kind: "agent", id: attemptOf(gov.db, call.attempt_id).agent, attemptId: call.attempt_id } });
}

// --- asking and deciding ---

interface ApprovalRow {
  readonly id: string; readonly workspace_id: string; readonly task_id: string; readonly attempt_id: string; readonly tool: string; readonly effect: Effect; readonly subject_json: string;
  readonly subject_digest: Digest; readonly state: ApprovalState; readonly standing: number; readonly expires_at_ms: number | null; readonly decided_by: string | null;
  readonly decided_at_ms: number | null; readonly reason: string | null; readonly created_at_ms: number; readonly version: number;
}
export interface CallDecision { readonly rowId: string; readonly state: ApprovalState; readonly approvalId?: string; readonly reason?: string; readonly subject?: ApprovalSubject }

/**
 * Whether a call may run now. A `read` call may. A call with an effect is approved at once when a standing approval covers it; otherwise
 * an approval is pending and the task needs a person. Asking again for the same call answers what was decided.
 */
export function authorizeCall(gov: Gov, attempt: AttemptRow, call: { callId: string; tool: string; effect: Effect; input: JsonValue } & PullRequestChange): CallDecision {
  const { db } = gov;
  const rowId = callRowId(attempt, call.callId);
  const known = db.prepare("SELECT approval_id FROM tool_calls WHERE id=?").get(rowId) as { approval_id: string | null } | undefined;
  if (known?.approval_id) {
    const approval = db.prepare("SELECT * FROM approvals WHERE id=?").get(known.approval_id) as ApprovalRow;
    return { rowId, state: approval.state, approvalId: approval.id, subject: JSON.parse(approval.subject_json) as ApprovalSubject, ...(approval.reason ? { reason: approval.reason } : {}) };
  }
  openCall(gov, attempt, call.callId, call);
  if (call.effect === "read") return { rowId, state: "approved" };
  const task = taskOf(db, attempt.task_id);
  const manifest = manifestOf(gov, task.snapshot_digest);
  const subject = approvalSubject(manifest, { tool: call.tool, input: call.input, taskId: task.id, snapshotDigest: task.snapshot_digest, patchDigest: call.patchDigest, baseCommit: call.baseCommit });
  const now = gov.clock.nowMs();
  const today = utcDay(now);
  const used = (db.prepare("SELECT count FROM standing_uses WHERE workspace_id=? AND tool=? AND day=?").get(task.workspace_id, call.tool, today) as { count: number } | undefined)?.count ?? 0;
  const standing = standingCovers(manifest.approvals[call.tool], call.input, used, today);
  const id = newId("ap");
  db.prepare("INSERT INTO approvals(id, workspace_id, task_id, attempt_id, tool, effect, subject_json, subject_digest, state, standing, expires_at_ms, decided_at_ms, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, task.workspace_id, task.id, attempt.id, call.tool, call.effect, JSON.stringify(subject), approvalSubjectDigest(subject as unknown as JsonValue), standing ? "approved" : "pending", standing ? 1 : 0, standing ? null : now + PENDING_FOR_MS, standing ? now : null, now);
  db.prepare("UPDATE tool_calls SET approval_id=? WHERE id=?").run(id, rowId);
  const actor = { kind: "agent" as const, id: attempt.agent, attemptId: attempt.id };
  if (standing) {
    db.prepare("INSERT INTO standing_uses(workspace_id, tool, day, count) VALUES (?,?,?,1) ON CONFLICT(workspace_id, tool, day) DO UPDATE SET count=count+1").run(task.workspace_id, call.tool, today);
    append(db, { type: "approval.standing", workspaceId: task.workspace_id, subject: `approval:${id}`, payload: { taskId: task.id, tool: call.tool, subjectDigest: approvalSubjectDigest(subject as unknown as JsonValue), use: used + 1 }, actor });
    return { rowId, state: "approved", approvalId: id, subject };
  }
  append(db, { type: "approval.requested", workspaceId: task.workspace_id, subject: `approval:${id}`, payload: { taskId: task.id, tool: call.tool, subjectDigest: approvalSubjectDigest(subject as unknown as JsonValue) }, actor });
  if (task.state === "running") setState(gov, task, "needs_you", { need: { kind: "approval", approvalId: id } });
  return { rowId, state: "pending", approvalId: id, subject };
}

/** After an approval of a running attempt was decided: the task shows the next one that is pending, or runs again. */
function showNext(gov: Gov, task: TaskRow): void {
  if (needOf(task)?.kind !== "approval") return;
  const next = gov.db.prepare("SELECT id FROM approvals WHERE task_id=? AND state='pending' ORDER BY rowid LIMIT 1").get(task.id) as { id: string } | undefined;
  if (next) setState(gov, task, "needs_you", { need: { kind: "approval", approvalId: next.id } });
  else setState(gov, task, "running");
}

/** Pending approvals that will not be decided any more (the attempt ended otherwise, the task stopped, nobody decided in time): the call did not happen. */
export function expireApprovals(gov: Gov, of: { attemptId: string } | { taskId: string } | { dueAt: number }, reason: string): void {
  const { db } = gov;
  const rows = ("attemptId" in of ? db.prepare("SELECT * FROM approvals WHERE attempt_id=? AND state='pending'").all(of.attemptId)
    : "taskId" in of ? db.prepare("SELECT * FROM approvals WHERE task_id=? AND state='pending'").all(of.taskId)
      : db.prepare("SELECT * FROM approvals WHERE state='pending' AND expires_at_ms<=?").all(of.dueAt)) as ApprovalRow[];
  for (const row of rows) {
    db.prepare("UPDATE approvals SET state='expired', reason=?, decided_at_ms=?, version=version+1 WHERE id=?").run(reason, gov.clock.nowMs(), row.id);
    db.prepare("UPDATE tool_calls SET outcome='rejected', output_json=?, finished_at_ms=? WHERE approval_id=? AND outcome IN ('pending','held')").run(JSON.stringify({ error: reason }), gov.clock.nowMs(), row.id);
    append(db, { type: "approval.expired", workspaceId: row.workspace_id, subject: `approval:${row.id}`, payload: { taskId: row.task_id, reason }, actor: SYSTEM });
    // Decided by time: the task that waited for it moves on, as after a rejection.
    if (!("dueAt" in of)) continue;
    if (attemptOf(db, row.attempt_id).state === "held") attemptEnded(gov, row.attempt_id);
    else showNext(gov, taskOf(db, row.task_id));
  }
}

const VIEW = `SELECT a.*, t.title AS task_title, t.root_id AS root_task_id, r.title AS goal_title, x.agent AS agent, u.name AS decided_name FROM approvals a JOIN tasks t ON t.id = a.task_id JOIN tasks r ON r.id = t.root_id JOIN attempts x ON x.id = a.attempt_id LEFT JOIN "user" u ON u.id = a.decided_by`;
type ViewRow = ApprovalRow & { readonly task_title: string; readonly root_task_id: string; readonly goal_title: string; readonly agent: string; readonly decided_name: string | null };
const view = (row: ViewRow): Approval => ({
  id: row.id, workspaceId: row.workspace_id, taskId: row.task_id, taskTitle: row.task_title, rootTaskId: row.root_task_id, goalTitle: row.goal_title, attemptId: row.attempt_id, agent: row.agent, tool: row.tool, effect: row.effect,
  subject: JSON.parse(row.subject_json) as ApprovalSubject, subjectDigest: row.subject_digest, state: row.state, standing: row.standing === 1, requestedAt: row.created_at_ms, expiresAt: row.expires_at_ms,
  decidedBy: row.decided_by ? { id: row.decided_by, name: row.decided_name ?? row.decided_by } : null, decidedAt: row.decided_at_ms, reason: row.reason, version: row.version,
});
/** Approvals as the screens show them: `where` is a condition on `approvals a`. */
export function approvalsWhere(db: Db, where: string, ...values: unknown[]): Approval[] {
  return (db.prepare(`${VIEW} WHERE ${where}`).all(...values) as ViewRow[]).map(view);
}

export function registerApprovals(governor: Governor): void {
  const { gov } = governor;
  gov.registry.query("approvals.list", (ctx, input) => ({
    approvals: approvalsWhere(ctx.db, "a.workspace_id=? AND (? IS NULL OR a.state=?) ORDER BY a.created_at_ms DESC, a.rowid DESC LIMIT ?", input.workspaceId, input.state ?? null, input.state ?? null, input.limit),
  }));
  gov.registry.query("approval.get", (ctx, input) => {
    const [approval] = approvalsWhere(ctx.db, "a.workspace_id=? AND a.id=?", input.workspaceId, input.approvalId);
    if (!approval) throw new BrainError("NOT_FOUND", "Approval not found");
    return approval;
  });

  gov.registry.command("approval.decide", (ctx, input) => {
    const { db } = ctx;
    const row = db.prepare("SELECT * FROM approvals WHERE id=? AND workspace_id=?").get(input.approvalId, input.workspaceId) as ApprovalRow | undefined;
    if (!row) throw new BrainError("NOT_FOUND", "Approval not found");
    if (row.state !== "pending") throw new BrainError("CONFLICT", `This approval is already ${row.state}`);
    if (row.expires_at_ms !== null && row.expires_at_ms <= ctx.now()) throw new BrainError("CONFLICT", "This approval expired; the call did not happen");
    // The decision is for exactly what the approver was shown, and what is stored must still be what was asked.
    if (input.subjectDigest !== row.subject_digest || approvalSubjectDigest(JSON.parse(row.subject_json) as JsonValue) !== row.subject_digest) {
      throw new BrainError("STALE_VERSION", "The call is not the one you were shown; read the approval again");
    }
    const state: ApprovalState = input.decision === "approve" ? "approved" : "rejected";
    db.prepare("UPDATE approvals SET state=?, decided_by=?, decided_at_ms=?, reason=?, version=version+1 WHERE id=?").run(state, ctx.actor.id, ctx.now(), input.reason, row.id);
    append(db, { type: `approval.${state}`, workspaceId: row.workspace_id, subject: `approval:${row.id}`, payload: { taskId: row.task_id, tool: row.tool, subjectDigest: row.subject_digest, reason: input.reason }, actor: ctx.actor });
    const call = db.prepare("SELECT id, input_json FROM tool_calls WHERE approval_id=?").get(row.id) as { id: string; input_json: string };
    if (state === "rejected") finishCall(ctx.gov, call.id, "rejected", { error: input.reason === "" ? "A person declined this call" : `A person declined this call: ${input.reason}` });
    const attempt = attemptOf(db, row.attempt_id);
    const task = taskOf(db, row.task_id);
    if (attempt.state === "held") {
      // The attempt gave up waiting: an approved call is carried out by an attempt of its own, and then the task is queued again.
      if (state === "approved") queueAttempt(ctx.gov, { task, kind: "act", agent: attempt.agent, payload: { act: { callId: call.id, approvalId: row.id, tool: row.tool, input: JSON.parse(call.input_json) as JsonValue } } });
      attemptEnded(ctx.gov, attempt.id);
    } else showNext(ctx.gov, task);
    return { state };
  });

  governor.every(60_000, () => expireDue(gov));
}

/** Expires the approvals nobody decided in time. */
export function expireDue(gov: Gov): void {
  tx(gov.db, () => expireApprovals(gov, { dueAt: gov.clock.nowMs() }, "Nobody decided in time"));
}
