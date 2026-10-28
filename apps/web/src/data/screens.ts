import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { GovernorError } from "./client";
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
  load: (scope: { organizationId: string; workspaceId: string; generation: number }, signal: AbortSignal) => Promise<Loaded<T>>;
  /** Empty is meaningful here, not an error; screens render their own explanation. */
  isEmpty?: (data: T) => boolean;
  /** Poll while the region should stay fresh; 0 disables live refresh. */
  refreshMs?: number;
}): {
  state: Accessor<ScreenState<T>>;
  refresh: (options?: { force?: boolean }) => Promise<void>;
} {
  const [state, setState] = createSignal<ScreenState<T>>({ status: "loading", clearedProtected: false, canMutate: false });
  let generation = 0;
  let controller: AbortController | undefined;
  let lastGood: { value: T; asOf: string } | undefined;
  let isOffline = false;

  async function load(force = false): Promise<void> {
    const scope = input.scope();
    // Without a scope there is nothing authorized to read yet.
    if (!scope.organizationId || scope.generation === 0) { setState({ status: "loading", clearedProtected: false, canMutate: false }); return; }
    controller?.abort();
    controller = new AbortController();
    const current = ++generation;
    const previous = lastGood;
    setState((s) => ({
      status: previous && !force ? "stale" : "loading",
      data: previous?.value,
      asOf: previous?.asOf,
      error: s.error,
      clearedProtected: false,
      canMutate: false,
    }));
    try {
      const loaded = await input.load(scope, controller.signal);
      if (current !== generation) return; // superseded by a newer scope/read
      lastGood = { value: loaded.snapshot, asOf: loaded.asOf };
      const empty = input.isEmpty ? input.isEmpty(loaded.snapshot) : false;
      setState({
        status: empty ? "empty-authorized" : "ready",
        data: loaded.snapshot,
        asOf: loaded.asOf,
        error: undefined,
        clearedProtected: false,
        canMutate: true,
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
  // and re-reads; the first run also performs the initial load.
  let lastScope = "";
  createEffectOn(input.scope, () => {
    const next = JSON.stringify(input.scope());
    if (next === lastScope) return;
    lastScope = next;
    controller?.abort();
    lastGood = undefined;
    setState({ status: "loading", clearedProtected: false, canMutate: false });
    void load();
  });

  return { state, refresh: (options) => load(options?.force ?? false) };
}

function createEffectOn<T>(source: Accessor<T>, fn: () => void): void {
  createEffect(() => { source(); fn(); });
}

/**
 * A bounded, durable event replay (document 21 session oracle).
 *
 * SSE is Brain's replay path, not a library's realtime client: the stream
 * carries coalesced authoritative events, a reset frame forces a snapshot
 * re-read, and the mounted store is capped so a 10,000-event session cannot
 * grow the DOM without bound.
 */
export interface StreamEvent { readonly id: string; readonly type: string; readonly aggregateId?: string; readonly at: string; }

export function createEventStream(input: {
  /** Re-authorized on every (re)connect; a revoked session loses the stream. */
  enabled: Accessor<boolean>;
  after?: number;
}): {
  events: Accessor<StreamEvent[]>;
  connected: Accessor<boolean>;
  resetRequired: Accessor<boolean>;
  /** Sequence number of the newest authoritative event seen. */
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

  function connect() {
    if (!input.enabled() || typeof EventSource === "undefined") return;
    source?.close();
    const after = lastSequence();
    source = new EventSource(`/v1/events?live=1${after ? `&after=${after}` : ""}`, { withCredentials: true });
    source.onopen = () => setConnected(true);
    const ingest = (event: MessageEvent<string>) => {
      let parsed: { cursor?: number; type?: string; eventId?: string; aggregateId?: string; createdAt?: string };
      try { parsed = JSON.parse(event.data) as typeof parsed; } catch { return; }
      const cursor = Number(parsed.cursor ?? 0);
      if (cursor <= lastSequence()) return; // duplicate wake/duplicate replay
      setLastSequence(cursor);
      buffer.push({ id: parsed.eventId ?? String(cursor), type: String(parsed.type ?? ""), aggregateId: parsed.aggregateId, at: parsed.createdAt ?? new Date().toISOString() });
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
      if (input.enabled()) setTimeout(connect, 2000); // durable reconnect
    };
  }

  const stop = () => { source?.close(); source = undefined; setConnected(false); if (coalesce) clearTimeout(coalesce); };
  createEffectOn(input.enabled, () => { if (input.enabled()) connect(); else stop(); });
  onCleanup(stop);

  return {
    events, connected, resetRequired, lastSequence,
    newSince: (since) => events().filter((e) => Number(e.id) > since).length,
  };
}
