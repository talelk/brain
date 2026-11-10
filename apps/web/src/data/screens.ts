import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import { GovernorError } from "./client";
import { shareStructure } from "./share";
import type { Loaded } from "./governor";

/**
 * The shared screen data contract from document 21.
 *
 * Every region reports one explicit status; nothing is inferred from an empty
 * array. Server failure keeps the last authorized snapshot and labels it stale,
 * but effect actions require fresh revalidation (enforced by `canMutate`).
 */
export type ScreenStatus =
  | "loading"
  | "empty-authorized"
  | "ready"
  | "no-access"
  | "stale"
  | "partial-failure"
  | "retry"
  | "offline";

export interface ScreenState<T> {
  readonly status: ScreenStatus;
  readonly data?: T;
  /** Server clock of the newest authorized read; authority for expiry math. */
  readonly asOf?: string;
  readonly error?: string;
  /** A denied read clears protected content rather than showing stale rows. */
  readonly clearedProtected: boolean;
  /** True when a mutation would need a fresh authorized read first. */
  readonly canMutate: boolean;
}

/**
 * A scoped, abortable read model.
 *
 * Cache identity includes organization, workspace and the authorization
 * generation, so a scope switch or a revoked session cannot serve a cached row:
 * generation changes abort in-flight requests and drop the cached body.
 */
export function createScopedRead<T>(input: {
  /** Re-read when any of these change; also the abort/clear trigger. */
  scope: Accessor<{ organizationId: string; workspaceId: string; generation: number }>;
  /**
   * Optional detail key (artifact/session/event id) re-read inside the scope.
   * A resource switch aborts and reloads but keeps the previous body visible
   * instead of clearing it — kept-mounted panes would flash empty otherwise.
   */
  resource?: Accessor<string | undefined>;
  load: (scope: { organizationId: string; workspaceId: string; generation: number }, signal: AbortSignal, resource?: string) => Promise<Loaded<T>>;
  /** Empty is meaningful here, not an error; screens render their own explanation. */
  isEmpty?: (data: T) => boolean;
  /** Poll while the region should stay fresh; 0 disables live refresh. */
  refreshMs?: number;
}): {
  state: Accessor<ScreenState<T>>;
  refresh: (options?: { force?: boolean }) => Promise<void>;
} {
  // A poll that finds the same thing must not notify: only a changed status, body, error or
  // permission re-renders readers. The server clock still advances in place, so expiry math reads it fresh.
  const [state, setState] = createSignal<ScreenState<T>>({ status: "loading", clearedProtected: false, canMutate: false }, {
    equals: (before, after) => {
      const same = before.status === after.status && before.data === after.data && before.error === after.error
        && before.clearedProtected === after.clearedProtected && before.canMutate === after.canMutate;
      if (same) (before as { asOf?: string }).asOf = after.asOf;
      return same;
    },
  });
  let generation = 0;
  let controller: AbortController | undefined;
  let lastGood: { value: T; asOf: string } | undefined;
  let isOffline = false;
  let lastScope = "";

  async function load(force = false): Promise<void> {
    const scope = input.scope();
    const resource = input.resource?.();
    // Without a scope there is nothing authorized to read yet.
    if (!scope.organizationId || scope.generation === 0) { setState({ status: "loading", clearedProtected: false, canMutate: false }); return; }
    controller?.abort();
    controller = new AbortController();
    const current = ++generation;
    const previous = lastGood;
    if (!previous || force) setState({
      status: "loading", data: previous?.value, asOf: previous?.asOf,
      clearedProtected: false, canMutate: false,
    });
    try {
      const loaded = await input.load(scope, controller.signal, resource);
      if (current !== generation) return; // superseded by a newer scope/read
      const snapshot = shareStructure(previous?.value, loaded.snapshot);
      lastGood = { value: snapshot, asOf: loaded.asOf };
      const empty = input.isEmpty ? input.isEmpty(snapshot) : false;
      setState({
        status: loaded.partialFailures?.length ? "partial-failure" : empty ? "empty-authorized" : "ready",
        data: snapshot,
        asOf: loaded.asOf,
        error: loaded.partialFailures?.join("; "),
        clearedProtected: false,
        canMutate: !loaded.partialFailures?.length,
      });
    } catch (e) {
      if (controller?.signal.aborted || current !== generation) return;
      if (e instanceof GovernorError && (e.status === 401 || e.status === 403)) {
        // Clearing is the point: a revoked principal must not keep private text.
        lastGood = undefined;
        setState({ status: "no-access", clearedProtected: true, canMutate: false, error: e.message });
        return;
      }
      if (e instanceof GovernorError && e.status === 404) {
        // An authorized read that found nothing: the record does not exist (or
        // belongs elsewhere). That is a "not found" empty state, not a denial.
        lastGood = undefined;
        setState({ status: "empty-authorized", clearedProtected: false, canMutate: false, error: e.message });
        return;
      }
      const offline = e instanceof TypeError; // fetch rejection = no network
      if (offline) isOffline = true;
      setState(() => ({
        status: offline ? "offline" : lastGood ? "stale" : "retry",
        data: lastGood?.value,
        asOf: lastGood?.asOf,
        error: e instanceof Error ? e.message : "Governor is unavailable.",
        clearedProtected: false,
        canMutate: false,
      }));
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (input.refreshMs) {
    timer = setInterval(() => { if (typeof navigator === "undefined" || navigator.onLine !== false) void load(); }, input.refreshMs);
  }
  const onOffline = () => { isOffline = true; };
  const onOnline = () => { if (isOffline) { isOffline = false; void load(); } };
  if (typeof window !== "undefined") {
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    onCleanup(() => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      if (timer) clearInterval(timer);
      controller?.abort();
    });
  }

  // A scope change (workspace, organization or revoked auth) clears immediately
  // and re-reads; the first run also performs the initial load. A resource
  // change inside the same scope re-reads but keeps the previous body shown.
  createEffectOn(() => `${JSON.stringify(input.scope())}\u0000${input.resource?.() ?? ""}`, () => {
    const scope = JSON.stringify(input.scope());
    const resourceChanged = lastScope !== "" && scope === lastScope.split("\u0000")[0];
    lastScope = `${scope}\u0000${input.resource?.() ?? ""}`;
    controller?.abort();
    if (!resourceChanged) lastGood = undefined;
    setState((previous) => ({
      status: "loading",
      data: resourceChanged ? previous.data : undefined,
      asOf: resourceChanged ? previous.asOf : undefined,
      clearedProtected: false,
      canMutate: false,
    }));
    void load();
  });

  return { state, refresh: (options) => load(options?.force ?? false) };
}

function createEffectOn<T>(source: Accessor<T>, fn: () => void): void {
  createEffect(() => { source(); fn(); });
}

/**
 * The unified execution stream's SSE frame (GET /v1/events). The cursor is
 * `stream_seq` — the one global cursor — and every record carries its
 * projection-time severity/emitter/source classification.
 */
export type ExecSeverity = "debug" | "info" | "warning" | "error" | "critical";
export type ExecEmitter = "agent" | "tool" | "runner" | "governor" | "evaluator" | "connector" | "system";
export type ExecSource = "control" | "workspace" | "attempt";

export interface StreamEvent {
  /** Durable event id; the SSE `id:` line carries the stream_seq cursor. */
  readonly id: string;
  readonly streamSeq?: number;
  readonly eventId?: string;
  readonly type: string;
  readonly severity?: ExecSeverity | null;
  readonly emitter?: ExecEmitter;
  readonly source?: ExecSource;
  readonly aggregateId?: string;
  readonly workspaceId?: string;
  readonly at: string;
  readonly correlation?: Record<string, string>;
  /** Bounded summary projected by the server (never the raw high-volume payload). */
  readonly summary?: unknown;
  readonly payload?: unknown;
}

/** Server-authoritative SSE filters, scoped in SQL before any page limit. */
export interface StreamEventFilters {
  workspace?: string;
  session?: string;
  job?: string;
  run?: string;
  severity?: readonly string[];
  emitter?: readonly string[];
}

export function createEventStream(input: {
  /** Re-authorized on every (re)connect; a revoked session loses the stream. */
  enabled: Accessor<boolean>;
  /** stream_seq to replay from (session.get streamCursor — never an attempt sequence). */
  after?: number;
  /** Re-read on every (re)connect; a change reconnects from the same cursor. */
  filters?: () => StreamEventFilters | undefined;
}): {
  events: Accessor<StreamEvent[]>;
  connected: Accessor<boolean>;
  resetRequired: Accessor<boolean>;
  /** Newest stream_seq seen. */
  lastSequence: Accessor<number>;
  newSince: (since: number) => number;
} {
  const [events, setEvents] = createSignal<StreamEvent[]>([]);
  const [connected, setConnected] = createSignal(false);
  const [resetRequired, setResetRequired] = createSignal(false);
  const [lastSequence, setLastSequence] = createSignal(input.after ?? 0);
  const maxEvents = 500;
  let source: EventSource | undefined;
  let coalesce: ReturnType<typeof setTimeout> | undefined;
  let buffer: StreamEvent[] = [];
  let filterSignature = "";

  function url(): string {
    const filters = input.filters?.();
    const params = new URLSearchParams();
    if (lastSequence() > 0) params.set("after", String(lastSequence()));
    if (filters?.workspace) params.set("workspace", filters.workspace);
    if (filters?.session) params.set("session", filters.session);
    if (filters?.job) params.set("job", filters.job);
    if (filters?.run) params.set("run", filters.run);
    if (filters?.severity?.length) params.set("severity", filters.severity.join(","));
    if (filters?.emitter?.length) params.set("emitter", filters.emitter.join(","));
    return `/v1/events?live=1${params.size > 0 ? `&${params.toString()}` : ""}`;
  }

  function connect() {
    if (!input.enabled() || typeof EventSource === "undefined") return;
    source?.close();
    filterSignature = JSON.stringify(input.filters?.() ?? null);
    source = new EventSource(url(), { withCredentials: true });
    source.onopen = () => setConnected(true);
    const ingest = (event: MessageEvent<string>) => {
      let parsed: { streamSeq?: number; cursor?: number; eventId?: string; type?: string; severity?: ExecSeverity | null; emitter?: ExecEmitter; source?: ExecSource; aggregateId?: string; workspaceId?: string; at?: string; correlation?: Record<string, string>; summary?: unknown };
      try { parsed = JSON.parse(event.data) as typeof parsed; } catch { return; }
      const cursor = Number(parsed.streamSeq ?? parsed.cursor ?? 0);
      if (cursor <= lastSequence()) return; // duplicate wake/duplicate replay
      setLastSequence(cursor);
      buffer.push({
        id: String(cursor),
        streamSeq: cursor,
        eventId: parsed.eventId,
        type: String(parsed.type ?? ""),
        severity: parsed.severity ?? null,
        emitter: parsed.emitter,
        source: parsed.source,
        aggregateId: parsed.aggregateId,
        workspaceId: parsed.workspaceId,
        at: parsed.at ?? new Date().toISOString(),
        correlation: parsed.correlation,
        summary: parsed.summary,
        payload: parsed.summary,
      });
      // Coalesce bursts into one state update, so a 10k-event stream is bounded.
      if (!coalesce) coalesce = setTimeout(() => {
        const merged = [...buffer]; buffer = []; coalesce = undefined;
        setEvents((prev) => [...prev, ...merged].slice(-maxEvents));
      }, 50);
    };
    source.addEventListener("message", ingest as EventListener);
    source.onmessage = ingest;
    // The server ends the stream and tells the client to resync from a snapshot.
    source.addEventListener("reset", () => { setResetRequired(true); setConnected(false); });
    source.onerror = () => {
      setConnected(false);
      source?.close();
      if (input.enabled()) setTimeout(() => untrack(connect), 2000); // durable reconnect
    };
  }

  const stop = () => { source?.close(); source = undefined; setConnected(false); if (coalesce) clearTimeout(coalesce); };
  // connect() reads reactive state (lastSequence, filter axes) to build its URL;
  // those reads are consequences of connecting, not triggers. Only the tracked
  // source may re-run an effect, or every delivered frame would tear down and
  // reopen the connection.
  createEffectOn(input.enabled, () => { if (input.enabled()) untrack(connect); else untrack(stop); });
  // A filter change reconnects from the current cursor; the enabled effect owns
  // the first connection, so skip while nothing is open yet.
  createEffectOn(() => JSON.stringify(input.filters?.() ?? null), () => {
    if (!source) return;
    if (JSON.stringify(input.filters?.() ?? null) === filterSignature) return;
    untrack(connect);
  });
  onCleanup(stop);

  return {
    events, connected, resetRequired, lastSequence,
    newSince: (since) => events().filter((e) => Number(e.id) > since).length,
  };
}
