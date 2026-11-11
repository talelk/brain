import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button } from "@talelk/newui-atoms";
import type { ArtifactRef } from "@brain/contracts";
import { createEventStream } from "../../data/screens";
import type { StreamEvent } from "../../data/screens";
import { streamContextQuery, streamTailQuery, type StreamContextBundle, type StreamCorrelation, type StreamSeverity } from "../../data/exec-logs";
import { ArtifactView } from "../outputs/ArtifactView";
import { StreamFilterBar } from "../exec/StreamFilterBar";
import { streamSummaryText } from "../exec/StreamEventRow";
import { CorrelationChips, CorrelationLink } from "../exec/CorrelationLink";
import type { ExecLogFilters } from "../exec/exec-filters";
import { DisclosureCard } from "../components/primitives";
import { DateText } from "../screen-region";
import { feedScroll, setFeedScroll } from "./ConsoleStore";
import { summarizeActivity, type FeedActivity } from "./doing-now";
import { formatClock } from "../format";

/**
 * The live transcript (plan §3): one streaming conversation per selected
 * session over the Unified Execution Stream — the model's exposed messages,
 * its tool activity and system events only, grouped into turns. Assistant
 * text reads as message rows (deltas already coalesced), each tool call is a
 * collapsible card (identity, sanitized arguments, exit status, duration,
 * stdout/stderr artifacts, approval linkage and effect receipts), and a
 * request for input or a pending approval surfaces inline with its action.
 * Nothing here is narration: every row renders what the server projected.
 *
 * History hydrates from a bounded `stream.tail` page walk, then the SSE channel
 * replays from the hydration head (reconnect-from-cursor). The reader's
 * scroll position is kept; new records follow only while the reader is at the
 * bottom, otherwise a "Jump to latest" pill counts them.
 */

const HISTORY_PAGES = 5;
const MAX_FEED = 500;
const BOTTOM_SLACK = 48;

type Rec = Record<string, unknown>;
const obj = (value: unknown): Rec => (value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {});
const text = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
};

export interface FeedEntry {
  key: string;
  streamSeq: number;
  at: string;
  type: string;
  severity: StreamSeverity | null;
  kind: "message" | "tool" | "state" | "system";
  title: string;
  detail: string;
  /** Full text of a coalesced assistant message; `detail` is its one-line preview. */
  body?: string;
  /** Tool calls group their proposed call and result receipt under one entry. */
  tool?: { proposalId?: string; name?: string; proposed?: StreamEvent; result?: StreamEvent };
  event: StreamEvent;
}

interface ToolArtifactRef { artifactId: string; digest: string; bytes: number; mediaType: string; classification: string; }

interface ToolView {
  toolId?: string;
  toolDigest?: string;
  proposalId?: string;
  invocationId?: string;
  input?: unknown;
  target?: unknown;
  result?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  stdout?: ToolArtifactRef;
  stderr?: ToolArtifactRef;
  effects: readonly { invocationId?: string; targetId?: string; operation?: string; outcome?: string; receiptArtifact?: ToolArtifactRef }[];
}

function artifactRef(value: unknown): ToolArtifactRef | undefined {
  const ref = obj(value);
  const artifactId = text(ref["artifactId"]);
  const digest = text(ref["digest"]);
  if (!artifactId || !digest) return undefined;
  return {
    artifactId, digest,
    bytes: typeof ref["bytes"] === "number" ? ref["bytes"] : 0,
    mediaType: text(ref["mediaType"]) ?? "application/octet-stream",
    classification: text(ref["classification"]) ?? "internal",
  };
}

const optional = <T,>(value: T | undefined): T | undefined => value;

/** Merge a tool entry's proposed call and result receipt into one inspection view. */
function toolView(entry: FeedEntry): ToolView {
  const proposed = obj(entry.tool?.proposed?.summary);
  const result = obj(entry.tool?.result?.summary);
  const receipt = obj(result["receipt"]);
  const tool = obj(proposed["tool"]);
  const effects = Array.isArray(receipt["effects"])
    ? (receipt["effects"] as unknown[]).map((effect) => {
      const source = obj(effect);
      return {
        ...(optional(text(source["invocationId"])) ? { invocationId: text(source["invocationId"]) } : {}),
        ...(optional(text(source["targetId"])) ? { targetId: text(source["targetId"]) } : {}),
        ...(optional(text(source["operation"])) ? { operation: text(source["operation"]) } : {}),
        ...(optional(text(source["outcome"])) ? { outcome: text(source["outcome"]) } : {}),
        ...(optional(artifactRef(source["receiptArtifact"])) ? { receiptArtifact: artifactRef(source["receiptArtifact"]) } : {}),
      };
    })
    : [];
  return {
    ...(optional(text(tool["id"])) ? { toolId: text(tool["id"]) } : entry.tool?.name ? { toolId: entry.tool.name } : {}),
    ...(optional(text(tool["digest"])) ? { toolDigest: text(tool["digest"]) } : {}),
    ...(optional(text(proposed["proposalId"])) ? { proposalId: text(proposed["proposalId"]) } : entry.tool?.proposalId ? { proposalId: entry.tool.proposalId } : {}),
    ...(optional(text(result["invocationId"])) ? { invocationId: text(result["invocationId"]) } : {}),
    ...(proposed["input"] !== undefined ? { input: proposed["input"] } : {}),
    ...(proposed["target"] !== undefined ? { target: proposed["target"] } : {}),
    ...(optional(text(receipt["result"])) ? { result: text(receipt["result"]) } : {}),
    ...(typeof receipt["exitCode"] === "number" ? { exitCode: receipt["exitCode"] } : {}),
    ...(optional(text(receipt["startedAt"])) ? { startedAt: text(receipt["startedAt"]) } : {}),
    ...(optional(text(receipt["finishedAt"])) ? { finishedAt: text(receipt["finishedAt"]) } : {}),
    ...(optional(artifactRef(receipt["stdout"])) ? { stdout: artifactRef(receipt["stdout"]) } : {}),
    ...(optional(artifactRef(receipt["stderr"])) ? { stderr: artifactRef(receipt["stderr"]) } : {}),
    effects,
  };
}

function durationText(startedAt?: string, finishedAt?: string): string | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1_000 ? `${ms}ms` : `${Number((ms / 1_000).toFixed(ms < 10_000 ? 1 : 0))}s`;
}

/** The one-line argument preview of a tool call: the values a person recognises, never the raw JSON. */
function argumentPreview(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return String(input);
  const values = Object.values(input as Rec).map((value) => (typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "")).filter(Boolean);
  return streamSummaryText(values.join(" · "), 160);
}

const TITLECASE = (value: string) => value.replaceAll(".", " · ").replaceAll("-", " ");

/** One row title/detail per exposed event kind — real content, never narration. */
function describe(event: StreamEvent): { kind: FeedEntry["kind"]; title: string; detail: string } {
  const payload = obj(event.summary);
  if (event.type === "text") {
    const channel = text(payload["channel"]) ?? "assistant";
    const body = text(payload["text"]) ?? "";
    return channel === "assistant"
      ? { kind: "message", title: "Agent message", detail: streamSummaryText(body) }
      : { kind: "system", title: "Engine diagnostic", detail: streamSummaryText(body) };
  }
  if (event.type === "human.input.requested") {
    return { kind: "state", title: "Waiting for human input", detail: streamSummaryText(text(payload["prompt"]) ?? "") };
  }
  if (event.type === "usage") {
    const input = typeof payload["inputTokens"] === "number" ? payload["inputTokens"] : 0;
    const output = typeof payload["outputTokens"] === "number" ? payload["outputTokens"] : 0;
    return { kind: "state", title: "Usage recorded", detail: `${input.toLocaleString("en-GB")} in · ${output.toLocaleString("en-GB")} out` };
  }
  if (event.type === "artifact") {
    const ref = obj(payload["artifact"]);
    return { kind: "state", title: "File produced", detail: `${text(ref["mediaType"]) ?? "file"} · ${text(ref["digest"]) ?? ""}` };
  }
  if (event.type.startsWith("session.")) {
    return { kind: "state", title: TITLECASE(event.type), detail: streamSummaryText(JSON.stringify(payload)) };
  }
  // tool.proposed / tool.result never reach describe(): buildEntries groups
  // them into one tool entry before this function is consulted.
  return { kind: event.severity === "error" || event.severity === "critical" ? "system" : "state", title: TITLECASE(event.type), detail: streamSummaryText(JSON.stringify(payload)) };
}

/** Group streamed frames into bounded display entries; tool calls stay together. */
function buildEntries(events: readonly StreamEvent[]): FeedEntry[] {
  const grouped = new Map<string, FeedEntry>();
  // Engines stream an assistant message as many small `text` deltas. A run of
  // consecutive assistant deltas of one aggregate is one message, not a row per
  // fragment, until a delta ends the line with a newline; any other event (tool call, state, usage) ends the run.
  let run: FeedEntry | undefined;
  for (const event of events) {
    const payload = obj(event.summary);
    if (event.type === "text" && (text(payload["channel"]) ?? "assistant") === "assistant") {
      const delta = text(payload["text"]) ?? "";
      if (run && run.event.aggregateId === event.aggregateId && !(run.body ?? "").endsWith("\n")) {
        run.body = `${run.body ?? ""}${delta}`;
        run.detail = streamSummaryText(run.body.replace(/\s+/gu, " ").trim(), 400);
        run.event = event;
        continue;
      }
      run = { key: event.id, streamSeq: event.streamSeq ?? 0, at: event.at, type: "text", severity: event.severity ?? null, kind: "message",
        title: "Agent message", detail: streamSummaryText(delta.replace(/\s+/gu, " ").trim(), 400), body: delta, event };
      grouped.set(run.key, run);
      continue;
    }
    run = undefined;
    const isTool = event.type === "tool.proposed" || event.type === "tool.result";
    const proposalId = text(payload["proposalId"]) ?? (isTool ? event.correlation?.proposalId ?? event.aggregateId : undefined);
    const key = isTool && proposalId ? `tool:${proposalId}` : event.id;
    const existing = grouped.get(key);
    if (isTool) {
      const base: FeedEntry = existing ?? {
        key, streamSeq: event.streamSeq ?? 0, at: event.at, type: "tool.call",
        severity: event.severity ?? null, kind: "tool", title: "Tool call", detail: "proposed",
        tool: { ...(proposalId ? { proposalId } : {}) }, event,
      };
      base.tool ??= {};
      if (event.type === "tool.proposed") {
        base.tool.proposed = event;
        const name = text(obj(payload["tool"])["id"]);
        if (name) base.tool.name = name;
        base.title = base.tool.name ?? "unknown tool";
        base.streamSeq = Math.min(base.streamSeq, event.streamSeq ?? base.streamSeq);
        base.at = event.at;
        base.severity = event.severity ?? base.severity;
      } else {
        base.tool.result = event;
        const receipt = obj(payload["receipt"]);
        base.title = base.tool.name ?? text(obj(obj(base.tool.proposed?.summary)["tool"])["id"]) ?? "unknown tool";
        base.severity = event.severity ?? base.severity;
        base.detail = `result ${text(receipt["result"]) ?? "recorded"}${typeof receipt["exitCode"] === "number" ? ` · exit ${receipt["exitCode"]}` : ""}`;
        base.type = "tool.call";
        base.event = event;
      }
      grouped.set(key, base);
      continue;
    }
    const described = describe(event);
    grouped.set(key, {
      key, streamSeq: event.streamSeq ?? 0, at: event.at, type: event.type,
      severity: event.severity ?? null, kind: described.kind, title: described.title, detail: described.detail, event,
    });
  }
  return [...grouped.values()].sort((a, b) => a.streamSeq - b.streamSeq);
}

interface Turn { key: string; index: number; at: string; entries: string[]; usage?: string; tools: number }

/**
 * Turns: an agent turn opens with its message and carries the tool calls it
 * makes; a usage record closes it (and is shown as the turn's cost, not a row).
 */
function buildTurns(entries: readonly FeedEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: (Turn & { closed?: boolean; acted?: boolean }) | undefined;
  for (const entry of entries) {
    if (entry.type === "usage") {
      if (current) { current.usage = entry.detail; current.closed = true; }
      continue;
    }
    if (!current || current.closed || (entry.kind === "message" && current.acted)) {
      current = { key: entry.key, index: turns.length + 1, at: entry.at, entries: [], tools: 0 };
      turns.push(current);
    }
    current.entries.push(entry.key);
    if (entry.kind === "tool") { current.tools += 1; current.acted = true; }
    else if (entry.kind !== "message") current.acted = true;
  }
  return turns;
}

/**
 * Bounded history hydration: walk ascending `stream.tail` pages (≤ 5 × 200),
 * keep the newest MAX_FEED window and return its head as the SSE seed cursor.
 */
export async function hydrateConsoleHistory(workspaceId: string, sessionId: string, signal?: AbortSignal): Promise<{ frames: StreamEvent[]; head: number }> {
  const frames: StreamEvent[] = [];
  let after: number | undefined;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const loaded = await streamTailQuery({ workspaceId, sessionId, ...(after !== undefined ? { after } : {}), limit: 200 }, signal);
    for (const record of loaded.snapshot.items) {
      frames.push({
        id: String(record.streamSeq), streamSeq: record.streamSeq, eventId: record.eventId, type: record.eventType,
        severity: record.severity, emitter: record.emitter, source: record.source, aggregateId: record.aggregateId,
        workspaceId: record.workspaceId, at: record.at, correlation: record.correlation as unknown as Record<string, string> | undefined,
        summary: record.summary, payload: record.summary,
      });
    }
    if (loaded.snapshot.next === "") break;
    after = loaded.snapshot.next;
  }
  const bounded = frames.length > MAX_FEED ? frames.slice(frames.length - MAX_FEED) : frames;
  const last = bounded[bounded.length - 1];
  return { frames: bounded, head: last ? last.streamSeq ?? 0 : 0 };
}

function toRecordFrame(event: StreamEvent): Rec {
  return {
    streamSeq: event.streamSeq, eventId: event.eventId, type: event.type, severity: event.severity,
    emitter: event.emitter, source: event.source, aggregateId: event.aggregateId, at: event.at,
    correlation: event.correlation, summary: event.summary,
  };
}

const timeOf = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatClock(date);
};

export function ConsoleFeed(props: {
  workspaceId: string;
  sessionId: string;
  /** The session's server stream cursor (session.get streamCursor) — the SSE seed when no history exists. */
  streamCursor?: number;
  history: readonly StreamEvent[];
  filters: ExecLogFilters;
  onFiltersChange: (patch: Partial<ExecLogFilters>) => void;
  onResync: () => void;
  /** The session has ended: the stream shows "Ended" rather than a live connection. */
  ended?: boolean;
  /** Offered on an inline request for input when the agent can be steered. */
  onReply?: () => void;
  /** Reported so the console header can say, in plain words, what the session is doing now. */
  onActivity?: (activity: FeedActivity) => void;
}): JSX.Element {
  const [follow, setFollow] = createSignal(true);
  const [unread, setUnread] = createSignal(0);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = createSignal<string | undefined>();
  const [filtersOpen, setFiltersOpen] = createSignal(props.filters.severity.length > 0 || props.filters.emitter.length > 0 || !!props.filters.q);
  const freshAfter = props.history.length > 0 ? props.history[props.history.length - 1]!.streamSeq ?? 0 : props.streamCursor ?? 0;

  // The SSE channel replays from the hydration head (never an attempt
  // sequence), reconnecting from its own cursor after any interruption.
  const stream = createEventStream({
    enabled: () => true,
    after: freshAfter,
    filters: () => ({
      workspace: props.workspaceId,
      session: props.sessionId,
      ...(props.filters.severity.length ? { severity: props.filters.severity } : {}),
      ...(props.filters.emitter.length ? { emitter: props.filters.emitter } : {}),
    }),
  });
  createEffect(() => {
    // The server declared cursor lag: the parent re-hydrates and remounts.
    if (stream.resetRequired()) props.onResync();
  });

  const entries = createMemo(() => {
    const merged = new Map<string, StreamEvent>();
    for (const event of [...props.history, ...stream.events()]) merged.set(event.id, event);
    const all = [...merged.values()];
    return buildEntries(all.length > MAX_FEED ? all.slice(all.length - MAX_FEED) : all);
  });

  // Severity/emitter are enforced server-side (SSE + tail params); free text
  // narrows the bounded mounted window client-side.
  const visible = createMemo(() => {
    const query = props.filters.q?.toLowerCase();
    if (!query) return entries();
    return entries().filter((entry) =>
      entry.title.toLowerCase().includes(query) || entry.detail.toLowerCase().includes(query) || (entry.body ?? "").toLowerCase().includes(query) || entry.type.toLowerCase().includes(query));
  });
  const byKey = createMemo(() => new Map(visible().map((entry) => [entry.key, entry])));
  const turns = createMemo(() => buildTurns(visible()));
  // Rows are walked by key, so a new record appends DOM instead of rebuilding the transcript.
  const turnKeys = createMemo(() => turns().map((turn) => turn.key), undefined, { equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]) });
  const turnByKey = createMemo(() => new Map(turns().map((turn) => [turn.key, turn])));
  const toolCount = () => visible().filter((entry) => entry.kind === "tool").length;
  createEffect(() => { props.onActivity?.(summarizeActivity(entries())); });

  // The latest tool call still waiting for its result: a pending approval on
  // it is the most common reason an agent stops, so its linkage is resolved
  // (stream.context) and surfaced inline with the way to act on it.
  const pendingTool = createMemo(() => [...entries()].reverse().find((entry) => entry.kind === "tool" && !entry.tool?.result));
  const [pendingApproval, setPendingApproval] = createSignal<{ approvalId: string; state: string } | undefined>();
  createEffect(on(() => pendingTool()?.key, (key) => {
    setPendingApproval(undefined);
    const entry = pendingTool();
    if (!key || !entry) return;
    const controller = new AbortController();
    void streamContextQuery(entry.event.eventId ?? entry.event.id, controller.signal)
      .then((loaded) => { const approval = loaded.snapshot.approval; if (approval && !controller.signal.aborted) setPendingApproval({ approvalId: approval.approvalId, state: approval.state }); })
      .catch(() => undefined);
    onCleanup(() => controller.abort());
  }));

  // Scroll: the reader's place is kept per session; new records follow only
  // while the reader sits at the bottom.
  let scroller: HTMLDivElement | undefined;
  const toBottom = () => { if (scroller) scroller.scrollTop = scroller.scrollHeight; };
  const onScroll = () => {
    if (!scroller) return;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_SLACK;
    setFeedScroll(props.workspaceId, props.sessionId, scroller.scrollTop);
    if (atBottom && !follow()) { setFollow(true); setUnread(0); }
    else if (!atBottom && follow()) setFollow(false);
  };
  onMount(() => {
    const restore = feedScroll(props.workspaceId, props.sessionId);
    requestAnimationFrame(() => {
      if (!scroller) return;
      if (restore > 0 && restore + scroller.clientHeight < scroller.scrollHeight - BOTTOM_SLACK) { scroller.scrollTop = restore; setFollow(false); }
      else toBottom();
    });
  });
  let seen = entries().length;
  createEffect(on(() => visible().length, (count) => {
    const arrived = count - seen;
    seen = count;
    if (follow()) requestAnimationFrame(toBottom);
    else if (arrived > 0) setUnread((value) => value + arrived);
  }, { defer: true }));
  const jumpToLatest = () => { setFollow(true); setUnread(0); toBottom(); };

  createEffect(() => {
    // A deep-linked record (filters.entry) opens and reveals itself once.
    const target = props.filters.entry;
    if (target === undefined || entries().length === 0) return;
    const hit = entries().find((entry) => entry.streamSeq === target);
    if (!hit) return;
    setOpen((current) => new Set([...current, hit.key]));
    setFocused(hit.key);
    setFollow(false);
    props.onFiltersChange({ entry: undefined });
    requestAnimationFrame(() => scroller?.querySelector(`[data-entry-key="${CSS.escape(hit.key)}"]`)?.scrollIntoView({ block: "center" }));
  });

  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const connection = () => (props.ended ? { label: "Ended", tone: "gray", dot: "bg-surface-gray-5" } : stream.connected() ? { label: "Live", tone: "green", dot: "bg-surface-green-7 brain-live-dot" } : { label: "Reconnecting", tone: "amber", dot: "bg-surface-amber-6" });

  return <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-outline-gray-1 px-3 py-2">
      <span class="inline-flex items-center gap-1.5 text-caption font-medium text-ink-gray-8" role="status" title={props.ended ? "The session has ended; this is its recorded transcript" : stream.connected() ? "Receiving new records as they happen" : "The live connection dropped; reconnecting from the last record"}>
        <span class={`size-2 rounded-full ${connection().dot}`} aria-hidden="true" />{connection().label}
      </span>
      <span class="text-caption text-ink-gray-6">{turns().length} {turns().length === 1 ? "turn" : "turns"} · {toolCount()} {toolCount() === 1 ? "tool call" : "tool calls"}</span>
      <div class="ms-auto flex items-center gap-1">
        <Button size="sm" variant="ghost" iconLeft="lucide-list-filter" aria-expanded={filtersOpen()} title="Narrow the transcript by importance, source or text"
          onClick={() => setFiltersOpen((value) => !value)}>{filtersOpen() ? "Hide filters" : "Filter"}</Button>
      </div>
    </div>
    <Show when={filtersOpen()}>
      <div class="border-b border-outline-gray-1 px-3 py-2">
        <StreamFilterBar severities={props.filters.severity} emitters={props.filters.emitter} search={props.filters.q ?? ""}
          onToggleSeverity={(severity) => props.onFiltersChange({ severity: props.filters.severity.includes(severity) ? props.filters.severity.filter((value) => value !== severity) : [...props.filters.severity, severity] })}
          onToggleEmitter={(emitter) => props.onFiltersChange({ emitter: props.filters.emitter.includes(emitter) ? props.filters.emitter.filter((value) => value !== emitter) : [...props.filters.emitter, emitter] })}
          onSearch={(search) => props.onFiltersChange({ q: search || undefined })} searchLabel="Search this session's records" />
      </div>
    </Show>
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} class="brain-exec-scroll" role="log" aria-live="off" aria-label={`Transcript of session ${props.sessionId}`} data-testid="console-transcript">
        <Show when={turns().length > 0} fallback={
          <div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <span class="lucide-messages-square size-6 text-ink-gray-5" aria-hidden="true" />
            <p class="text-interface text-ink-gray-7">{props.filters.q || props.filters.severity.length || props.filters.emitter.length ? "No records match these filters." : "Nothing has happened yet."}</p>
            <p class="max-w-sm text-caption text-ink-gray-6">Agent messages, tool calls and system events appear here the moment the session produces them.</p>
          </div>}>
          <ol class="m-0 flex list-none flex-col gap-1 p-0 pb-6">
            <For each={turnKeys()}>{(turnKey) => <Show when={turnByKey().get(turnKey)}>{(turn) => <li class="flex flex-col" aria-label={`Turn ${turn().index}`}>
              <div class="sticky top-0 z-[1] flex items-center gap-2 bg-surface-elevation-1/95 px-3 py-1.5 text-caption text-ink-gray-6 backdrop-blur-sm">
                <span class="font-medium text-ink-gray-7">Turn {turn().index}</span>
                <span aria-hidden="true">·</span><span>{timeOf(turn().at)}</span>
                <Show when={turn().tools > 0}><span aria-hidden="true">·</span><span>{turn().tools} {turn().tools === 1 ? "tool call" : "tool calls"}</span></Show>
                <span class="h-px flex-1 bg-outline-gray-1" aria-hidden="true" />
                <Show when={turn().usage}><span class="inline-flex items-center gap-1" title="Tokens this turn used"><span class="lucide-coins size-3" aria-hidden="true" />{turn().usage}</span></Show>
              </div>
              <div class="flex flex-col gap-2 px-3 pb-2">
                <For each={turn().entries}>{(key) => <Show when={byKey().get(key)}>{(entry) =>
                  <div data-entry-key={key} data-stream-seq={entry().streamSeq} class={`${entry().streamSeq > freshAfter ? "brain-fresh" : ""} ${focused() === key ? "rounded-card ring-2 ring-outline-blue-3" : ""}`}>
                    <EntryView entry={entry()} open={open().has(key)} onToggle={() => toggle(key)}
                      pendingApproval={pendingTool()?.key === key ? pendingApproval() : undefined} onReply={props.onReply} />
                  </div>}</Show>}</For>
              </div>
            </li>}</Show>}</For>
          </ol>
        </Show>
      </div>
      <Show when={!follow() && unread() > 0}>
        <div class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button class="pointer-events-auto shadow-md" size="sm" variant="solid" theme="blue" iconLeft="lucide-arrow-down" onClick={jumpToLatest}>Jump to latest ({unread()})</Button>
        </div>
      </Show>
    </div>
  </div>;
}

/** One transcript row: a message, a tool card, an inline request, or a quiet system line. */
function EntryView(props: {
  entry: FeedEntry;
  open: boolean;
  onToggle: () => void;
  pendingApproval?: { approvalId: string; state: string };
  onReply?: () => void;
}): JSX.Element {
  const error = () => props.entry.severity === "error" || props.entry.severity === "critical";
  return <Show when={props.entry.kind !== "tool"} fallback={<ToolCard entry={props.entry} open={props.open} onToggle={props.onToggle} pendingApproval={props.pendingApproval} />}>
    <Show when={props.entry.kind === "message"} fallback={
      <Show when={props.entry.type === "human.input.requested"} fallback={
        <div class={`flex items-start gap-2 rounded-control px-2 py-1 text-caption ${error() ? "bg-surface-red-1 text-ink-red-8" : "text-ink-gray-6"}`}>
          <span class={`${error() ? "lucide-circle-alert" : props.entry.kind === "system" ? "lucide-terminal" : "lucide-dot"} mt-0.5 size-3.5 shrink-0`} aria-hidden="true" />
          <span class="min-w-0 flex-1"><span class="font-medium">{props.entry.title}</span>
            <Show when={props.entry.detail && props.entry.kind !== "state" || error()}><span class="brain-exec-log ms-1.5 break-words">{props.entry.detail}</span></Show></span>
          <span class="shrink-0 tabular-nums">{timeOf(props.entry.at)}</span>
        </div>}>
        <div class="flex flex-col gap-2 rounded-card border border-outline-amber-2 bg-surface-amber-1 p-3" role="note" aria-label="The agent is waiting for input">
          <p class="flex items-center gap-2 text-interface font-medium text-ink-gray-9"><span class="lucide-hand size-4 text-ink-amber-8" aria-hidden="true" />The agent is waiting for your input</p>
          <Show when={props.entry.detail}><p class="brain-prose whitespace-pre-wrap text-interface text-ink-gray-8">{props.entry.detail}</p></Show>
          <Show when={props.onReply} fallback={<p class="text-caption text-ink-gray-7">This engine cannot be steered while it runs; message the mission or stop and restart the task.</p>}>
            <div><Button size="sm" variant="outline" theme="blue" iconLeft="lucide-corner-down-right" onClick={() => props.onReply?.()}>Reply to the agent</Button></div>
          </Show>
        </div>
      </Show>}>
      <div class="flex items-start gap-2.5">
        <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-surface-blue-2 text-ink-blue-8" aria-hidden="true"><span class="lucide-bot size-3.5" /></span>
        <div class="min-w-0 flex-1">
          <p class="flex items-baseline gap-2 text-caption text-ink-gray-6"><span class="font-medium text-ink-gray-8">Agent</span><span class="tabular-nums">{timeOf(props.entry.at)}</span></p>
          <p class="brain-prose mt-0.5 whitespace-pre-wrap break-words text-interface text-ink-gray-9">{(props.entry.body ?? props.entry.detail).trim()}</p>
        </div>
      </div>
    </Show>
  </Show>;
}

/** A tool call as a collapsible card: what ran, with what, how it ended; expanded, the exact receipt. */
function ToolCard(props: { entry: FeedEntry; open: boolean; onToggle: () => void; pendingApproval?: { approvalId: string; state: string } }): JSX.Element {
  const view = createMemo(() => toolView(props.entry));
  const [context, setContext] = createSignal<StreamContextBundle | undefined>();
  const [contextError, setContextError] = createSignal("");
  const [resolving, setResolving] = createSignal(false);
  const status = (): { label: string; icon: string; tone: string } => {
    const result = view().result;
    if (!props.entry.tool?.result) return props.pendingApproval?.state === "pending"
      ? { label: "Waiting for approval", icon: "lucide-shield-alert", tone: "text-ink-amber-8" }
      : { label: "Running", icon: "lucide-loader-circle animate-spin", tone: "text-ink-blue-8" };
    if (result === "succeeded" && (view().exitCode ?? 0) === 0) return { label: "Succeeded", icon: "lucide-circle-check", tone: "text-ink-green-8" };
    return { label: result ? `${result[0]!.toUpperCase()}${result.slice(1)}${view().exitCode !== undefined && view().exitCode !== 0 ? ` · exit ${view().exitCode}` : ""}` : "Recorded", icon: "lucide-circle-x", tone: "text-ink-red-8" };
  };
  const duration = () => durationText(view().startedAt, view().finishedAt);
  const id = `tool-${props.entry.key.replace(/[^\w-]/gu, "-")}`;
  async function resolve(): Promise<void> {
    setResolving(true); setContextError(""); setContext(undefined);
    try {
      const loaded = await streamContextQuery(props.entry.event.eventId ?? props.entry.event.id);
      setContext(loaded.snapshot);
    } catch (e) {
      setContextError(e instanceof Error ? e.message : "The exact tool context could not be resolved.");
    } finally { setResolving(false); }
  }
  return <div class={`overflow-hidden rounded-card border bg-surface-elevation-1 ${props.open ? "border-outline-blue-2" : "border-outline-gray-2"}`}>
    <button type="button" aria-expanded={props.open} aria-controls={id} onClick={() => props.onToggle()}
      class="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-start hover:bg-surface-gray-1 focus-visible:focus-ring">
      <span class="grid size-6 shrink-0 place-items-center rounded-control bg-surface-gray-2 text-ink-gray-7" aria-hidden="true"><span class="lucide-wrench size-3.5" /></span>
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-baseline gap-2">
          <span class="sr-only">Tool call · </span>
          <span class="brain-exec-log shrink-0 font-medium text-ink-gray-9">{props.entry.title}</span>
          <span class="brain-exec-log min-w-0 truncate text-caption text-ink-gray-6">{argumentPreview(view().input)}</span>
        </span>
      </span>
      <span class={`inline-flex shrink-0 items-center gap-1 text-caption ${status().tone}`}><span class={`${status().icon} size-3.5`} aria-hidden="true" />{status().label}</span>
      <Show when={duration()}><span class="shrink-0 text-caption tabular-nums text-ink-gray-6">{duration()}</span></Show>
      <span class={`lucide-chevron-down size-4 shrink-0 text-ink-gray-6 transition-transform ${props.open ? "rotate-180" : ""}`} aria-hidden="true" />
    </button>
    <Show when={props.pendingApproval?.state === "pending" && !props.open}>
      <div class="flex flex-wrap items-center gap-2 border-t border-outline-amber-2 bg-surface-amber-1 px-3 py-2 text-caption text-ink-gray-8">
        <span class="lucide-shield-alert size-3.5 text-ink-amber-8" aria-hidden="true" />A person has to approve this action before the agent can go on.
        <CorrelationLink target={{ kind: "approval", approvalId: props.pendingApproval!.approvalId }} label="Review the approval" icon="lucide-shield-check" />
      </div>
    </Show>
    <Show when={props.open}>
      <div id={id} class="flex flex-col gap-3 border-t border-outline-gray-1 px-3 py-3">
        <dl class="grid grid-cols-[minmax(6rem,0.3fr)_1fr] gap-x-3 gap-y-1.5 text-caption">
          <dt class="text-ink-gray-6">Tool identity</dt>
          <dd class="brain-exec-log break-all text-ink-gray-8">{view().toolId ?? "unknown"}<Show when={view().toolDigest}><span class="block text-ink-gray-6">{view().toolDigest}</span></Show></dd>
          <Show when={view().result}><dt class="text-ink-gray-6">Result</dt><dd class="text-ink-gray-8 capitalize">{view().result}</dd></Show>
          <Show when={view().exitCode !== undefined}><dt class="text-ink-gray-6">Exit status</dt><dd class="brain-exec-log text-ink-gray-8">{view().exitCode}</dd></Show>
          <Show when={duration()}><dt class="text-ink-gray-6">Duration</dt><dd class="text-ink-gray-8">{duration()}</dd></Show>
          <dt class="text-ink-gray-6">Proposed</dt><dd class="text-ink-gray-8"><DateText value={props.entry.tool?.proposed?.at ?? props.entry.at} /></dd>
        </dl>
        <Show when={view().input !== undefined}>
          <DisclosureCard label="Sanitized arguments" open>
            <pre class="brain-exec-log max-h-48 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-7">{JSON.stringify(view().input, null, 2)}</pre>
          </DisclosureCard>
        </Show>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" iconLeft="lucide-search-check" loading={resolving()} onClick={() => void resolve()}>Open tool result</Button>
          <span class="text-caption text-ink-gray-6">Shows the files this call produced and any approval it needed.</span>
        </div>
        <Show when={contextError()}><p role="alert" class="text-caption text-ink-red-8">{contextError()}</p></Show>
        <Show when={context()}>{(loaded) => <>
          <Show when={loaded().artifacts.length > 0} fallback={<p class="text-caption text-ink-gray-6">No file is bound to this call's records.</p>}>
            <div class="flex flex-col gap-2">
              <For each={loaded().artifacts}>{(artifact) => <div class="rounded-control border border-outline-gray-1 p-2">
                <div class="mb-1 flex items-center justify-between gap-2">
                  <span class="brain-exec-log truncate text-caption text-ink-gray-8" title={artifact.digest}>{artifact.mediaType} · {artifact.bytes.toLocaleString("en-GB")} bytes · {artifact.classification}</span>
                  <CorrelationLink target={{ kind: "artifact", artifactId: artifact.artifactId }} label="Open artifact" icon="lucide-file-search" />
                </div>
                <ArtifactView artifact={artifact as unknown as ArtifactRef} compact />
              </div>}</For>
            </div>
          </Show>
          <Show when={loaded().approval}>{(approval) =>
            <div class="flex flex-wrap items-center gap-2 rounded-control border border-outline-blue-2 bg-surface-blue-1 p-2 text-caption">
              <span>Related approval</span>
              <CorrelationLink target={{ kind: "approval", approvalId: approval().approvalId }} label={approval().approvalId} icon="lucide-shield-check" />
              <span class="capitalize text-ink-gray-7">({approval().state})</span>
            </div>}</Show>
        </>}</Show>
        <Show when={view().effects.length > 0}>
          <DisclosureCard label={`Linked effect receipts (${view().effects.length})`}>
            <div class="flex flex-col gap-2">
              <For each={view().effects}>{(effect) => <div class="flex flex-wrap items-center gap-2 text-caption text-ink-gray-7">
                <Badge size="sm" variant="outline" theme={effect.outcome === "applied" ? "green" : effect.outcome === "unknown" || effect.outcome === "conflicting" ? "red" : "gray"} label={effect.outcome ?? "unknown"} />
                <span class="brain-exec-log break-all">{effect.operation ?? effect.invocationId ?? "effect"}</span>
                <Show when={effect.receiptArtifact}><CorrelationLink target={{ kind: "artifact", artifactId: effect.receiptArtifact!.artifactId }} label="Receipt artifact" icon="lucide-file-search" /></Show>
              </div>}</For>
            </div>
          </DisclosureCard>
        </Show>
        <CorrelationChips correlation={props.entry.event.correlation as unknown as StreamCorrelation | undefined} />
        <DisclosureCard label="Exact projected records (proposed call and result)">
          <pre class="brain-exec-log max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-7">{JSON.stringify([props.entry.tool?.proposed ? toRecordFrame(props.entry.tool.proposed) : undefined, props.entry.tool?.result ? toRecordFrame(props.entry.tool.result) : undefined].filter(Boolean), null, 2)}</pre>
        </DisclosureCard>
      </div>
    </Show>
  </div>;
}
