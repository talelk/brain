import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button } from "@talelk/newui-atoms";
import type { ArtifactRef } from "@brain/contracts";
import { createEventStream } from "../../data/screens";
import type { StreamEvent } from "../../data/screens";
import { streamContextQuery, streamTailQuery, type StreamContextBundle, type StreamCorrelation, type StreamSeverity } from "../../data/exec-logs";
import { ArtifactView } from "../outputs/ArtifactView";
import { VirtualLogList } from "../exec/VirtualLogList";
import { StreamFilterBar } from "../exec/StreamFilterBar";
import { streamSummaryText } from "../exec/StreamEventRow";
import { CorrelationChips, CorrelationLink } from "../exec/CorrelationLink";
import type { ExecLogFilters } from "../exec/exec-filters";
import { DisclosureCard, PaneResizer, clampPaneSize } from "../components/primitives";
import { RelativeTime } from "../screen-region";
import { consoleSplit, feedScroll, setConsoleSplit, setFeedScroll } from "./ConsoleStore";
import type { ConsoleSplit } from "./ConsoleStore";

/**
 * The live console feed (plan §3): one streaming transcript per selected
 * session over the Unified Execution Stream — the model's exposed messages,
 * its tool activity and system events only. A tool invocation's proposed call,
 * progress, result and errors group together; expanding one shows identity,
 * sanitized arguments, stdout/stderr artifacts, duration, exit status and the
 * linked effect receipt. No invented "agent thought process" exists anywhere
 * in this component: every row renders exactly what the server projected.
 *
 * History hydrates from a bounded `stream.tail` page walk, then the SSE channel
 * replays from the hydration head (reconnect-from-cursor) with scroll
 * preservation and an unread counter while the reader is scrolled away.
 */

const ROW_HEIGHT = 40;
const HISTORY_PAGES = 5;
const MAX_FEED = 500;
const DETAIL_MIN = 200;
const DETAIL_DEFAULT = 280;

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
    return { kind: "message", title: "Usage recorded", detail: `${input.toLocaleString()} in · ${output.toLocaleString()} out` };
  }
  if (event.type === "artifact") {
    const ref = obj(payload["artifact"]);
    return { kind: "state", title: "Artifact produced", detail: `${text(ref["mediaType"]) ?? "file"} · ${text(ref["digest"]) ?? ""}` };
  }
  if (event.type.startsWith("session.")) {
    return { kind: "state", title: TITLECASE(event.type), detail: streamSummaryText(JSON.stringify(payload)) };
  }
  // tool.proposed / tool.result never reach describe(): buildEntries groups
  // them into one tool entry before this function is consulted.
  return { kind: event.severity === "error" || event.severity === "critical" ? "system" : "message", title: TITLECASE(event.type), detail: streamSummaryText(JSON.stringify(payload)) };
}

/** Group streamed frames into bounded display entries; tool calls stay together. */
function buildEntries(events: readonly StreamEvent[]): FeedEntry[] {
  const grouped = new Map<string, FeedEntry>();
  for (const event of events) {
    const payload = obj(event.summary);
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
        base.title = `Tool call · ${base.tool.name ?? "unknown tool"}`;
        base.streamSeq = Math.min(base.streamSeq, event.streamSeq ?? base.streamSeq);
        base.at = event.at;
        base.severity = event.severity ?? base.severity;
      } else {
        base.tool.result = event;
        const receipt = obj(payload["receipt"]);
        base.title = `Tool call · ${base.tool.name ?? text(obj(obj(base.tool.proposed?.summary)["tool"])["id"]) ?? "unknown tool"}`;
        base.severity = event.severity ?? base.severity;
        base.streamSeq = event.streamSeq ?? base.streamSeq;
        base.detail = `result ${text(receipt["result"]) ?? "recorded"}${typeof receipt["exitCode"] === "number" ? ` · exit ${receipt["exitCode"]}` : ""}`;
        base.at = event.at;
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

export function ConsoleFeed(props: {
  workspaceId: string;
  sessionId: string;
  /** The session's server stream cursor (session.get streamCursor) — the SSE seed when no history exists. */
  streamCursor?: number;
  history: readonly StreamEvent[];
  filters: ExecLogFilters;
  onFiltersChange: (patch: Partial<ExecLogFilters>) => void;
  onResync: () => void;
  /** Bumped by the toolbar's "Open tool result" to force-resolve the selection. */
  resolveToken?: number;
  /** Reported so the toolbar can act on the selected tool call. */
  onSelectionChange?: (entry: FeedEntry | undefined) => void;
}): JSX.Element {
  const [follow, setFollow] = createSignal(true);
  const [unread, setUnread] = createSignal(0);
  const [selectedKey, setSelectedKey] = createSignal<string | undefined>();
  const [filtersOpen, setFiltersOpen] = createSignal(props.filters.severity.length > 0 || props.filters.emitter.length > 0 || !!props.filters.q);
  const [restoreOffset, setRestoreOffset] = createSignal(feedScroll(props.workspaceId, props.sessionId));
  const [detailSize, setDetailSize] = createSignal(DETAIL_DEFAULT);
  const [context, setContext] = createSignal<StreamContextBundle | undefined>();
  const [contextError, setContextError] = createSignal("");
  const [resolving, setResolving] = createSignal(false);
  let resolveSeen = props.resolveToken ?? 0;

  // The SSE channel replays from the hydration head (never an attempt
  // sequence), reconnecting from its own cursor after any interruption.
  const stream = createEventStream({
    enabled: () => true,
    after: props.history.length > 0 ? props.history[props.history.length - 1]!.streamSeq : props.streamCursor ?? 0,
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
      entry.title.toLowerCase().includes(query) || entry.detail.toLowerCase().includes(query) || entry.type.toLowerCase().includes(query));
  });

  const selected = createMemo(() => visible().find((entry) => entry.key === selectedKey()));
  createEffect(() => { props.onSelectionChange?.(selected()); });

  // Unread counter while the reader is scrolled away from the newest record.
  let seenCount = entries().length;
  createEffect(() => {
    const count = entries().length;
    const arrived = count - seenCount;
    seenCount = count;
    if (arrived > 0 && !follow()) setUnread((value) => value + arrived);
    if (follow()) setUnread(0);
  });

  // Scroll: bottom detection via a capturing listener on the wrapper (scroll
  // does not bubble, so the event target is the scrolled element; only the
  // virtualised transcript list drives follow state); offsets persist per
  // session in ConsoleStore.
  let wrap: HTMLDivElement | undefined;
  const syncScroll = (event: Event): void => {
    const list = event.target;
    if (!wrap || !(list instanceof HTMLUListElement)) return;
    if (restoreOffset() !== 0) setRestoreOffset(0); // the restore jump landed; hand control to the reader
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - ROW_HEIGHT * 2;
    setFeedScroll(props.workspaceId, props.sessionId, list.scrollTop);
    if (atBottom && !follow()) { setFollow(true); setUnread(0); }
    else if (!atBottom && follow()) setFollow(false);
  };
  onMount(() => {
    if (restoreOffset() > 0) setFollow(false);
    wrap?.addEventListener("scroll", syncScroll, true);
    onCleanup(() => wrap?.removeEventListener("scroll", syncScroll, true));
  });
  createEffect(() => {
    // A deep-linked record (filters.entry) selects and reveals itself once.
    const target = props.filters.entry;
    if (target === undefined || entries().length === 0) return;
    const hit = entries().find((entry) => entry.streamSeq === target);
    if (hit) {
      setSelectedKey(hit.key);
      setFollow(false);
      props.onFiltersChange({ entry: undefined });
    }
  });
  createEffect(() => {
    // "Open tool result": force-resolve the selected tool call's artifacts.
    const bump = props.resolveToken ?? 0;
    if (bump === resolveSeen) return;
    resolveSeen = bump;
    void resolveSelected();
  });

  const scrollToIndex = createMemo(() => {
    if (follow()) return Math.max(0, visible().length - 1);
    const offset = restoreOffset();
    if (offset > 0) return Math.min(Math.max(0, visible().length - 1), Math.round(offset / ROW_HEIGHT));
    return undefined;
  });

  const selectedTool = createMemo(() => (selected()?.kind === "tool" && selected()!.tool ? toolView(selected()!) : undefined));

  async function resolveSelected(): Promise<void> {
    const entry = selected();
    if (!entry) return;
    setResolving(true); setContextError(""); setContext(undefined);
    try {
      const loaded = await streamContextQuery(entry.event.eventId ?? entry.event.id);
      setContext(loaded.snapshot);
    } catch (e) {
      setContextError(e instanceof Error ? e.message : "The exact tool context could not be resolved.");
    } finally { setResolving(false); }
  }

  const select = (entry: FeedEntry): void => {
    setSelectedKey((current) => (current === entry.key ? current : entry.key));
    // Expanding a record needs an inspection surface; reveal it once.
    if (consoleSplit(props.workspaceId) === "off") setConsoleSplit(props.workspaceId, "vertical");
  };

  const split = (): ConsoleSplit => consoleSplit(props.workspaceId);
  const entryTone = (entry: FeedEntry): string =>
    entry.kind === "tool" ? "bg-surface-blue-2 text-ink-blue-8"
      : entry.kind === "state" ? "bg-surface-green-2 text-ink-green-8"
        : entry.severity === "error" || entry.severity === "critical" ? "bg-surface-red-2 text-ink-red-8"
          : "bg-surface-gray-2 text-ink-gray-7";
  const entryIcon = (entry: FeedEntry): string =>
    entry.kind === "tool" ? "lucide-wrench"
      : entry.kind === "state" ? "lucide-activity"
        : entry.severity === "error" || entry.severity === "critical" ? "lucide-circle-alert" : "lucide-message-square";
  const detailBasis = (): "column" | "row" => (split() === "vertical" ? "column" : "row");

  return <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-2 border-b border-outline-gray-1 px-3 py-2">
      <Badge theme={stream.connected() ? "green" : "amber"} variant="outline" label={stream.connected() ? "Live" : "Reconnecting"} />
      <span class="text-caption text-ink-gray-6">{visible().length} bounded records</span>
      <div class="ms-auto flex flex-wrap items-center gap-2">
        <Show when={unread() > 0}>
          <Button size="sm" variant="solid" theme="blue" onClick={() => { setFollow(true); setUnread(0); }}>Jump to newest ({unread()})</Button>
        </Show>
        <Button size="sm" variant="outline" theme={follow() ? "blue" : "gray"} onClick={() => { const next = !follow(); setFollow(next); if (next) setUnread(0); }}>
          {follow() ? "Following" : "Follow"}
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={filtersOpen()} onClick={() => setFiltersOpen((value) => !value)}>Filters</Button>
        <fieldset class="m-0 flex overflow-hidden rounded-control border border-outline-gray-2 p-0">
          <legend class="sr-only">Center pane split</legend>
          <Button size="sm" variant="ghost" aria-pressed={split() === "off"} onClick={() => setConsoleSplit(props.workspaceId, "off")}>Full</Button>
          <Button size="sm" variant="ghost" aria-pressed={split() === "vertical"} onClick={() => setConsoleSplit(props.workspaceId, "vertical")} aria-label="Split inspection below">Below</Button>
          <Button size="sm" variant="ghost" aria-pressed={split() === "horizontal"} onClick={() => setConsoleSplit(props.workspaceId, "horizontal")} aria-label="Split inspection beside">Beside</Button>
        </fieldset>
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
    <div ref={wrap} class="brain-exec-console min-h-0 flex-1" data-split={split() === "vertical" ? "column" : undefined}>
      <div class="brain-exec-pane min-h-0 min-w-0 flex-1">
        <VirtualLogList items={visible()} rowHeight={ROW_HEIGHT} scrollToIndex={scrollToIndex()}
          itemKey={(entry) => entry.key} class="flex-1" ariaLabel={`Live events for session ${props.sessionId}`}>
          {(entry) => <div data-stream-seq={entry.streamSeq} class="h-full">
            <button type="button" aria-pressed={selected()?.key === entry.key}
              class={`flex h-full w-full cursor-pointer items-center gap-2 border-b border-outline-gray-1 px-3 text-start focus-visible:focus-ring ${selected()?.key === entry.key ? "bg-surface-blue-1" : "hover:bg-surface-gray-1"}`}
              onClick={() => select(entry)}>
              <span class={`grid size-6 shrink-0 place-items-center rounded-control ${entryTone(entry)}`}><span class={`${entryIcon(entry)} size-3.5`} aria-hidden="true" /></span>
              <span class="brain-exec-log w-16 shrink-0 text-caption text-ink-gray-6"><RelativeTime value={entry.at} /></span>
              <span class={`brain-exec-log min-w-0 flex-[2] truncate ${entry.kind === "tool" ? "text-ink-gray-8" : "text-ink-gray-9"}`}>{entry.title}</span>
              <span class="brain-exec-log min-w-0 flex-[3] truncate text-caption text-ink-gray-6">{entry.detail}</span>
              <Show when={entry.severity === "error" || entry.severity === "critical"}>
                <span class="size-2 shrink-0 rounded-full bg-surface-red-7" role="img" aria-label="Error record" />
              </Show>
              <Show when={entry.tool?.result}><span class="shrink-0 text-caption text-ink-gray-6" title="Result recorded">✓</span></Show>
            </button>
          </div>}
        </VirtualLogList>
        <Show when={visible().length === 0}>
          <p class="p-4 text-interface text-ink-gray-6">No records match yet. Tool calls, agent messages and system events stream here while the session runs.</p>
        </Show>
      </div>
      <Show when={split() !== "off" && selected()}>
        <PaneResizer orientation={detailBasis()} label={split() === "vertical" ? "Resize the record inspection split (up/down)" : "Resize the record inspection split (left/right)"}
          onResize={(delta) => setDetailSize((size) => clampPaneSize(size + (split() === "vertical" ? -delta : delta), DETAIL_MIN, 800))}
          onReset={() => setDetailSize(DETAIL_DEFAULT)} />
        <div class={`brain-exec-pane shrink-0 overflow-hidden ${split() === "vertical" ? "border-t border-outline-gray-1" : ""}`} style={{
          ...(split() === "vertical" ? { height: `${detailSize()}px` } : { width: `${detailSize()}px` }),
        }}>
          <div class="brain-exec-scroll p-3">
            <Show when={selected()} keyed>{(entry) => <div class="flex flex-col gap-3">
              <div class="flex items-center justify-between gap-2">
                <h3 class="min-w-0 break-all text-base-medium text-ink-gray-9">{entry.title}</h3>
                <Button class="shrink-0" size="sm" variant="ghost" onClick={() => setSelectedKey(undefined)}>Close</Button>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-caption text-ink-gray-6">
                <RelativeTime value={entry.at} /> <span>{entry.type}</span>
                <Show when={entry.severity}><Badge size="sm" variant="outline" theme={entry.severity === "error" || entry.severity === "critical" ? "red" : entry.severity === "warning" ? "amber" : "gray"} label={entry.severity!} /></Show>
              </div>
              <CorrelationChips correlation={entry.event.correlation as unknown as StreamCorrelation | undefined} />
              <Show when={entry.kind === "tool" && selectedTool()} keyed fallback={
                <div class="flex flex-col gap-3">
                  <Show when={entry.detail}><p class="brain-exec-log whitespace-pre-wrap break-words text-caption text-ink-gray-7">{entry.detail}</p></Show>
                  <DisclosureCard label="Exact projected record">
                    <pre class="brain-exec-log max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-7">{JSON.stringify(toRecordFrame(entry.event), null, 2)}</pre>
                  </DisclosureCard>
                </div>}>
                <div class="flex flex-col gap-3">
                  <ToolInspection view={selectedTool()!} context={context()} contextError={contextError()} resolving={resolving()} onResolve={() => void resolveSelected()} />
                  <DisclosureCard label="Exact projected records (proposed call and result)">
                    <pre class="brain-exec-log max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-7">{JSON.stringify([entry.tool?.proposed ? toRecordFrame(entry.tool.proposed) : undefined, entry.tool?.result ? toRecordFrame(entry.tool.result) : undefined].filter(Boolean), null, 2)}</pre>
                  </DisclosureCard>
                </div>
              </Show>
            </div>}</Show>
          </div>
        </div>
      </Show>
    </div>
  </div>;
}

/** The expanded tool call: identity, sanitized arguments, artifacts, receipt. */
function ToolInspection(props: {
  view: ToolView;
  context?: StreamContextBundle;
  contextError: string;
  resolving: boolean;
  onResolve: () => void;
}): JSX.Element {
  const duration = () => durationText(props.view.startedAt, props.view.finishedAt);
  return <div class="flex flex-col gap-3">
    <dl class="grid grid-cols-[minmax(6rem,0.3fr)_1fr] gap-x-3 gap-y-1.5 text-caption">
      <dt class="text-ink-gray-6">Tool identity</dt>
      <dd class="brain-exec-log break-all text-ink-gray-8">{props.view.toolId ?? "unknown"}<Show when={props.view.toolDigest}><span class="block text-ink-gray-6">{props.view.toolDigest}</span></Show></dd>
      <Show when={props.view.proposalId}><dt class="text-ink-gray-6">Proposal</dt><dd class="brain-exec-log break-all text-ink-gray-8">{props.view.proposalId}</dd></Show>
      <Show when={props.view.invocationId}><dt class="text-ink-gray-6">Invocation</dt><dd class="brain-exec-log break-all text-ink-gray-8">{props.view.invocationId}</dd></Show>
      <Show when={props.view.result}><dt class="text-ink-gray-6">Result</dt><dd class="text-ink-gray-8 capitalize">{props.view.result}</dd></Show>
      <Show when={props.view.exitCode !== undefined}><dt class="text-ink-gray-6">Exit status</dt><dd class="brain-exec-log text-ink-gray-8">{props.view.exitCode}</dd></Show>
      <Show when={duration()}><dt class="text-ink-gray-6">Duration</dt><dd class="text-ink-gray-8">{duration()}</dd></Show>
    </dl>
    <Show when={props.view.input !== undefined}>
      <DisclosureCard label="Sanitized arguments" open>
        <pre class="brain-exec-log max-h-48 overflow-auto whitespace-pre-wrap break-words text-caption text-ink-gray-7">{JSON.stringify(props.view.input, null, 2)}</pre>
      </DisclosureCard>
    </Show>
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" iconLeft="lucide-search-check" loading={props.resolving} onClick={props.onResolve}>Open tool result</Button>
      <span class="text-caption text-ink-gray-6">Resolves the invocation's authorized artifacts and linked approval.</span>
    </div>
    <Show when={props.contextError}><p role="alert" class="text-caption text-ink-red-8">{props.contextError}</p></Show>
    <Show when={props.context}>
      <Show when={props.context!.artifacts.length > 0} fallback={<p class="text-caption text-ink-gray-6">No artifact is bound to this invocation's records.</p>}>
        <div class="flex flex-col gap-2">
          <For each={props.context!.artifacts}>{(artifact) => <div class="rounded-control border border-outline-gray-1 p-2">
            <div class="mb-1 flex items-center justify-between gap-2">
              <span class="brain-exec-log truncate text-caption text-ink-gray-8" title={artifact.digest}>{artifact.mediaType} · {artifact.bytes.toLocaleString()} bytes · {artifact.classification}</span>
              <CorrelationLink target={{ kind: "artifact", artifactId: artifact.artifactId }} label="Open artifact" icon="lucide-file-search" />
            </div>
            <ArtifactView artifact={artifact as unknown as ArtifactRef} compact />
          </div>}</For>
        </div>
      </Show>
      <Show when={props.context!.approval}>
        <div class="flex flex-wrap items-center gap-2 rounded-control border border-outline-blue-2 bg-surface-blue-1 p-2 text-caption">
          <span>Related approval</span>
          <CorrelationLink target={{ kind: "approval", approvalId: props.context!.approval!.approvalId }} label={props.context!.approval!.approvalId} icon="lucide-shield-check" />
          <span class="capitalize text-ink-gray-7">({props.context!.approval!.state})</span>
        </div>
      </Show>
    </Show>
    <Show when={props.view.effects.length > 0}>
      <DisclosureCard label={`Linked effect receipts (${props.view.effects.length})`}>
        <div class="flex flex-col gap-2">
          <For each={props.view.effects}>{(effect) => <div class="flex flex-wrap items-center gap-2 text-caption text-ink-gray-7">
            <Badge size="sm" variant="outline" theme={effect.outcome === "applied" ? "green" : effect.outcome === "unknown" || effect.outcome === "conflicting" ? "red" : "gray"} label={effect.outcome ?? "unknown"} />
            <span class="brain-exec-log break-all">{effect.operation ?? effect.invocationId ?? "effect"}</span>
            <Show when={effect.receiptArtifact}><CorrelationLink target={{ kind: "artifact", artifactId: effect.receiptArtifact!.artifactId }} label="Receipt artifact" icon="lucide-file-search" /></Show>
          </div>}</For>
        </div>
      </DisclosureCard>
    </Show>
  </div>;
}
