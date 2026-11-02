import type { ActorContext, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { projectStream, sweepStream } from "./projector";
import {
  compareAttempts, contextBundle, headCursor, tail, type StreamFilters, type StreamRecordView,
} from "./query";
import { searchStream, type StreamSearchResult } from "./search";
import { exportSegment, type StreamExport } from "./export";


/**
 * Unified Execution Stream read model. Projected over the three authoritative
 * logs (control.events, workspace.events, attempt_events) — no new execution
 * authority. Cross-module use goes only through this index.
 */

export interface StreamTailResult {
  items: StreamRecordView[];
  head: number;
  next: number | "";
}

export interface StreamService {
  /** Incremental, watermark-guarded projection; safe before every read. */
  project(): { projected: number };
  /** Ascending bounded page with SQL-side authorization scoping. */
  read(actor: ActorContext, filters: StreamFilters, limit?: number): StreamTailResult;
  /** Descending FTS page over bounded summaries with a total estimate. */
  search(actor: ActorContext, params: StreamFilters & { search: string }, limit?: number): StreamSearchResult;
  /** One record plus its full correlation bundle (P0 jumps). */
  context(actor: ActorContext, eventId: string): JsonValue;
  /** Bounded per-attempt windows for comparing attempts of one job. */
  compare(actor: ActorContext, jobId: string, attemptIds: readonly string[], limit?: number): JsonValue;
  /** The global cursor (MAX(stream_seq)) — the sole SSE cursor space. */
  head(): number;
  /** Latest stream_seq correlated to one session (session.get streamCursor). */
  headForSession(sessionId: string): number;
  /** Retention sweep; keeps anchor records and repairs FTS drift. */
  sweep(): { deleted: number; repaired: boolean };
  /** Bounded sanitized NDJSON segment with source and time information. */
  exportSegment(actor: ActorContext, filters: StreamFilters, limit?: number): StreamExport;
}

export function createStreamService(s: Store): StreamService {
  let lastSweepAtMs = 0;
  return {
    project: () => projectStream(s),
    read: (actor, filters, limit) => tail(s, actor, filters, limit),
    search: (actor, params, limit) => searchStream(s, actor, params, limit),
    context: (actor, eventId) => contextBundle(s, actor, eventId),
    compare: (actor, jobId, attemptIds, limit) => compareAttempts(s, actor, jobId, attemptIds, limit),
    head: () => headCursor(s),
    headForSession: (sessionId) => Number((s.control.prepare("SELECT COALESCE(MAX(stream_seq),0) AS m FROM execution_stream WHERE session_id=?").get(sessionId) as { m: number }).m),
    sweep: () => {
      // Maintenance-pass cadence: at most once per hour per process.
      if (Date.now() - lastSweepAtMs < 3600_000) return { deleted: 0, repaired: false };
      lastSweepAtMs = Date.now();
      return sweepStream(s);
    },
    exportSegment: (actor, filters, limit) => exportSegment(s, actor, filters, limit),
  };
}

export { emitterOf, severityOf } from "./classify";
export { frameOf, type StreamFilters, type StreamRecordView } from "./query";
export { sweepStream } from "./projector";
