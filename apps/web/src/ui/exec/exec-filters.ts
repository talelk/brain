import { STREAM_EMITTERS, STREAM_SEVERITIES } from "../../data/exec-logs";
import type { StreamEmitter, StreamSeverity } from "../../data/exec-logs";

/**
 * Persistent execution filters carried in URLs (plan §3, P0 cross-navigation).
 * Every log URL is workspace-scoped and deep links keep their filters, so the
 * codec below is the one encoder for Logs, session/rail selection, artifact
 * diff state and correlation jumps.
 */

/** Narrowing guards so a hand-typed URL cannot inject unknown filter values. */
const isSeverity = (value: string): value is StreamSeverity => (STREAM_SEVERITIES as readonly string[]).includes(value);
const isEmitter = (value: string): value is StreamEmitter => (STREAM_EMITTERS as readonly string[]).includes(value);

/** The execution filters a URL carries. Missing arrays mean "no filter set". */
export interface ExecLogFilters {
  session?: string;
  job?: string;
  run?: string;
  attempt?: string;
  severity: readonly StreamSeverity[];
  emitter: readonly StreamEmitter[];
  /** Free-text search (server-side FTS on Logs). */
  q?: string;
  /** Deep-linked record: select and scroll to this stream_seq. */
  entry?: number;
}

/** Shared read-only "no filters" value. */
export const EMPTY_EXEC_FILTERS: ExecLogFilters = Object.freeze({
  severity: Object.freeze([]),
  emitter: Object.freeze([]),
});

type SearchParamsLike = Record<string, string | string[] | undefined>;

const firstOf = (value: string | string[] | undefined): string | undefined =>
  (Array.isArray(value) ? value[0] : value) || undefined;

export function parseCsvParam(value: string | string[] | undefined): string[] {
  const raw = firstOf(value);
  return raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

/** Read execution filters from router search params; unknown values drop out. */
export function readExecFilters(params: SearchParamsLike): ExecLogFilters {
  const q = firstOf(params.q);
  const entryRaw = firstOf(params.entry);
  const entry = entryRaw !== undefined && Number.isFinite(Number(entryRaw)) && Number(entryRaw) > 0 ? Math.floor(Number(entryRaw)) : undefined;
  return {
    ...{ severity: parseCsvParam(params.severity).filter(isSeverity) },
    ...{ emitter: parseCsvParam(params.emitter).filter(isEmitter) },
    ...(firstOf(params.session) ? { session: firstOf(params.session) } : {}),
    ...(firstOf(params.job) ? { job: firstOf(params.job) } : {}),
    ...(firstOf(params.run) ? { run: firstOf(params.run) } : {}),
    ...(firstOf(params.attempt) ? { attempt: firstOf(params.attempt) } : {}),
    ...(q ? { q } : {}),
    ...(entry !== undefined ? { entry } : {}),
  };
}

/**
 * Encode filters as search params. Cleared axes are emitted as empty strings,
 * not omitted: setSearchParams merges onto the current URL, so a missing key
 * would leave a stale axis in place instead of clearing it. URL builders that
 * render these entries skip empty strings, so produced hrefs are unchanged.
 */
export function writeExecFilters(filters: ExecLogFilters): Record<string, string | undefined> {
  return {
    session: filters.session ?? "",
    job: filters.job ?? "",
    run: filters.run ?? "",
    attempt: filters.attempt ?? "",
    severity: filters.severity.length > 0 ? filters.severity.join(",") : "",
    emitter: filters.emitter.length > 0 ? filters.emitter.join(",") : "",
    q: filters.q ?? "",
    entry: filters.entry !== undefined ? String(filters.entry) : "",
  };
}

function withParams(path: string, params: Record<string, string | undefined> | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) search.set(key, value);
  }
  return `${path}${search.size > 0 ? `?${search.toString()}` : ""}`;
}

/** The workspace-scoped Log Explorer URL with the given filters. */
export function execLogsUrl(workspaceId: string, filters: ExecLogFilters = EMPTY_EXEC_FILTERS): string {
  return withParams(`/w/${workspaceId}/logs`, writeExecFilters(filters));
}

/** The Live console URL with an optional selected session (rail deep link). */
export function execLiveUrl(workspaceId: string, sessionId?: string): string {
  return withParams(`/w/${workspaceId}/live`, sessionId ? { session: sessionId } : undefined);
}

/** The Output Browser URL scoped to a producer or work item. */
export function execOutputsUrl(workspaceId: string, scope: { jobId?: string; runId?: string; workItemId?: string } = {}): string {
  return withParams(`/w/${workspaceId}/outputs`, { ...(scope.jobId ? { job: scope.jobId } : {}), ...(scope.runId ? { run: scope.runId } : {}), ...(scope.workItemId ? { workItem: scope.workItemId } : {}) });
}

/** The workspace-free output URL of an artifact; left/right open the comparison of two versions. */
export function execArtifactUrl(artifactId: string, diff?: { leftId: string; rightId: string }): string {
  return diff ? withParams(`/outputs/${artifactId}/compare`, { left: diff.leftId, right: diff.rightId }) : `/outputs/${artifactId}`;
}
