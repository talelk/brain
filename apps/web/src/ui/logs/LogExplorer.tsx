import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX, Accessor } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { statusTheme } from "../components/StatusBadge";
import { createScopedRead } from "../../data/screens";
import { streamSearchQuery, streamContextQuery } from "../../data/exec-logs";
import type { StreamSearchPage, StreamSeverity, StreamEmitter, StreamContextBundle } from "../../data/exec-logs";
import { readExecFilters, writeExecFilters } from "../exec/exec-filters";
import type { ExecLogFilters } from "../exec/exec-filters";
import { CorrelationChips, CorrelationLink } from "../exec/CorrelationLink";
import { VirtualLogList } from "../exec/VirtualLogList";
import { FactStrip } from "../components/Domain";
import { DisclosureCard } from "../components/primitives";
import { severityLabel } from "../screen-region";
import { useApp } from "../app-context";
import { shortDigest } from "../format";
import { streamSummaryText } from "../exec/StreamEventRow";
import { createLogTail, recordOfView, tailAxes } from "./LogTail";
import { LogRow, ROW_HEIGHT, ContextLines, buildLogRows, rowKey } from "./LogRow";
import type { LogRowModel } from "./LogRow";
import { LogFilters } from "./LogFilters";
import type { LogViewMode } from "./LogFilters";
import { ToolCallGroup } from "./ToolCallGroup";
import { AttemptCompare } from "./AttemptCompare";
import { contextAround, failureJump, rowMembers } from "./errorJump";

/**
 * The Log Explorer (T61): an independent, searchable execution-log view at
 * `/w/:id/logs` — live tail with pause/resume and an unread counter, source
 * and severity filters, full-text search across the authorized retained logs,
 * grouping, Readable/Raw modes, cross-attempt comparison, bounded export and
 * error navigation — over one Unified Execution Stream read model. Not a tab
 * of run detail.
 */

type FilterPatch = Partial<Omit<ExecLogFilters, "severity" | "emitter">> & {
  severity?: readonly string[];
  emitter?: readonly string[];
};

interface SurfaceProps {
  workspaceId: string;
  /** Frozen per tail connection: correlation scope, severities, emitters. */
  axes: ReturnType<typeof tailAxes>;
  filters: Omit<ExecLogFilters, "q" | "entry">;
  /** Live search text; changing it does not remount the tail. */
  q: Accessor<string | undefined>;
  entry: number | undefined;
  mode: LogViewMode;
  compareOpen: boolean;
  onPatch: (patch: FilterPatch) => void;
  onMode: (mode: LogViewMode) => void;
  onToggleCompare: () => void;
}

function TailSurface(props: SurfaceProps): JSX.Element {
  const app = useApp();
  const searchActive = () => (props.q() ?? "").trim().length > 0;
  const tail = createLogTail({
    workspaceId: () => props.workspaceId,
    axes: () => props.axes,
    searchActive,
  });

  const search = createScopedRead<StreamSearchPage>({
    scope: app.scope,
    resource: props.q,
    load: async (_scope, signal, resource) => {
      const text = (resource ?? "").trim();
      // No search text: an empty result without a doomed server round-trip.
      if (!text) return { snapshot: { items: [], totalEstimate: 0, nextCursor: "" } as StreamSearchPage, asOf: new Date(0).toISOString(), sourceWatermark: 0 };
      return streamSearchQuery({ workspaceId: props.workspaceId, ...props.axes, search: text, limit: 50 }, signal);
    },
    isEmpty: (page) => page.items.length === 0,
  });

  // Older matches: each "Load older matches" click pages past the previous
  // page's nextCursor — its oldest stream_seq, fed back as the exclusive
  // `before` bound — so matches beyond the newest 50 stay reachable. A search
  // text change resets the stack (the axes remount the whole surface).
  const [older, setOlder] = createSignal<{ anchor: string; pages: readonly StreamSearchPage[]; busy: boolean; error: string }>({ anchor: "", pages: [], busy: false, error: "" });
  createEffect(() => {
    const anchor = props.q() ?? "";
    if (older().anchor !== anchor) setOlder({ anchor, pages: [], busy: false, error: "" });
  });
  const shownMatches = createMemo(() => (search.state().data?.items.length ?? 0) + older().pages.reduce((sum, page) => sum + page.items.length, 0));
  const remainingMatches = createMemo(() => Math.max(0, (search.state().data?.totalEstimate ?? 0) - shownMatches()));
  const oldestCursor = (): number | "" => {
    const page = older().pages.at(-1) ?? search.state().data;
    return page && page.items.length > 0 ? page.nextCursor : "";
  };
  const loadOlder = async (): Promise<void> => {
    const cursor = oldestCursor();
    const text = (props.q() ?? "").trim();
    const anchor = older().anchor;
    if (!text || typeof cursor !== "number" || older().busy) return;
    setOlder((current) => ({ ...current, busy: true, error: "" }));
    try {
      const page = await streamSearchQuery({ workspaceId: props.workspaceId, ...props.axes, search: text, before: cursor, limit: 50 });
      if (older().anchor !== anchor) return; // the search moved on mid-flight
      setOlder((current) => ({ ...current, pages: [...current.pages, page.snapshot] }));
    } catch (e) {
      if (older().anchor === anchor) setOlder((current) => ({ ...current, error: e instanceof Error ? e.message : "Older matches could not be loaded." }));
    } finally {
      setOlder((current) => ({ ...current, busy: false }));
    }
  };

  const rows = createMemo<readonly LogRowModel[]>(() => buildLogRows(
    searchActive()
      ? [...(search.state().data?.items ?? []), ...older().pages.flatMap((page) => page.items)].map(recordOfView)
      : tail.records(),
  ));

  const [selectedKey, setSelectedKey] = createSignal<string | undefined>();
  const [scrollIndex, setScrollIndex] = createSignal<number | undefined>();
  const [follow, setFollow] = createSignal(true);
  const [seenCount, setSeenCount] = createSignal(0);
  const [contextAnchor, setContextAnchor] = createSignal<string | undefined>();
  let entryHandled = false;

  const selectedIndex = createMemo(() => {
    const key = selectedKey();
    if (key === undefined) return undefined;
    const at = rows().findIndex((row) => rowKey(row) === key);
    return at >= 0 ? at : undefined;
  });
  const selectedRow = createMemo(() => {
    const at = selectedIndex();
    return at === undefined ? undefined : rows()[at];
  });

  createEffect(() => {
    if (follow()) setSeenCount(rows().length);
  });
  // Follow pins the viewport to the newest row while the reader is at the end.
  createEffect(() => {
    if (follow() && !searchActive()) setScrollIndex(rows().length - 1);
  });

  // Deep-linked record (?entry=<stream_seq>): select and scroll once loaded.
  createEffect(() => {
    const target = props.entry;
    if (target === undefined || entryHandled) return;
    const list = rows();
    const exact = list.findIndex((row) => rowMembers(row).some((record) => record.streamSeq === target));
    const index = exact >= 0 ? exact : list.findIndex((row) => rowMembers(row).some((record) => record.streamSeq >= target));
    if (index >= 0) {
      entryHandled = true;
      setFollow(false);
      setSelectedKey(rowKey(list[index]!));
      setScrollIndex(index);
    }
  });

  let viewport: HTMLDivElement | undefined;
  onMount(() => {
    // Scroll does not bubble; capture is how the surface sees the virtual list's scroll.
    // The end threshold matches the follow scroll's resting position (the
    // newest row parks one third of the viewport above the bottom), so a
    // programmatic jump never unpins itself.
    const onScroll = (event: Event): void => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !viewport?.contains(el)) return;
      setFollow(el.scrollHeight - el.scrollTop - el.clientHeight <= el.clientHeight / 3 + ROW_HEIGHT);
    };
    viewport?.addEventListener("scroll", onScroll, true);
    onCleanup(() => viewport?.removeEventListener("scroll", onScroll, true));
  });

  const selectRow = (row: LogRowModel): void => {
    setContextAnchor(undefined);
    setSelectedKey(rowKey(row) === selectedKey() ? undefined : rowKey(row));
  };

  const jumpToFailure = (): void => {
    const jump = failureJump(rows());
    if (!jump) return;
    entryHandled = true;
    setFollow(false);
    setContextAnchor(jump.record.eventId);
    setSelectedKey(rowKey(rows()[jump.index]!));
    setScrollIndex(jump.index);
  };

  const jumpToNewest = (): void => {
    setFollow(true);
    setScrollIndex(rows().length - 1);
  };

  const awayCount = createMemo(() => Math.max(0, rows().length - seenCount()));
  const jump = createMemo(() => failureJump(rows()));
  const failureContext = createMemo(() => {
    const anchorEvent = selectedRow() ? contextAnchor() : undefined;
    if (!anchorEvent) return undefined;
    const anchor = tail.records().find((record) => record.eventId === anchorEvent)
      ?? (search.state().data?.items ?? []).map(recordOfView).find((record) => record.eventId === anchorEvent);
    return anchor ? contextAround(rows(), anchor) : undefined;
  });

  const toggleSeverity = (severity: StreamSeverity): void => {
    const set = new Set(props.filters.severity);
    if (set.has(severity)) set.delete(severity); else set.add(severity);
    props.onPatch({ severity: [...set] });
  };
  const toggleEmitter = (emitter: StreamEmitter): void => {
    const set = new Set(props.filters.emitter);
    if (set.has(emitter)) set.delete(emitter); else set.add(emitter);
    props.onPatch({ emitter: [...set] });
  };

  const togglePause = (): void => {
    if (tail.paused()) tail.resume();
    else tail.pause();
  };

  return <div class="flex min-h-0 flex-1 flex-col gap-3">
    <LogFilters
      filters={props.filters}
      search={props.q() ?? ""}
      mode={props.mode}
      exportUrl={tail.exportUrl()}
      compareOpen={props.compareOpen}
      compareAvailable={Boolean(props.filters.job)}
      onToggleSeverity={toggleSeverity}
      onToggleEmitter={toggleEmitter}
      onSearch={(value) => props.onPatch({ q: value.trim().length > 0 ? value.trim() : undefined })}
      onSessionScope={(sessionId) => props.onPatch({ session: sessionId })}
      onRemoveScope={(axis) => props.onPatch({ [axis]: undefined } as FilterPatch)}
      onMode={props.onMode}
      onToggleCompare={props.onToggleCompare}
    />

    <FactStrip label="Log explorer status" items={[
      {
        label: searchActive() ? "Search matches" : "Records shown",
        value: searchActive() ? `${search.state().data?.totalEstimate ?? rows().length}` : `${rows().length}`,
        hint: searchActive()
          ? `${shownMatches()} of ~${search.state().data?.totalEstimate ?? shownMatches()} estimated matches; "Load older matches" pages deeper into the retained logs`
          : `bounded window of the stream (head ${tail.head()})`,
        icon: "lucide-scroll-text",
      },
      {
        label: "Stream",
        value: <Badge size="sm" variant="outline" theme={statusTheme("connection", tail.connected() ? "connected" : "reconnecting")}
          label={tail.connected() ? "Live" : searchActive() ? "Search view" : "Connecting"} />,
        hint: "cursor = stream_seq; reconnects from the last seen record",
        icon: "lucide-radio",
      },
      ...(tail.unread() > 0 ? [{
        label: "Unread",
        value: `${tail.unread()}`,
        hint: tail.droppedPending() > 0 ? `${tail.droppedPending()} older arrivals were dropped from the paused buffer` : "records that arrived while paused",
        icon: "lucide-bell",
      }] : []),
    ]} />

    <Show when={tail.status() === "error"}>
      <Alert theme="red" variant="outline" title="The log read could not complete" description={tail.error()}
        action={{ label: "Retry", onClick: () => void tail.reseed() }} />
    </Show>
    <Show when={searchActive() && (search.state().status === "no-access" || search.state().status === "retry" || search.state().status === "offline")}>
      <Alert theme="amber" variant="outline" title="Search could not complete"
        description={search.state().status === "no-access"
          ? "Your account no longer has access to these logs; the view was cleared."
          : search.state().error ?? "The search read failed; retry when Governor is reachable."}
        action={{ label: "Retry", onClick: () => void search.refresh({ force: true }) }} />
    </Show>
    <Show when={searchActive() && older().error}>
      <Alert theme="amber" variant="outline" title="Older matches could not be loaded" description={older().error}
        action={{ label: "Retry", onClick: () => void loadOlder() }} />
    </Show>

    <div ref={viewport} class="flex min-h-0 flex-1 flex-col">
      <Show when={rows().length > 0} fallback={
        <div class="grid min-h-40 place-items-center rounded-card border border-outline-gray-1 p-4 text-interface text-ink-gray-6" data-testid="log-empty">
          <Show when={tail.status() === "loading" && !searchActive()} fallback={<p>No log records match the current filters{searchActive() ? " — the search covers retained logs, so older matches may exist outside the window" : ""}.</p>}>
            <p role="status">Loading the newest authorized records…</p>
          </Show>
        </div>}>
        <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-outline-gray-1" data-testid="log-list">
          <VirtualLogList items={rows()} rowHeight={ROW_HEIGHT}
            itemKey={(row) => rowKey(row)}
            scrollToIndex={scrollIndex()}
            ariaLabel="Execution log records">
            {(row) => <LogRow row={row} mode={props.mode} selected={selectedKey() === rowKey(row)} onSelect={selectRow} />}
          </VirtualLogList>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Show when={!follow() || awayCount() > 0}>
            <Button size="md" variant="solid" theme="blue" data-testid="log-jump-newest" onClick={jumpToNewest}>
              Jump to newest{awayCount() > 0 ? ` (${awayCount()})` : ""}
            </Button>
          </Show>
          <Button size="md" variant={tail.paused() ? "solid" : "outline"} theme={tail.paused() ? "blue" : "gray"}
            iconLeft={tail.paused() ? "lucide-play" : "lucide-pause"}
            data-testid={tail.paused() ? "log-resume" : "log-pause"}
            onClick={togglePause}>
            {tail.paused() ? `Resume${tail.unread() > 0 ? ` (${tail.unread()} new)` : ""}` : "Pause"}
          </Button>
          <Show when={searchActive() && typeof oldestCursor() === "number"}>
            <Button size="md" variant="outline" theme="gray" iconLeft="lucide-arrow-down-to-line"
              data-testid="log-older" disabled={older().busy} loading={older().busy}
              onClick={() => void loadOlder()}>
              {`Load older matches${remainingMatches() > 0 ? ` (${remainingMatches()} more)` : ""}`}
            </Button>
          </Show>
          <Show when={jump()}>
            <Button size="md" variant="outline" theme="red" iconLeft="lucide-circle-alert"
              data-testid="log-jump-failure" onClick={jumpToFailure}>
              Jump to first failure
            </Button>
          </Show>
          <span class="text-caption text-ink-gray-6">
            {tail.paused()
              ? "Paused — new records are counted, not shown."
              : searchActive() ? "Showing retained search matches; the live tail resumes when the search clears." : "Live tail follows the stream while you are at its end."}
          </span>
        </div>
      </Show>

      <Show when={selectedRow()}>
        {(row) => <section class="mt-3 max-h-96 shrink-0 overflow-auto rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-card-pad" aria-label="Expanded log record" data-testid="log-detail">
          <Show when={row().kind === "tool"} fallback={<RecordDetail row={row()} mode={props.mode} />}>
            <ToolCallGroup group={row() as Extract<LogRowModel, { kind: "tool" }>} />
          </Show>
          <Show when={failureContext()}>
            <div class="mt-3">
              <h3 class="text-base-medium text-ink-gray-8">Surrounding context of the first failure</h3>
              <div class="mt-1">
                <ContextLines records={failureContext()!} />
              </div>
            </div>
          </Show>
        </section>}
      </Show>
    </div>
  </div>;
}

/** One selected single/repeat record, expanded beside the list in the current mode. */
function RecordDetail(props: { row: LogRowModel; mode: LogViewMode }): JSX.Element {
  const app = useApp();
  const record = () => (props.row.kind === "tool" ? props.row.members[0]! : props.row.record);
  const members = () => (props.row.kind === "repeat" ? props.row.members.length : 1);
  // P0 cross-navigation: a plain record's approval/artifact linkage is not in
  // its correlation column — stream.context resolves it (the aggregate
  // reference, the invocation's permit, CAS digests), so resolve it when a
  // record opens, exactly like the tool-call expansion does.
  const context = createScopedRead<StreamContextBundle>({
    scope: app.scope,
    resource: () => record().eventId,
    load: (_scope, signal, resource) => streamContextQuery(resource ?? "", signal),
    isEmpty: () => false,
  });
  const approval = () => context.state().data?.approval;
  const artifacts = () => context.state().data?.artifacts ?? [];
  return <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="brain-exec-log text-base-medium text-ink-gray-9">{record().type}</span>
      <Badge size="sm" variant="outline" theme="gray" label={severityLabel(record().severity)} />
      <Badge size="sm" variant="outline" theme="gray" label={record().emitter} />
      <span class="text-caption text-ink-gray-6">
        stream_seq {record().streamSeq} · <AbsoluteTime at={record().at} />
        <Show when={record().tsApproximate}> · time set at projection</Show>
      </span>
    </div>
    <p class="brain-exec-log break-words text-ink-gray-8">{streamSummaryText(record().summary, 2000)}</p>
    <div class="flex flex-wrap items-center gap-1" data-testid="log-detail-links">
      <CorrelationChips correlation={record().correlation} />
      <Show when={approval()}>{(linked) => (
        <CorrelationLink target={{ kind: "approval", approvalId: linked().approvalId }}
          label={`approval ${linked().approvalId.slice(0, 11)}…`} icon="lucide-shield-check" />
      )}</Show>
      <For each={artifacts()}>{(artifact) => (
        <CorrelationLink target={{ kind: "artifact", artifactId: artifact.artifactId }}
          label={`${artifact.mediaType} · ${shortDigest(artifact.digest, 8)}`} icon="lucide-package" />
      )}</For>
    </div>
    <Show when={members() > 1}>
      <p class="text-caption text-ink-gray-6">{members()} consecutive identical records collapsed into this row.</p>
    </Show>
    <DisclosureCard label="Raw record (original redacted record with timestamps, sequence and payload reference)">
      <pre class="brain-exec-log max-h-72 overflow-auto text-ink-gray-7">{JSON.stringify({
        streamSeq: record().streamSeq,
        eventId: record().eventId,
        at: record().at,
        tsApproximate: record().tsApproximate || undefined,
        emitter: record().emitter,
        severity: record().severity ?? undefined,
        correlation: record().correlation,
        payloadRef: record().payloadRef,
        summary: record().summary,
      }, null, 2)}</pre>
    </DisclosureCard>
  </div>;
}

function AbsoluteTime(props: { at: string }): JSX.Element {
  const date = new Date(props.at);
  return <span title={props.at}>{Number.isFinite(date.getTime()) ? date.toLocaleString() : props.at}</span>;
}

export function LogExplorer(): JSX.Element {
  const app = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setMode] = createSignal<LogViewMode>("readable");
  const [compareOpen, setCompareOpen] = createSignal(false);

  const filters = createMemo(() => readExecFilters(searchParams as Record<string, string | string[] | undefined>));
  const patch = (update: FilterPatch): void => {
    setSearchParams(writeExecFilters({ ...filters(), ...update } as ExecLogFilters), { replace: true });
  };

  // The tail remounts when its connection axes change (workspace, correlation
  // scope, severities, emitters); the search text, the deep-linked entry and
  // the presentation mode deliberately do not remount it.
  const axesKey = createMemo(() => JSON.stringify({ ws: app.workspaceId(), ...tailAxes(filters()) }));

  return <div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="log-explorer">
    <Show when={axesKey()} keyed>
      {(key) => {
        void key;
        const current = filters();
        return <TailSurface
          workspaceId={app.workspaceId()}
          axes={tailAxes(current)}
          filters={current}
          q={() => filters().q}
          entry={current.entry}
          mode={mode()}
          compareOpen={compareOpen()}
          onPatch={patch}
          onMode={setMode}
          onToggleCompare={() => setCompareOpen((value) => !value)}
        />;
      }}
    </Show>
    <Show when={compareOpen()}>
      <Show when={filters().job} fallback={
        <p class="rounded-card border border-outline-gray-1 p-card-pad text-interface text-ink-gray-6">
          Attempt comparison needs a job scope — open a job's records from a run or a correlation chip, then compare its attempts.
        </p>}>
        {(job) => <AttemptCompare jobId={job()} onOpenAttempt={(attemptId) => patch({ attempt: attemptId })} />}
      </Show>
    </Show>
  </div>;
}
