import type { JsonValue } from "@brain/contracts";
import type { ActorContext } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { STREAM_EMITTERS, STREAM_SEVERITIES, type StreamEmitter, type StreamSeverity, type StreamSource } from "./classify";

/**
 * Authorized reads over the execution stream. Scoping happens in SQL WHERE
 * before LIMIT — organization rows plus workspaces the actor is a member of —
 * so pages are filled by authorized rows instead of being post-filtered
 * underfilled. Every stream.* clamp lives here, not in the generic query
 * clamp: tail ≤ 200, search ≤ 50, compare ≤ 500 rows × 4 attempts.
 */

export const TAIL_LIMIT = 200;
export const SEARCH_LIMIT = 50;
export const COMPARE_ATTEMPTS = 4;
export const COMPARE_ROWS = 500;
export const EXPORT_LIMIT = 10_000;

export interface StreamCorrelation {
  sessionId?: string; jobId?: string; runId?: string; attemptId?: string;
  workItemId?: string; invocationId?: string; proposalId?: string;
}

export interface StreamRecordView {
  streamSeq: number;
  eventId: string;
  source: StreamSource;
  emitter: StreamEmitter;
  severity: StreamSeverity | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateSeq: number;
  workspaceId?: string;
  at: string;
  tsApproximate: boolean;
  correlation?: StreamCorrelation;
  summary: JsonValue;
  payloadRef: JsonValue;
}

export interface StreamFilters {
  workspaceId?: string;
  sessionId?: string;
  jobId?: string;
  runId?: string;
  attemptId?: string;
  emitters?: readonly string[];
  severities?: readonly string[];
  after?: number;
  before?: number;
}

interface StreamRow {
  stream_seq: number;
  event_id: string;
  organization_id: string;
  workspace_id: string | null;
  source: StreamSource;
  emitter: StreamEmitter;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_seq: number;
  event_type: string;
  severity: StreamSeverity | null;
  occurred_at_ms: number;
  ts_approximate: number;
  run_id: string | null; job_id: string | null; attempt_id: string | null;
  session_id: string | null; work_item_id: string | null;
  invocation_id: string | null; proposal_id: string | null;
  summary_json: string;
  payload_ref_json: string;
}

function rowToView(row: StreamRow): StreamRecordView {
  const parse = (text: string, fallback: JsonValue): JsonValue => {
    try { return JSON.parse(text) as JsonValue; } catch { return fallback; }
  };
  const correlation: StreamCorrelation = {
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    ...(row.work_item_id ? { workItemId: row.work_item_id } : {}),
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
  };
  return {
    streamSeq: Number(row.stream_seq),
    eventId: row.event_id,
    source: row.source,
    emitter: row.emitter,
    severity: row.severity,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateSeq: Number(row.aggregate_seq),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    at: iso(Number(row.occurred_at_ms)),
    tsApproximate: row.ts_approximate === 1,
    ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
    summary: parse(row.summary_json, null),
    payloadRef: parse(row.payload_ref_json, { kind: "inline" }),
  };
}

export function frameOf(record: StreamRecordView): Record<string, JsonValue> {
  return {
    streamSeq: record.streamSeq,
    eventId: record.eventId,
    type: record.eventType,
    severity: record.severity,
    emitter: record.emitter,
    source: record.source,
    aggregateId: record.aggregateId,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    at: record.at,
    ...(record.correlation ? { correlation: record.correlation } : {}),
    summary: record.summary,
  } as unknown as Record<string, JsonValue>;
}

/**
 * Organization rows plus member workspaces; never post-filters after LIMIT.
 * Explicit workspace scoping also admits the org-scoped rows (workspace_id
 * NULL): they are visible org-wide, and the runner/system emitters — including
 * the only critical severity, the restored-authority quarantine — have no
 * workspace to surface through. Membership still gates the workspace itself.
 */
export function scopeFor(store: Store, actor: ActorContext, workspaceId?: string): { clause: string; params: Array<string | number> } {
  if (workspaceId) {
    requireWorkspaceRead(store, actor, workspaceId);
    return { clause: "s.organization_id=? AND (s.workspace_id=? OR s.workspace_id IS NULL)", params: [actor.organizationId, workspaceId] };
  }
  const memberships = store.control.prepare(
    "SELECT workspace_id FROM workspace_memberships WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL",
  ).all(actor.organizationId, actor.actorId) as Array<{ workspace_id: string }>;
  if (memberships.length === 0) {
    // Org-scoped rows (workspace_id NULL) are visible org-wide; member rows are not.
    return { clause: "s.organization_id=? AND s.workspace_id IS NULL", params: [actor.organizationId] };
  }
  const marks = memberships.map(() => "?").join(",");
  return { clause: `s.organization_id=? AND (s.workspace_id IS NULL OR s.workspace_id IN (${marks}))`, params: [actor.organizationId, ...memberships.map((m) => m.workspace_id)] };
}

export function filterClauses(filters: StreamFilters): { clauses: string[]; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filters.sessionId) { clauses.push("s.session_id=?"); params.push(filters.sessionId); }
  if (filters.jobId) { clauses.push("s.job_id=?"); params.push(filters.jobId); }
  if (filters.runId) { clauses.push("s.run_id=?"); params.push(filters.runId); }
  if (filters.attemptId) { clauses.push("s.attempt_id=?"); params.push(filters.attemptId); }
  const emitters = (filters.emitters ?? []).filter((e): e is StreamEmitter => (STREAM_EMITTERS as readonly string[]).includes(e));
  if (emitters.length > 0) { clauses.push(`s.emitter IN (${emitters.map(() => "?").join(",")})`); params.push(...emitters); }
  const severities = (filters.severities ?? []).filter((sv): sv is StreamSeverity => (STREAM_SEVERITIES as readonly string[]).includes(sv));
  if (severities.length > 0) { clauses.push(`s.severity IN (${severities.map(() => "?").join(",")})`); params.push(...severities); }
  if (filters.after !== undefined) { clauses.push("s.stream_seq>?"); params.push(filters.after); }
  if (filters.before !== undefined) { clauses.push("s.stream_seq<?"); params.push(filters.before); }
  return { clauses, params };
}

export function headCursor(store: Store): number {
  return Number((store.control.prepare("SELECT COALESCE(MAX(stream_seq),0) AS m FROM execution_stream").get() as { m: number }).m);
}

export function tail(store: Store, actor: ActorContext, filters: StreamFilters, rawLimit?: number): { items: StreamRecordView[]; head: number; next: number | "" } {
  const limit = Math.min(Math.max(Math.floor(rawLimit ?? 100) || 100, 1), TAIL_LIMIT);
  const scope = scopeFor(store, actor, filters.workspaceId);
  const filter = filterClauses(filters);
  const where = [scope.clause, ...filter.clauses].join(" AND ");
  const rows = store.control.prepare(`SELECT s.* FROM execution_stream s WHERE ${where} ORDER BY s.stream_seq ASC LIMIT ?`)
    .all(...scope.params, ...filter.params, limit) as Array<StreamRow>;
  const items = rows.map(rowToView);
  return {
    items,
    head: headCursor(store),
    next: items.length === limit && items.length > 0 ? items[items.length - 1]!.streamSeq : "",
  };
}

export function readBetween(store: Store, actor: ActorContext, filters: StreamFilters, limit: number): StreamRecordView[] {
  return tail(store, actor, filters, limit).items;
}

export function recordByEventId(store: Store, actor: ActorContext, eventId: string): StreamRecordView {
  const scope = scopeFor(store, actor);
  const row = store.control.prepare(`SELECT s.* FROM execution_stream s WHERE s.event_id=? AND ${scope.clause} LIMIT 1`)
    .get(eventId, ...scope.params) as StreamRow | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "stream record not found");
  return rowToView(row);
}

/**
 * Correlation bundle for P0 jumps: everything the exact execution context of
 * one record links to. Approval linkage resolves by invocation through
 * effect_permits (UNIQUE invocation_id) with approval_consumptions as
 * fallback; artifacts resolve through the row's CAS pointer and summary refs.
 */
export function contextBundle(store: Store, actor: ActorContext, eventId: string): JsonValue {
  const record = recordByEventId(store, actor, eventId);
  const workspaceId = record.workspaceId;
  const ws = workspaceId ? store.workspaceDb(workspaceId, actor.organizationId) : undefined;
  const c = record.correlation ?? {};
  let session: JsonValue | undefined;
  if (ws && c.sessionId) {
    const row = ws.prepare("SELECT id, state, agent_id, engine_id, work_item_id, job_id, attempt_id FROM sessions WHERE id=?").get(c.sessionId) as Record<string, unknown> | undefined;
    if (row) session = {
      sessionId: String(row["id"]), state: String(row["state"]), agentId: String(row["agent_id"]), engineId: String(row["engine_id"]),
      ...(row["work_item_id"] ? { workItemId: String(row["work_item_id"]) } : {}),
      ...(row["job_id"] ? { jobId: String(row["job_id"]) } : {}),
      ...(row["attempt_id"] ? { attemptId: String(row["attempt_id"]) } : {}),
    } as unknown as JsonValue;
  }
  let job: JsonValue | undefined;
  if (c.jobId) {
    const row = store.control.prepare("SELECT id, workspace_id, workflow_run_id, state FROM jobs WHERE id=? AND organization_id=?").get(c.jobId, actor.organizationId) as Record<string, unknown> | undefined;
    if (row) job = { jobId: String(row["id"]), workspaceId: String(row["workspace_id"]), runId: String(row["workflow_run_id"]), state: String(row["state"]) } as unknown as JsonValue;
  }
  let run: JsonValue | undefined;
  if (ws && c.runId) {
    const row = ws.prepare("SELECT id, state FROM workflow_runs WHERE id=?").get(c.runId) as Record<string, unknown> | undefined;
    if (row) run = { runId: String(row["id"]), state: String(row["state"]) } as unknown as JsonValue;
  }
  let attempt: JsonValue | undefined;
  if (c.attemptId) {
    const row = store.control.prepare("SELECT id, job_id, state, attempt_no FROM job_attempts WHERE id=?").get(c.attemptId) as Record<string, unknown> | undefined;
    if (row) attempt = { attemptId: String(row["id"]), jobId: String(row["job_id"]), state: String(row["state"]), number: Number(row["attempt_no"]) } as unknown as JsonValue;
  }
  let invocation: JsonValue | undefined;
  if (c.invocationId) {
    const row = store.control.prepare("SELECT id, state, approval_id, attempt_id FROM effect_permits WHERE invocation_id=?").get(c.invocationId) as Record<string, unknown> | undefined;
    if (row) invocation = {
      invocationId: c.invocationId, permitId: String(row["id"]), state: String(row["state"]),
      ...(row["approval_id"] ? { approvalId: String(row["approval_id"]) } : {}),
      ...(row["attempt_id"] ? { attemptId: String(row["attempt_id"]) } : {}),
    } as unknown as JsonValue;
  }
  let approval: JsonValue | undefined;
  let approvalId: string | undefined;
  if (record.aggregateType === "approval") approvalId = record.aggregateId;
  if (!approvalId && invocation) approvalId = (invocation as { approvalId?: string }).approvalId;
  if (!approvalId && c.invocationId) {
    approvalId = (store.control.prepare("SELECT approval_id FROM approval_consumptions WHERE invocation_id=?").get(c.invocationId) as { approval_id: string } | undefined)?.approval_id;
  }
  if (approvalId) {
    const row = store.control.prepare("SELECT id, state, workspace_id FROM approval_requests WHERE id=? AND organization_id=?").get(approvalId, actor.organizationId) as Record<string, unknown> | undefined;
    if (row) {
      requireWorkspaceRead(store, actor, String(row["workspace_id"]));
      approval = { approvalId: String(row["id"]), state: String(row["state"]) } as unknown as JsonValue;
    }
  }
  const digests = new Set<string>();
  if ((record.payloadRef as { kind?: string }).kind === "cas") {
    const digest = (record.payloadRef as { digest?: string }).digest;
    if (digest) digests.add(digest);
  }
  const scan = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) scan(entry); return; }
    const record_ = value as Record<string, unknown>;
    const digest = record_["digest"];
    if (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest)) digests.add(digest);
    for (const child of Object.values(record_)) scan(child);
  };
  scan(record.summary);
  const artifacts: JsonValue[] = [];
  if (ws && digests.size > 0) {
    for (const digest of [...digests].slice(0, 20)) {
      const row = ws.prepare("SELECT id, digest, bytes, media_type, classification, state FROM artifacts WHERE digest=? ORDER BY created_at_ms DESC LIMIT 1").get(digest) as Record<string, unknown> | undefined;
      if (row) artifacts.push({
        artifactId: String(row["id"]), digest: String(row["digest"]), bytes: Number(row["bytes"]),
        mediaType: String(row["media_type"]), classification: String(row["classification"]), state: String(row["state"]),
      } as unknown as JsonValue);
    }
  }
  return {
    record: frameOf(record),
    ...(workspaceId ? { workspaceId } : {}),
    ...(session ? { session } : {}),
    ...(job ? { job } : {}),
    ...(run ? { run } : {}),
    ...(attempt ? { attempt } : {}),
    ...(invocation ? { invocation } : {}),
    ...(approval ? { approval } : {}),
    artifacts,
  } as unknown as JsonValue;
}

/** Attempt-vs-attempt comparison windows for one job, bounded per attempt. */
export function compareAttempts(store: Store, actor: ActorContext, jobId: string, attemptIds: readonly string[], rawLimit?: number): JsonValue {
  const limit = Math.min(Math.max(Math.floor(rawLimit ?? 200) || 200, 1), COMPARE_ROWS);
  if (attemptIds.length === 0 || attemptIds.length > COMPARE_ATTEMPTS) {
    throw new BrainDomainError("INVALID_ARGUMENT", `compare takes 1..${COMPARE_ATTEMPTS} attempt ids`);
  }
  const job = store.control.prepare("SELECT id, workspace_id, organization_id FROM jobs WHERE id=? AND organization_id=?").get(jobId, actor.organizationId) as Record<string, unknown> | undefined;
  if (!job) throw new BrainDomainError("NOT_FOUND", "job not found");
  const workspaceId = String(job["workspace_id"]);
  requireWorkspaceRead(store, actor, workspaceId);
  const attempts = attemptIds.map((attemptId) => {
    const row = store.control.prepare("SELECT id, job_id, state, attempt_no FROM job_attempts WHERE id=?").get(attemptId) as Record<string, unknown> | undefined;
    if (!row || String(row["job_id"]) !== jobId) throw new BrainDomainError("NOT_FOUND", `attempt ${attemptId} does not belong to job ${jobId}`);
    const items = readBetween(store, actor, { attemptId }, limit);
    return { attemptId, state: String(row["state"]), number: Number(row["attempt_no"]), items } as unknown as JsonValue;
  });
  return { jobId, workspaceId, attempts } as unknown as JsonValue;
}

export { rowToView };
