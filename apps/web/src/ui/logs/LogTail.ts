import { createEffect, createRoot, createSignal, onCleanup, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import { streamExportUrl, streamTailQuery } from "../../data/exec-logs";
import { createEventStream } from "../../data/screens";
import { framesAfter } from "./frames";
import type { StreamEvent } from "../../data/screens";
import type { StreamCorrelation, StreamEmitter, StreamRecord, StreamSeverity, StreamSource } from "../../data/exec-logs";
import type { ExecLogFilters } from "../exec/exec-filters";

/**
 * The Log Explorer's tail model (T61): a seeded bounded window over the
 * Unified Execution Stream plus the live SSE append, with pause/resume and an
 * unread counter. The seed uses `stream.tail` around the global head so the
 * explorer opens on the newest authorized records instead of replaying the
 * whole workspace history; the SSE connection is then created from that
 * cursor, and its own durable reconnect continues from `lastSequence`
 * (reconnect-from-cursor). A seed refresh recreates the connection so the
 * cursor always restarts where the seed ended.
 */

/** One displayable execution-log record, normalized over query views and SSE frames. */
export interface LogRecord {
  readonly streamSeq: number;
  readonly eventId: string;
  readonly type: string;
  readonly severity: StreamSeverity | null;
  readonly emitter: StreamEmitter;
  readonly source: StreamSource | undefined;
  readonly aggregateId: string;
  readonly at: string;
  /** True when the source event carried no timestamp and projection set one. */
  readonly tsApproximate: boolean;
  readonly correlation?: StreamCorrelation;
  readonly summary: unknown;
  /** Where the full payload lives (query views only; SSE frames carry none). */
  readonly payloadRef?: unknown;
}

export function recordOfView(view: StreamRecord): LogRecord {
  return {
    streamSeq: view.streamSeq, eventId: view.eventId, type: view.eventType,
    severity: view.severity, emitter: view.emitter, source: view.source,
    aggregateId: view.aggregateId, at: view.at, tsApproximate: view.tsApproximate,
    ...(view.correlation ? { correlation: view.correlation } : {}),
    summary: view.summary, payloadRef: view.payloadRef,
  };
}

function recordOfFrame(frame: StreamEvent): LogRecord {
  return {
    streamSeq: frame.streamSeq ?? 0, eventId: frame.eventId ?? frame.id,
    type: frame.type, severity: frame.severity ?? null, emitter: frame.emitter ?? "governor",
    source: frame.source, aggregateId: frame.aggregateId ?? "", at: frame.at,
    tsApproximate: false,
    ...(frame.correlation ? { correlation: frame.correlation as StreamCorrelation } : {}),
    summary: frame.summary,
  };
}

/** The visible window stays bounded no matter how long the stream runs. */
const MAX_RECORDS = 1000;
/** While paused, arrivals buffer here; the oldest are dropped past this bound. */
const MAX_PENDING = 2000;
/** The newest records the initial seed fetches around the global head. */
const SEED_WINDOW = 200;
/** Export bound: the newest authorized records matching the current filters. */
const EXPORT_ROWS = 10_000;

/** The correlation + classification axes both the query API and the SSE route accept. */
interface TailAxes {
  sessionId?: string;
  jobId?: string;
  runId?: string;
  attemptId?: string;
  /** Omitted when no emitter filter is active (empty arrays fail the contract's minItems). */
  emitters?: readonly StreamEmitter[];
  severities?: readonly StreamSeverity[];
}

export function tailAxes(filters: ExecLogFilters): TailAxes {
  return {
    ...(filters.session ? { sessionId: filters.session } : {}),
    ...(filters.job ? { jobId: filters.job } : {}),
    ...(filters.run ? { runId: filters.run } : {}),
    ...(filters.attempt ? { attemptId: filters.attempt } : {}),
    ...(filters.emitter.length ? { emitters: filters.emitter } : {}),
    ...(filters.severity.length ? { severities: filters.severity } : {}),
  };
}

function appendFresh(previous: readonly LogRecord[], arrivals: readonly LogRecord[]): readonly LogRecord[] {
  const highest = previous.at(-1)?.streamSeq ?? 0;
  const fresh = arrivals.filter((record) => record.streamSeq > highest);
  if (fresh.length === 0) return previous;
  const merged = [...previous, ...fresh];
  return merged.length > MAX_RECORDS ? merged.slice(merged.length - MAX_RECORDS) : merged;
}

interface LogTail {
  /** Ascending bounded records (query views + live frames merged). */
  readonly records: Accessor<readonly LogRecord[]>;
  /** Seed status; the SSE connection opens only after the seed lands. */
  readonly status: Accessor<"loading" | "ready" | "error">;
  readonly error: Accessor<string>;
  readonly connected: Accessor<boolean>;
  /** Global stream head at the last seed; the export window anchors here. */
  readonly head: Accessor<number>;
  readonly paused: Accessor<boolean>;
  /** Records that arrived while paused and are not visible yet. */
  readonly unread: Accessor<number>;
  /** Arrivals dropped past the pending bound while paused (honest bounded memory). */
  readonly droppedPending: Accessor<number>;
  pause: () => void;
  /** Flush pending arrivals into the view and clear the unread counter. */
  resume: () => void;
  /** Re-seed from the current head (manual refresh, SSE lag reset). */
  reseed: () => Promise<void>;
  /** Bounded sanitized NDJSON export of the current filtered view. */
  exportUrl: () => string;
}

export function createLogTail(input: {
  workspaceId: Accessor<string>;
  /** Connection-scoped axes: the explorer remounts the tail when they change. */
  axes: Accessor<TailAxes>;
  /** Free-text search disables the live tail; the explorer renders search results instead. */
  searchActive: Accessor<boolean>;
}): LogTail {
  const [records, setRecords] = createSignal<readonly LogRecord[]>([]);
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [error, setError] = createSignal("");
  const [head, setHead] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  const [pending, setPending] = createSignal<readonly LogRecord[]>([]);
  const [droppedPending, setDroppedPending] = createSignal(0);
  /** Bumped by every completed seed; recreates the SSE connection below it. */
  const [connection, setConnection] = createSignal(0);
  let seedEpoch = 0;

  async function reseed(): Promise<void> {
    const epoch = ++seedEpoch;
    const workspaceId = input.workspaceId();
    if (!workspaceId) return;
    setStatus("loading");
    setError("");
    setPending([]);
    setDroppedPending(0);
    try {
      const scope = { workspaceId, ...input.axes() };
      // One bounded probe learns the global head; the seed fetches the newest
      // window below it. Ascending reads with an `after` bound are the only
      // tail direction the query contract exposes.
      const probe = await streamTailQuery({ ...scope, limit: 1 });
      if (epoch !== seedEpoch) return;
      const globalHead = probe.snapshot.head;
      const from = Math.max(0, globalHead - SEED_WINDOW);
      const page = await streamTailQuery({ ...scope, ...(from > 0 ? { after: from } : {}), limit: SEED_WINDOW });
      if (epoch !== seedEpoch) return;
      setRecords(page.snapshot.items.map(recordOfView));
      setHead(globalHead);
      setStatus("ready");
      setConnection((value) => value + 1);
    } catch (e) {
      if (epoch !== seedEpoch) return;
      setError(e instanceof Error ? e.message : "The log read could not complete.");
      setStatus("error");
    }
  }

  createEffect(() => {
    void input.axes();
    void input.workspaceId();
    if (input.searchActive()) return; // search renders retained matches, not the live tail
    void reseed();
  });

  interface Connection { dispose: () => void; connected: Accessor<boolean> }
  let active: Connection | undefined;
  onCleanup(() => active?.dispose());
  // The live SSE append, recreated per seed so its starting cursor is always
  // the seed's newest record — never a replay of the entire matching history.
  createEffect(() => {
    const ready = status() === "ready" && connection() > 0 && !input.searchActive();
    if (!ready) { active?.dispose(); active = undefined; return; }
    // The cursor is read untracked: later appends must not re-run this effect
    // and tear down a healthy connection.
    const cursor = untrack(() => records().at(-1)?.streamSeq ?? 0);
    const workspaceId = untrack(input.workspaceId);
    active?.dispose();
    active = createRoot((dispose) => {
      // Identity of the last frame this connection rendered; framesAfter uses
      // it to survive the SSE window's trim (an absolute index would shift and
      // permanently stall the tail past the 500th frame of a connection).
      let lastFrame: StreamEvent | undefined;
      const stream = createEventStream({
        enabled: () => true,
        after: cursor,
        filters: () => {
          const axes = input.axes();
          return {
            ...(workspaceId ? { workspace: workspaceId } : {}),
            ...(axes.sessionId ? { session: axes.sessionId } : {}),
            ...(axes.jobId ? { job: axes.jobId } : {}),
            ...(axes.runId ? { run: axes.runId } : {}),
            ...(axes.severities?.length ? { severity: [...axes.severities] } : {}),
            ...(axes.emitters?.length ? { emitter: [...axes.emitters] } : {}),
          };
        },
      });
      createEffect(() => {
        const events = stream.events();
        const arrivals = framesAfter(events, lastFrame).map(recordOfFrame);
        lastFrame = events.at(-1) ?? lastFrame;
        if (arrivals.length === 0) return;
        if (paused()) {
          // Pause freezes the view, not the counter: arrivals wait bounded.
          setPending((previous) => {
            const highest = Math.max(previous.at(-1)?.streamSeq ?? 0, untrack(() => records().at(-1)?.streamSeq ?? 0));
            const fresh = arrivals.filter((record) => record.streamSeq > highest);
            if (fresh.length === 0) return previous;
            const merged = [...previous, ...fresh];
            const overflow = merged.length - MAX_PENDING;
            if (overflow > 0) setDroppedPending((count) => count + overflow);
            return overflow > 0 ? merged.slice(overflow) : merged;
          });
          return;
        }
        setRecords((previous) => appendFresh(previous, arrivals));
      });
      // A lag reset means the cursor fell behind what the server still serves:
      // re-seed from the head instead of replaying the gap.
      createEffect(() => {
        if (stream.resetRequired()) void reseed();
      });
      return { dispose, connected: stream.connected };
    });
  });

  return {
    records, status, error,
    connected: () => active?.connected() ?? false,
    head, paused,
    unread: () => pending().length,
    droppedPending,
    pause: () => setPaused(true),
    resume: () => {
      const waiting = pending();
      setPending([]);
      setPaused(false);
      if (waiting.length === 0) return;
      setRecords((previous) => appendFresh(previous, waiting));
    },
    reseed,
    exportUrl: () => streamExportUrl({ workspaceId: input.workspaceId(), ...input.axes(), after: Math.max(0, head() - EXPORT_ROWS), limit: EXPORT_ROWS }),
  };
}
