import type { JSX } from "solid-js";
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Badge, Button, Textarea } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { Section, VirtualList } from "@talelk/newui-organisms";
import type { BrainSession } from "@brain/contracts";
import type { ScreenState } from "../../data/screens";
import { createEventStream } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { BrainPage, PageStack } from "./PageLayout";
import { statusTheme } from "./StatusBadge";
import { formatMicroUsd } from "../format";
import { RelativeTime } from "../screen-region";
import { ReasonDialog } from "./ReasonDialog";
import { RefreshButton } from "./primitives";

interface FeedRow { id: string; kind: "tool" | "state" | "message"; title: string; detail: string; at: string; }

export function SessionFeed(props: {
  sessionId: string;
  session?: BrainSession;
  state: ScreenState<BrainSession>;
  onRefresh: () => void;
  onSteer: (message: string) => Promise<void>;
  onStop: (reason: string) => Promise<void>;
}): JSX.Element {
  const [follow, setFollow] = createSignal(true);
  const [message, setMessage] = createSignal("");
  const [stopReason, setStopReason] = createSignal("");
  const [stopOpen, setStopOpen] = createSignal(false);
  const [newCount, setNewCount] = createSignal(0);
  const stream = createEventStream({ enabled: () => true, after: props.session?.lastEventSequence });
  createEffect(() => { if (stream.resetRequired()) { props.onRefresh(); stream.resetRequired(); } });

  const rows = createMemo<FeedRow[]>(() => {
    const grouped = new Map<string, FeedRow>();
    for (const event of stream.events()) {
      if (event.type.startsWith("tool.")) {
        const key = `tool:${event.aggregateId ?? event.id}`;
        grouped.set(key, { id: key, kind: "tool", title: `${event.type.replace("tool.", "")} tool`, detail: event.aggregateId ?? event.id, at: event.at });
      } else if (event.type.startsWith("session.")) {
        grouped.set(event.id, { id: event.id, kind: "state", title: event.type, detail: "Session state changed", at: event.at });
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
  const scrollRegion = (): HTMLElement | undefined => feedWrap?.querySelector('[data-slot="virtual-list"]') as HTMLElement | undefined;
  const eventRow = (node: Node | null): HTMLElement | null => {
    const element = node instanceof Element ? node : node?.parentElement;
    const row = element?.closest<HTMLElement>("[data-event-id]") ?? null;
    return row && feedWrap?.contains(row) ? row : null;
  };
  const offsetWithin = (row: HTMLElement, node: Node, offset: number): number => {
    const range = document.createRange(); range.selectNodeContents(row); range.setEnd(node, offset); return range.toString().length;
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
      selectionSnapshot = undefined; return;
    }
    const anchor = offsetWithin(anchorRow, selection.anchorNode, selection.anchorOffset);
    const focus = offsetWithin(focusRow, selection.focusNode, selection.focusOffset);
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
    const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  createEffect(() => {
    void rows().length;
    const element = scrollRegion();
    if (!element) return;
    const onScroll = (): void => {
      const away = element.scrollTop > ITEM_SIZE;
      if (away && follow()) setFollow(false);
      else if (!away && !follow()) { setFollow(true); setNewCount(0); }
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => element.removeEventListener("scroll", onScroll));
  });
  createEffect(() => {
    const sequence = stream.lastSequence();
    if (lastSeqSeen === 0) { lastSeqSeen = sequence; return; }
    const arrived = sequence - lastSeqSeen;
    lastSeqSeen = sequence;
    if (arrived <= 0) return;
    if (follow()) setNewCount(0);
    else {
      setNewCount((count) => count + arrived);
      const element = scrollRegion();
      if (element) element.scrollTop += arrived * ITEM_SIZE;
    }
  });
  onCleanup(() => { lastSeqSeen = 0; });
  const terminal = () => props.session?.state === "stopped" || props.session?.state === "failed";

  return <BrainPage title="Live session" description={props.session?.task ?? "Follow authoritative model activity and steer the active session."}
    breadcrumbs={[{ label: "Activity" }, { label: "Live session" }]}
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={!terminal()}><Button size="lg" variant="outline" theme="red" iconLeft="lucide-square" onClick={() => setStopOpen(true)}>Stop session</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Session not found"
      emptyDescription="It may have been closed and archived, or the link belongs to another workspace."
      emptyAction={<Button size="lg" onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <Show when={props.session?.mode === "managed" ? props.session : undefined}>
          {(current) => <Section title="Collaboration" description="Managed lineage, ownership and portable recovery facts." surface="card">
            <dl class="grid gap-3 text-base sm:grid-cols-2 lg:grid-cols-3">
              <div><dt class="text-caption text-ink-gray-6">Agent</dt><dd class="break-words">{current().agentId}</dd></div>
              <div><dt class="text-caption text-ink-gray-6">Work item</dt><dd class="break-words">{current().workItemId ?? "Unlinked"}</dd></div>
              <div><dt class="text-caption text-ink-gray-6">Worktree</dt><dd class="break-words">{current().worktreeId}</dd></div>
              <div><dt class="text-caption text-ink-gray-6">Delegation</dt><dd>Depth {current().delegationDepth} of 3</dd></div>
              <div><dt class="text-caption text-ink-gray-6">Parent session</dt><dd class="break-words">{current().parentSessionId ?? "Root session"}</dd></div>
              <div><dt class="text-caption text-ink-gray-6">Budget</dt><dd>{current().budget.maxTurns} turns · {current().budget.maxTokens} tokens</dd></div>
            </dl>
            <Show when={current().checkpoint}>
              {(checkpoint) => <p class="mt-4 border-t border-outline-gray-1 pt-3 text-base text-ink-gray-7"><span class="text-base-medium">Checkpoint next action:</span> {checkpoint().nextAction}</p>}
            </Show>
          </Section>}
        </Show>
        <Section title="Session activity" surface="card" toolbar={<div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2"><Badge theme={statusTheme("connection", stream.connected() ? "connected" : "reconnecting")} label={stream.connected() ? "Live" : "Reconnecting"} /><Badge label={props.session?.state ?? "unknown"} /><span class="text-caption tabular-nums text-ink-gray-6">{stream.lastSequence()} events · {props.session?.usedTokens ?? 0} tokens · {formatMicroUsd(props.session?.usedMicroUsd)}</span></div>
          <div class="flex items-center gap-2"><Show when={!follow()}><Button variant="solid" theme="blue" size="sm" onClick={() => { setFollow(true); setNewCount(0); scrollRegion()?.scrollTo({ top: 0 }); }}>Jump to newest{newCount() > 0 ? ` (${newCount()})` : ""}</Button></Show><Button variant={follow() ? "solid" : "outline"} theme={follow() ? "blue" : "gray"} size="sm" onClick={() => setFollow((value) => !value)}>{follow() ? "Following" : "Follow"}</Button></div>
        </div>}>
          <div ref={feedWrap} class="mt-3">
            <VirtualList items={rows()} label={`Live events for session ${props.sessionId}`} itemSize={ITEM_SIZE} height="30rem"
              loading={props.state.status === "loading"} emptyTitle="No events yet" emptyDescription="Tool and state events stream in while this session runs.">
              {(row) => <div data-event-id={row.id} class="flex h-full items-start gap-3 border-b border-outline-gray-1 py-2">
                <span class={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-control ${row.kind === "tool" ? "bg-surface-blue-2 text-ink-blue-8" : row.kind === "state" ? "bg-surface-green-2 text-ink-green-8" : "bg-surface-gray-2 text-ink-gray-7"}`}><span class={`${row.kind === "tool" ? "lucide-wrench" : row.kind === "state" ? "lucide-activity" : "lucide-message-square"} size-4`} aria-hidden="true" /></span>
                <div class="min-w-0"><p class="truncate text-base-medium text-ink-gray-9">{row.title}</p><p class="truncate text-caption text-ink-gray-6">{row.detail} · <RelativeTime value={row.at} /></p></div>
              </div>}
            </VirtualList>
          </div>
        </Section>
        <Show when={!terminal()} fallback={<Alert theme="gray" variant="outline" title={`Session ${props.session?.state ?? "closed"}`} description="Steering and stopping are unavailable once the session is terminal." />}>
          <Section title="Steer this session" description="Send an authoritative message to this exact session." surface="card">
            <form class="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (message().trim()) void props.onSteer(message().trim()).then(() => setMessage("")); }}>
              <Textarea label="Steering message" value={message()} placeholder="Add context or redirect the next step…" onInput={(event) => setMessage(event.currentTarget.value)} />
              <Button size="lg" type="submit" variant="solid" theme="blue" iconLeft="lucide-send" class="self-start" disabled={!message().trim()}>Send steering</Button>
            </form>
          </Section>
        </Show>
      </PageStack>
      <ReasonDialog open={stopOpen()} onClose={() => setStopOpen(false)}
        title="Stop this session" description="Stopping is an authoritative command. Provide a reason for the operational record."
        reason={stopReason()} onReason={setStopReason} reasonLabel="Stop reason" confirmLabel="Stop session" tone="red"
        onConfirm={(value) => void props.onStop(value).then(() => { setStopOpen(false); setStopReason(""); })} />
    </ScreenRegion>
  </BrainPage>;
}
