import type { QueryRequest, QueryResponse, StreamRecord, StreamEmitter, StreamSeverity } from "@brain/contracts";
import { fetchView } from "./governor";

/**
 * The Log Explorer's typed reads over the Unified Execution Stream (T61).
 * Wire shapes are the generated contracts (StreamRecord, StreamTailPage,
 * StreamSearchPage, StreamContextBundle, StreamCompareResult); the server
 * implements them in apps/governor/src/modules/stream/. One global stream_seq
 * cursor, severity and emitter classification done at projection,
 * authorization scoped in SQL before any page limit. High-volume payloads stay
 * in CAS/attempt spools — records carry pointers, never the bodies.
 */

export type { StreamRecord, StreamEmitter, StreamSeverity };
export type StreamSource = Extract<QueryResponse, { queryType: "stream.tail" }>["snapshot"]["items"][number]["source"];
export type StreamCorrelation = NonNullable<StreamRecord["correlation"]>;

export const STREAM_SEVERITIES: readonly StreamSeverity[] = ["debug", "info", "warning", "error", "critical"];
export const STREAM_EMITTERS: readonly StreamEmitter[] = ["agent", "tool", "runner", "governor", "evaluator", "connector", "system"];

/** Correlation + filter axes shared by tail, search and the live SSE route. */
export interface StreamFilterParams {
  workspaceId?: string;
  sessionId?: string;
  jobId?: string;
  runId?: string;
  attemptId?: string;
  emitters?: readonly StreamEmitter[];
  severities?: readonly StreamSeverity[];
  /** stream_seq lower bound (exclusive). */
  after?: number;
}

export type StreamSearchPage = Extract<QueryResponse, { queryType: "stream.search" }>["snapshot"];
export type StreamContextBundle = Extract<QueryResponse, { queryType: "stream.context" }>["snapshot"];
export type StreamCompareResult = Extract<QueryResponse, { queryType: "stream.compare" }>["snapshot"];

type TailRequest = Extract<QueryRequest, { queryType: "stream.tail" }>;
type SearchRequest = Extract<QueryRequest, { queryType: "stream.search" }>;

/** `stream.tail` — ascending bounded page. Server clamp: limit ≤ 200. */
export const streamTailQuery = (params: StreamFilterParams & { limit?: number }, signal?: AbortSignal) =>
  fetchView({ queryType: "stream.tail", ...params } satisfies TailRequest, signal);

/**
 * `stream.search` — descending FTS page over bounded summaries, limit ≤ 50.
 * `before` (the previous page's nextCursor — its oldest stream_seq) pages to
 * the next, older matches.
 */
export const streamSearchQuery = (params: StreamFilterParams & { search: string; limit?: number; before?: number }, signal?: AbortSignal) =>
  fetchView({ queryType: "stream.search", ...params } satisfies SearchRequest, signal);

/** `stream.context` — one record plus its correlation bundle (P0 jumps). */
export const streamContextQuery = (eventId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "stream.context", eventId }, signal);

/** `stream.compare` — bounded per-attempt windows for one job (≤ 4 × 500). */
export const streamCompareQuery = (params: { jobId: string; attemptIds: readonly string[]; limit?: number }, signal?: AbortSignal) =>
  fetchView({ queryType: "stream.compare", jobId: params.jobId, attemptIds: [...params.attemptIds], limit: params.limit }, signal);

/**
 * Bounded sanitized NDJSON segment export (GET /v1/stream/export) carrying the
 * caller's current filters, so the download matches exactly what is on screen.
 */
export function streamExportUrl(params: StreamFilterParams & { limit?: number }): string {
  const search = new URLSearchParams();
  if (params.workspaceId) search.set("workspaceId", params.workspaceId);
  if (params.sessionId) search.set("sessionId", params.sessionId);
  if (params.jobId) search.set("jobId", params.jobId);
  if (params.runId) search.set("runId", params.runId);
  if (params.attemptId) search.set("attemptId", params.attemptId);
  if (params.emitters?.length) search.set("emitter", params.emitters.join(","));
  if (params.severities?.length) search.set("severity", params.severities.join(","));
  if (params.after !== undefined) search.set("after", String(Math.floor(params.after)));
  if (params.limit !== undefined) search.set("limit", String(Math.floor(params.limit)));
  return `/v1/stream/export?${search.toString()}`;
}
