import type { Db } from "../../infrastructure/persistence/open";
import type { Store } from "../../application/store";
import { emitterOf, severityOf, type StreamSource } from "./classify";

/**
 * Incremental projection of the unified Execution Stream. Three source logs
 * are tailed with per-source watermarks; every insert plus its watermark
 * advance happens in one control-DB transaction so a crash re-projects from
 * the watermarks and the event_id UNIQUE constraint makes replays no-ops.
 * better-sqlite3 is synchronous, so a single in-flight guard is the call stack
 * itself — project() can never interleave with itself in one process.
 */

const PAGE = 500;
const MAX_ROWS_PER_ORG_PASS = 10_000;
const MAX_ATTEMPTS_PER_PASS = 50;
const SUMMARY_LIMIT = 4096;
const SUMMARY_HEAD = 3_200;

interface SourceEventRow {
  event_id: string;
  organization_id: string;
  workspace_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_seq: number;
  event_type: string;
  payload_json: string;
  created_at_ms: number;
}

interface Correlation {
  runId?: string | undefined; jobId?: string | undefined; attemptId?: string | undefined; sessionId?: string | undefined;
  workItemId?: string | undefined; invocationId?: string | undefined; proposalId?: string | undefined;
}

interface StreamInsert {
  eventId: string;
  organizationId: string;
  workspaceId: string | null;
  source: StreamSource;
  emitter: string;
  aggregateType: string;
  aggregateId: string;
  aggregateSeq: number;
  eventType: string;
  severity: string | null;
  occurredAtMs: number;
  tsApproximate: boolean;
  correlation: Correlation;
  summaryJson: string;
  payloadRefJson: string;
  ftsText: string;
}

function watermark(control: Db, source: string, key: string): number {
  const row = control.prepare("SELECT cursor FROM stream_watermarks WHERE source=? AND key=?").get(source, key) as { cursor: number } | undefined;
  return row?.cursor ?? 0;
}

function advance(control: Db, source: string, key: string, cursor: number): void {
  control.prepare(`INSERT INTO stream_watermarks(source,key,cursor) VALUES (?,?,?)
    ON CONFLICT(source,key) DO UPDATE SET cursor=MAX(stream_watermarks.cursor,excluded.cursor)`).run(source, key, cursor);
}

function boundedSummary(value: unknown): string {
  let text: string;
  try { text = JSON.stringify(value) ?? "null"; } catch { text = "null"; }
  if (text.length <= SUMMARY_LIMIT) return text;
  return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(text), head: text.slice(0, SUMMARY_HEAD) });
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function casDigestIn(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  for (const key of ["artifact", "output", "diff", "checkpoint", "receipt", "body", "content"]) {
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const digest = (value as Record<string, unknown>)["digest"];
      if (typeof digest === "string" && DIGEST.test(digest)) return digest;
    }
  }
  const direct = payload["digest"];
  if (typeof direct === "string" && DIGEST.test(direct)) return direct;
  return undefined;
}

function payloadRef(source: StreamSource, payload: Record<string, unknown> | null, attemptId?: string, seq?: number): string {
  if (source === "attempt" && attemptId && seq !== undefined) {
    return JSON.stringify({ kind: "attempt", attemptId, seq });
  }
  const digest = casDigestIn(payload);
  if (digest) return JSON.stringify({ kind: "cas", digest });
  return JSON.stringify({ kind: "inline" });
}

/** Correlation cache shared by one projection pass. */
class Correlator {
  private readonly jobs = new Map<string, { runId?: string | undefined; workspaceId?: string | undefined }>();
  private readonly attemptSessions = new Map<string, string | undefined>();
  private readonly attemptJobs = new Map<string, string | undefined>();
  private readonly linkItems = new Map<string, string | undefined>();

  constructor(private readonly s: Store) {}

  runForJob(jobId: string): string | undefined {
    const hit = this.jobs.get(jobId);
    if (hit) return hit.runId;
    const row = this.s.control.prepare("SELECT workflow_run_id, workspace_id FROM jobs WHERE id=?").get(jobId) as { workflow_run_id: string; workspace_id: string } | undefined;
    const value = { runId: row?.workflow_run_id as string | undefined, workspaceId: row?.workspace_id as string | undefined };
    this.jobs.set(jobId, value);
    return value.runId;
  }

  sessionForAttempt(attemptId: string): string | undefined {
    if (this.attemptSessions.has(attemptId)) return this.attemptSessions.get(attemptId);
    const row = this.s.control.prepare("SELECT j.workspace_id AS ws FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?").get(attemptId) as { ws: string } | undefined;
    let sessionId: string | undefined;
    if (row) {
      const session = this.s.workspaceDb(row.ws, this.orgForWorkspace(row.ws)).prepare("SELECT id FROM sessions WHERE attempt_id=? LIMIT 1").get(attemptId) as { id: string } | undefined;
      sessionId = session?.id;
    }
    this.attemptSessions.set(attemptId, sessionId);
    return sessionId;
  }

  jobForAttempt(attemptId: string): string | undefined {
    if (this.attemptJobs.has(attemptId)) return this.attemptJobs.get(attemptId);
    const row = this.s.control.prepare("SELECT job_id FROM job_attempts WHERE id=?").get(attemptId) as { job_id: string } | undefined;
    const jobId = row?.job_id;
    this.attemptJobs.set(attemptId, jobId);
    return jobId;
  }

  workItemFor(target: { workspaceId?: string | null; runId?: string | undefined; sessionId?: string | undefined }): string | undefined {
    const key = `${target.workspaceId ?? ""}|${target.runId ?? ""}|${target.sessionId ?? ""}`;
    if (this.linkItems.has(key)) return this.linkItems.get(key);
    let workItemId: string | undefined;
    if (target.workspaceId) {
      const db = this.s.workspaceDb(target.workspaceId, this.orgForWorkspace(target.workspaceId));
      const row = target.runId
        ? db.prepare("SELECT work_item_id FROM execution_links WHERE run_id=? AND work_item_id IS NOT NULL LIMIT 1").get(target.runId) as { work_item_id: string } | undefined
        : undefined;
      const viaSession = row ? undefined
        : target.sessionId ? db.prepare("SELECT work_item_id FROM sessions WHERE id=? AND work_item_id IS NOT NULL").get(target.sessionId) as { work_item_id: string } | undefined : undefined;
      workItemId = row?.work_item_id ?? viaSession?.work_item_id;
    }
    this.linkItems.set(key, workItemId);
    return workItemId;
  }

  private orgForWorkspace(workspaceId: string): string {
    const row = this.s.control.prepare("SELECT organization_id FROM workspaces WHERE id=?").get(workspaceId) as { organization_id: string } | undefined;
    return row?.organization_id ?? "";
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function payloadOf(row: { payload_json: string }): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function correlateEvent(c: Correlator, row: SourceEventRow): Correlation {
  const payload = payloadOf(row);
  const out: Correlation = {};
  out.sessionId = str(payload?.["sessionId"]) ?? (row.aggregate_type === "session" ? row.aggregate_id : undefined);
  out.jobId = str(payload?.["jobId"]) ?? (row.aggregate_type === "job" ? row.aggregate_id : undefined);
  out.attemptId = str(payload?.["attemptId"]);
  out.runId = str(payload?.["runId"]);
  out.invocationId = str(payload?.["invocationId"]);
  out.proposalId = str(payload?.["proposalId"]);
  if (out.attemptId) {
    out.sessionId ??= c.sessionForAttempt(out.attemptId);
    out.jobId ??= c.jobForAttempt(out.attemptId);
  }
  if (out.jobId) out.runId ??= c.runForJob(out.jobId);
  if (row.workspace_id && !out.workItemId) {
    out.workItemId = str(payload?.["workItemId"]) ?? c.workItemFor({ workspaceId: row.workspace_id, runId: out.runId, sessionId: out.sessionId });
  }
  return out;
}

function insertRecord(control: Db, row: StreamInsert): void {
  const result = control.prepare(`INSERT OR IGNORE INTO execution_stream(
      event_id, organization_id, workspace_id, source, emitter,
      aggregate_type, aggregate_id, aggregate_seq, event_type, severity,
      occurred_at_ms, ts_approximate, run_id, job_id, attempt_id, session_id, work_item_id,
      invocation_id, proposal_id, summary_json, payload_ref_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.eventId, row.organizationId, row.workspaceId, row.source, row.emitter,
    row.aggregateType, row.aggregateId, row.aggregateSeq, row.eventType, row.severity,
    row.occurredAtMs, row.tsApproximate ? 1 : 0, row.correlation.runId ?? null, row.correlation.jobId ?? null,
    row.correlation.attemptId ?? null, row.correlation.sessionId ?? null, row.correlation.workItemId ?? null,
    row.correlation.invocationId ?? null, row.correlation.proposalId ?? null,
    row.summaryJson, row.payloadRefJson,
  );
  if (result.changes === 1) {
    control.prepare("INSERT INTO execution_stream_fts(text, stream_seq) SELECT ?, stream_seq FROM execution_stream WHERE event_id=?")
      .run(row.ftsText, row.eventId);
  }
}

function projectControlTail(s: Store, correlator: Correlator, organizationId: string): number {
  const control = s.control;
  let cursor = watermark(control, "control", organizationId);
  let projected = 0;
  for (;;) {
    const rows = control.prepare(`SELECT cursor, event_id, organization_id, workspace_id, aggregate_type, aggregate_id, aggregate_seq,
        event_type, payload_json, created_at_ms FROM events WHERE organization_id=? AND cursor>? ORDER BY cursor ASC LIMIT ?`)
      .all(organizationId, cursor, PAGE) as Array<SourceEventRow & { cursor: number }>;
    if (rows.length === 0) break;
    s.inTx(control, () => {
      for (const row of rows) {
        const payload = payloadOf(row);
        const summaryJson = boundedSummary(payload);
        insertRecord(control, {
          eventId: row.event_id,
          organizationId,
          workspaceId: row.workspace_id,
          source: "control",
          emitter: emitterOf("control", row.event_type),
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          aggregateSeq: row.aggregate_seq,
          eventType: row.event_type,
          severity: severityOf("control", row.event_type, payload),
          occurredAtMs: Number(row.created_at_ms),
          tsApproximate: false,
          correlation: correlateEvent(correlator, row),
          summaryJson,
          payloadRefJson: payloadRef("control", payload),
          ftsText: `${row.event_type} ${row.aggregate_type} ${row.aggregate_id} ${summaryJson}`,
        });
        cursor = Math.max(cursor, Number(row.cursor));
      }
      advance(control, "control", organizationId, cursor);
    });
    projected += rows.length;
    if (rows.length < PAGE || projected >= MAX_ROWS_PER_ORG_PASS) break;
  }
  return projected;
}

function projectWorkspaceTail(s: Store, correlator: Correlator, organizationId: string, workspaceId: string): number {
  const control = s.control;
  let cursor = watermark(control, "workspace", workspaceId);
  let projected = 0;
  for (;;) {
    const ws = s.workspaceDb(workspaceId, organizationId);
    const rows = ws.prepare(`SELECT cursor, event_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, created_at_ms
      FROM events WHERE cursor>? ORDER BY cursor ASC LIMIT ?`).all(cursor, PAGE) as Array<Omit<SourceEventRow, "organization_id" | "workspace_id"> & { cursor: number }>;
    if (rows.length === 0) break;
    s.inTx(control, () => {
      for (const row of rows) {
        const payload = payloadOf(row);
        const summaryJson = boundedSummary(payload);
        insertRecord(control, {
          eventId: row.event_id,
          organizationId,
          workspaceId,
          source: "workspace",
          emitter: emitterOf("workspace", row.event_type),
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          aggregateSeq: row.aggregate_seq,
          eventType: row.event_type,
          severity: severityOf("workspace", row.event_type, payload),
          occurredAtMs: Number(row.created_at_ms),
          tsApproximate: false,
          correlation: correlateEvent(correlator, { ...row, organization_id: organizationId, workspace_id: workspaceId }),
          summaryJson,
          payloadRefJson: payloadRef("workspace", payload),
          ftsText: `${row.event_type} ${row.aggregate_type} ${row.aggregate_id} ${summaryJson}`,
        });
        cursor = Math.max(cursor, Number(row.cursor));
      }
      advance(control, "workspace", workspaceId, cursor);
    });
    projected += rows.length;
    if (rows.length < PAGE || projected >= MAX_ROWS_PER_ORG_PASS) break;
  }
  return projected;
}

interface AttemptTailRow {
  attempt_id: string;
  job_id: string;
  workspace_id: string;
  organization_id: string;
  workflow_run_id: string;
  max_seq: number;
}

function projectAttemptTail(s: Store, organizationId: string): number {
  const control = s.control;
  const candidates = control.prepare(`SELECT a.id AS attempt_id, a.job_id, j.workspace_id, j.organization_id, j.workflow_run_id, m.max_seq
    FROM (SELECT attempt_id, MAX(seq) AS max_seq FROM attempt_events GROUP BY attempt_id) m
    JOIN job_attempts a ON a.id=m.attempt_id JOIN jobs j ON j.id=a.job_id
    LEFT JOIN stream_watermarks w ON w.source='attempt' AND w.key=a.id
    WHERE j.organization_id=? AND m.max_seq > COALESCE(w.cursor, 0)
    ORDER BY a.id LIMIT ?`).all(organizationId, MAX_ATTEMPTS_PER_PASS) as Array<AttemptTailRow>;
  let projected = 0;
  for (const candidate of candidates) {
    let seq = watermark(control, "attempt", candidate.attempt_id);
    for (;;) {
      const rows = control.prepare("SELECT seq, event_json FROM attempt_events WHERE attempt_id=? AND seq>? ORDER BY seq ASC LIMIT ?")
        .all(candidate.attempt_id, seq, PAGE) as Array<{ seq: number; event_json: string }>;
      if (rows.length === 0) break;
      const session = s.workspaceDb(candidate.workspace_id, organizationId).prepare("SELECT id, work_item_id FROM sessions WHERE attempt_id=? LIMIT 1")
        .get(candidate.attempt_id) as { id: string; work_item_id: string | null } | undefined;
      s.inTx(control, () => {
        for (const row of rows) {
          let wrapper: { kind?: string; payload?: unknown } | null = null;
          try { wrapper = JSON.parse(row.event_json) as { kind?: string; payload?: unknown }; } catch { wrapper = null; }
          const kind = String(wrapper?.kind ?? "engine");
          const inner = (wrapper?.payload ?? null) as Record<string, unknown> | { kind?: string; payload?: Record<string, unknown>; occurredAt?: string } | null;
          const eventType = kind === "engine"
            ? String((inner as { kind?: string } | null)?.["kind"] ?? "engine")
            : kind === "progress" ? "attempt.progress"
            : kind === "effect" ? "attempt.effect"
            : `attempt.${kind}`;
          const innerPayload = (kind === "engine" ? (inner as { payload?: Record<string, unknown> } | null)?.["payload"] : inner ?? null) as Record<string, unknown> | null;
          const occurredIso = typeof (inner as { occurredAt?: unknown } | null)?.["occurredAt"] === "string" ? String((inner as { occurredAt?: string })["occurredAt"]) : "";
          const occurredAtMs = Date.parse(occurredIso);
          const approximate = !Number.isFinite(occurredAtMs);
          const proposalId = str(innerPayload?.["proposalId"]);
          const invocationId = str(innerPayload?.["invocationId"]) ?? str((innerPayload?.["receipt"] as Record<string, unknown> | undefined)?.["invocationId"]);
          insertRecord(control, {
            eventId: `evt-attempt-${candidate.attempt_id}-${row.seq}`,
            organizationId,
            workspaceId: candidate.workspace_id,
            source: "attempt",
            emitter: emitterOf("attempt", eventType),
            aggregateType: "attempt",
            aggregateId: candidate.attempt_id,
            aggregateSeq: row.seq,
            eventType,
            severity: severityOf("attempt", eventType, innerPayload),
            occurredAtMs: approximate ? s.now() : occurredAtMs,
            tsApproximate: approximate,
            correlation: {
              runId: candidate.workflow_run_id,
              jobId: candidate.job_id,
              attemptId: candidate.attempt_id,
              sessionId: session?.id,
              workItemId: session?.work_item_id ?? undefined,
              invocationId,
              proposalId,
            },
            summaryJson: boundedSummary(innerPayload ?? wrapper),
            payloadRefJson: payloadRef("attempt", innerPayload, candidate.attempt_id, row.seq),
            ftsText: `${eventType} attempt ${candidate.attempt_id} ${boundedSummary(innerPayload ?? wrapper)}`,
          });
          seq = Math.max(seq, Number(row.seq));
        }
        advance(control, "attempt", candidate.attempt_id, seq);
      });
      projected += rows.length;
      if (rows.length < PAGE || projected >= MAX_ROWS_PER_ORG_PASS) break;
    }
  }
  return projected;
}

/**
 * Tail all three sources for every organization. Watermark-guarded and
 * idempotent; safe to call before every read, from the maintenance tick and
 * after applied commands.
 */
export function projectStream(s: Store): { projected: number } {
  const control = s.control;
  let projected = 0;
  const correlator = new Correlator(s);
  for (const org of control.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: string }>) {
    projected += projectControlTail(s, correlator, org.id);
    for (const ws of control.prepare("SELECT id FROM workspaces WHERE organization_id=? AND status='active' ORDER BY id").all(org.id) as Array<{ id: string }>) {
      projected += projectWorkspaceTail(s, correlator, org.id, ws.id);
    }
    projected += projectAttemptTail(s, org.id);
  }
  return { projected };
}

const SWEEP_PAGE = 2000;

/**
 * Retention: delete stream rows older than the window except anchor records
 * (job.*, session.started|stopped, artifact, error, approval.*). FTS rows go
 * in the same transaction; a drift repair rebuilds the FTS index from the
 * authoritative execution_stream rows.
 */
export function sweepStream(s: Store, olderThanMs = 30 * 24 * 3600_000): { deleted: number; repaired: boolean } {
  const control = s.control;
  const cutoff = s.now() - olderThanMs;
  return s.inTx(control, () => {
    let deleted = 0;
    for (;;) {
      const rows = control.prepare(`SELECT stream_seq FROM execution_stream WHERE occurred_at_ms<? AND NOT (
          event_type LIKE 'job.%' OR event_type IN ('session.started','session.stopped','artifact','error') OR event_type LIKE 'approval.%')
        ORDER BY stream_seq LIMIT ?`).all(cutoff, SWEEP_PAGE) as Array<{ stream_seq: number }>;
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.stream_seq);
      const marks = ids.map(() => "?").join(",");
      control.prepare(`DELETE FROM execution_stream_fts WHERE stream_seq IN (${marks})`).run(...ids);
      control.prepare(`DELETE FROM execution_stream WHERE stream_seq IN (${marks})`).run(...ids);
      deleted += ids.length;
      if (rows.length < SWEEP_PAGE) break;
    }
    const repaired = repairStreamFts(control);
    return { deleted, repaired };
  });
}

/** Rebuild the standalone-content FTS from execution_stream when they drift. */
export function repairStreamFts(control: Db): boolean {
  const rows = (control.prepare("SELECT COUNT(*) AS c FROM execution_stream").get() as { c: number }).c;
  const fts = (control.prepare("SELECT COUNT(*) AS c FROM execution_stream_fts").get() as { c: number }).c;
  if (rows === fts) return false;
  control.exec("DELETE FROM execution_stream_fts");
  control.exec(`INSERT INTO execution_stream_fts(text, stream_seq)
    SELECT event_type || ' ' || aggregate_type || ' ' || aggregate_id || ' ' || summary_json, stream_seq FROM execution_stream`);
  return true;
}
