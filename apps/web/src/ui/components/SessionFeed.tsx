import type { JSX } from "solid-js";
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Badge, Button, Textarea } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { VirtualList } from "@talelk/newui-organisms";
import type { SessionView } from "@brain/contracts";
import type { ScreenState } from "../../data/screens";
import { createEventStream } from "../../data/screens";
import { ScreenRegion } from "../screen-region";

interface FeedRow { id: string; kind: "tool" | "state" | "message"; title: string; detail: string; at: string; }

/**
 * The bounded live session feed (document 21 session oracle).
 *
 * Events come from the durable SSE replay path, are coalesced into one state
 * update per burst, and the mounted DOM stays bounded by `VirtualList`. Scrolling
 * away from the bottom pauses follow; the new-event count and the jump control
 * bring the reader back, and a reset frame forces a full snapshot re-read
 * instead of trusting replayed authority.
 */
export function SessionFeed(props: {
  sessionId: string;
  session?: SessionView;
  state: ScreenState<SessionView>;
  onRefresh: () => void;
  onSteer: (message: string) => Promise<void>;
  onStop: (reason: string) => Promise<void>;
}): JSX.Element {
  const [follow, setFollow] = createSignal(true);
  const [message, setMessage] = createSignal("");
  const [stopReason, setStopReason] = createSignal("");
  const [newCount, setNewCount] = createSignal(0);
  const stream = createEventStream({ enabled: () => true, after: props.session?.lastEventSequence });

  // A reset frame means the client fell behind the durable cursor: re-read the
  // snapshot and drop replayed rows rather than re-applying them.
  createEffect(() => { if (stream.resetRequired()) { props.onRefresh(); stream.resetRequired(); } });

  const rows = createMemo<FeedRow[]>(() => {
    const grouped = new Map<string, FeedRow>();
    for (const event of stream.events()) {
      if (event.type.startsWith("tool.")) {
        const key = `tool:${event.aggregateId ?? event.id}`;
        grouped.set(key, { id: key, kind: "tool", title: `${event.type.replace("tool.", "")} tool`, detail: event.aggregateId ?? event.id, at: event.at });
      } else if (event.type.startsWith("session.")) {
        grouped.set(event.id, { id: event.id, kind: "state", title: event.type, detail: "session state", at: event.at });
      } else {
        grouped.set(event.id, { id: event.id, kind: "message", title: event.type, detail: event.aggregateId ?? "", at: event.at });
      }
    }
    return [...grouped.values()].sort((a, b) => a.at < b.at ? 1 : -1);
  });

  let lastSeqSeen = 0;
  let feedWrap: HTMLDivElement | undefined;
  let selectionSnapshot: { eventId: string; start: number; end: number } | undefined;
  const ITEM_SIZE = 64;
  const scrollRegion = (): HTMLElement | undefined =>
    feedWrap?.querySelector('[data-slot="virtual-list"]') as HTMLElement | undefined;
  const eventRow = (node: Node | null): HTMLElement | null => {
    const element = node instanceof Element ? node : node?.parentElement;
    const row = element?.closest<HTMLElement>("[data-event-id]") ?? null;
    return row && feedWrap?.contains(row) ? row : null;
  };
  const offsetWithin = (row: HTMLElement, node: Node, offset: number): number => {
    const range = document.createRange();
    range.selectNodeContents(row);
    range.setEnd(node, offset);
    return range.toString().length;
  };
  const textPosition = (row: HTMLElement, offset: number): { node: Node; offset: number } => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
    }
    return { node: row, offset: row.childNodes.length };
  };
  const onSelectionChange = (): void => {
    const selection = window.getSelection();
    const anchorRow = eventRow(selection?.anchorNode ?? null);
    const focusRow = eventRow(selection?.focusNode ?? null);
    if (!selection || selection.isCollapsed || !anchorRow || anchorRow !== focusRow || !selection.anchorNode || !selection.focusNode) {
      selectionSnapshot = undefined;
      return;
    }
    const anchor = offsetWithin(anchorRow, selection.anchorNode, selection.anchorOffset);
    const focus = offsetWithin(anchorRow, selection.focusNode, selection.focusOffset);
    selectionSnapshot = { eventId: anchorRow.dataset["eventId"]!, start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  };
  document.addEventListener("selectionchange", onSelectionChange);
  onCleanup(() => document.removeEventListener("selectionchange", onSelectionChange));
  createEffect(() => {
    rows();
    const snapshot = selectionSnapshot;
    if (!snapshot) return;
    const row = feedWrap?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(snapshot.eventId)}"]`);
    if (!row) return;
    const start = textPosition(row, snapshot.start);
    const end = textPosition(row, snapshot.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  // Scrolling away from the newest end pauses follow; returning to the top
  // resumes it. New rows prepend (newest first), so staying at the top is
  // staying current. Re-runs when the list mounts (rows go from empty to
  // streaming, at which point the virtualiser viewport exists).
  createEffect(() => {
    void rows().length;
    const el = scrollRegion();
    if (!el) return;
    const onScroll = (): void => {
      const away = el.scrollTop > ITEM_SIZE;
      if (away && follow()) setFollow(false);
      else if (!away && !follow()) { setFollow(true); setNewCount(0); }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => el.removeEventListener("scroll", onScroll));
  });

  // Arrivals are measured on the authoritative stream cursor, not the capped
  // client buffer, so a burst beyond the retention window still counts.
  createEffect(() => {
    const seq = stream.lastSequence();
    if (lastSeqSeen === 0) { lastSeqSeen = seq; return; }
    const arrived = seq - lastSeqSeen;
    lastSeqSeen = seq;
    if (arrived <= 0) return;
    if (follow()) setNewCount(0);
    else {
      setNewCount((n) => n + arrived);
      // Prepending shifts what the reader is looking at; compensate so the
      // viewport and any text selection stay pinned where they were.
      const el = scrollRegion();
      if (el) el.scrollTop += arrived * ITEM_SIZE;
    }
  });
  onCleanup(() => { lastSeqSeen = 0; });

  const terminal = () => props.session?.state === "stopped" || props.session?.state === "failed";

  return (
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Session not found"
      emptyDescription="It may have been closed and archived, or the link belongs to another workspace."
      emptyAction={<Button onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <div class="flex flex-col gap-field-gap">
        <div class="flex flex-wrap items-center justify-between gap-control-gap">
          <div class="flex items-center gap-control-gap">
            <Badge theme={stream.connected() ? "green" : "amber"} label={stream.connected() ? "live" : "reconnecting"} />
            <Badge label={props.session?.state ?? "unknown"} />
            <span class="text-caption text-ink-gray-7">{stream.lastSequence()} events · {props.session?.usedTokens ?? 0} tokens · {(props.session?.usedMicroUsd ?? 0) / 1_000_000} USD</span>
          </div>
          <div class="flex items-center gap-control-gap">
            <Show when={!follow()}>
              <Button onClick={() => { setFollow(true); setNewCount(0); scrollRegion()?.scrollTo({ top: 0 }); }}>
                Jump to newest{newCount() > 0 ? ` (${newCount()})` : ""}
              </Button>
            </Show>
            <Button variant={follow() ? "solid" : "outline"} onClick={() => setFollow((f) => !f)}>
              {follow() ? "Following" : "Follow"}
            </Button>
          </div>
        </div>

        <div ref={feedWrap}>
          <VirtualList items={rows()} label={`Live events for session ${props.sessionId}`} itemSize={ITEM_SIZE} height="28rem"
            loading={props.state.status === "loading"} emptyTitle="No events yet"
            emptyDescription="Tool and state events stream in while this session runs.">
            {(row) => (
              <div data-event-id={row.id} class="flex h-full items-start gap-2 border-b border-outline-gray-1 py-2">
                <Badge theme={row.kind === "tool" ? "blue" : row.kind === "state" ? "green" : "gray"} label={row.kind} />
                <div class="min-w-0">
                  <p class="truncate text-base-medium text-ink-gray-9">{row.title}</p>
                  <p class="truncate text-caption text-ink-gray-7">{row.detail} · {new Date(row.at).toLocaleTimeString()}</p>
                </div>
              </div>
            )}
          </VirtualList>
        </div>

        <Show when={!terminal()} fallback={
          <Alert theme="gray" variant="outline" title={`Session ${props.session?.state ?? "closed"}`} description="Steering and stopping are unavailable once the session is terminal." />
        }>
          <div class="flex flex-col gap-field-gap rounded-card border border-outline-gray-2 p-card-pad">
            <Textarea label="Steer this session" value={message()} description="An authoritative steering message is recorded for the exact session." onInput={(e) => setMessage(e.currentTarget.value)} />
            <div class="flex flex-wrap gap-control-gap">
              <Button onClick={() => void props.onSteer(message().trim())} disabled={message().trim().length === 0}>Send steering</Button>
              <Textarea label="Stop reason" value={stopReason()} onInput={(e) => setStopReason(e.currentTarget.value)} />
              <Button variant="outline" theme="red" onClick={() => void props.onStop(stopReason().trim())} disabled={stopReason().trim().length === 0}>Stop session</Button>
            </div>
          </div>
        </Show>
      </div>
    </ScreenRegion>
  );
}
