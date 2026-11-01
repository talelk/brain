import type { JSX } from "solid-js";
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Badge, Button, KeyValue, Textarea } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { VirtualList } from "@talelk/newui-organisms";
import type { BrainSession } from "@brain/contracts";
import type { ScreenState } from "../../data/screens";
import { createEventStream } from "../../data/screens";
import type { StreamEvent } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { BrainPage, PageStack } from "./PageLayout";
import { StatusBadge, statusTheme } from "./StatusBadge";
import { formatMicroUsd } from "../format";
import { DateText, RelativeTime } from "../screen-region";
import { ReasonDialog } from "./ReasonDialog";
import { RefreshButton } from "./primitives";
import { DetailAside, FactStrip, WorkspaceSection } from "./Domain";
import { useApp } from "../app-context";

interface FeedRow { id: string; kind: "tool" | "state" | "message"; title: string; detail: string; at: string; status: string; raw: string; }

function payloadObject(event: StreamEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
}

function eventSummary(event: StreamEvent): string {
  const payload = payloadObject(event);
  if (typeof payload["text"] === "string") return payload["text"];
  if (typeof payload["n"] !== "undefined") return `Model event ${String(payload["n"])}`;
  if (payload["input"] !== undefined) return `Input ${JSON.stringify(payload["input"])}`;
  const receipt = payload["receipt"];
  if (receipt && typeof receipt === "object") return `Result ${String((receipt as Record<string, unknown>)["result"] ?? "recorded")}`;
  return event.aggregateId ? `Activity for ${event.aggregateId}` : "Session state changed";
}

function toolTitle(event: StreamEvent): string {
  const payload = payloadObject(event);
  const tool = payload["tool"];
  if (tool && typeof tool === "object" && typeof (tool as Record<string, unknown>)["id"] === "string") return String((tool as Record<string, unknown>)["id"]);
  return `${event.type.replace("tool.", "").replaceAll("-", " ")} tool`;
}

export function SessionFeed(props: {
  sessionId: string;
  session?: BrainSession;
  state: ScreenState<BrainSession>;
  onRefresh: () => void;
  onSteer: (message: string) => Promise<void>;
  onStop: (reason: string) => Promise<void>;
}): JSX.Element {
  const app = useApp();
  const [follow, setFollow] = createSignal(true);
  const [message, setMessage] = createSignal("");
  const [stopReason, setStopReason] = createSignal("");
  const [stopOpen, setStopOpen] = createSignal(false);
  const [newCount, setNewCount] = createSignal(0);
  const stream = createEventStream({ enabled: () => true, after: props.session?.lastEventSequence });
  createEffect(() => { if (stream.resetRequired()) props.onRefresh(); });

  const rows = createMemo<FeedRow[]>(() => {
    const grouped = new Map<string, FeedRow>();
    for (const event of stream.events()) {
      if (event.type.startsWith("tool.")) {
        const payload = payloadObject(event);
        const proposal = typeof payload["proposalId"] === "string" ? payload["proposalId"] : event.aggregateId ?? event.id;
        const key = `tool:${proposal}`;
        const previous = grouped.get(key);
        grouped.set(key, { id: key, kind: "tool", title: toolTitle(event), detail: eventSummary(event), at: event.at, status: event.type.replace("tool.", ""), raw: JSON.stringify(event.payload ?? {}, null, 2) });
        if (previous && event.at < previous.at) grouped.set(key, { ...grouped.get(key)!, at: previous.at });
      } else if (event.type.startsWith("session.")) {
        grouped.set(event.id, { id: event.id, kind: "state", title: event.type.replace("session.", "Session ").replaceAll("-", " "), detail: eventSummary(event), at: event.at, status: "authoritative", raw: JSON.stringify(event.payload ?? {}, null, 2) });
      } else {
        grouped.set(event.id, { id: event.id, kind: "message", title: "Model activity", detail: eventSummary(event), at: event.at, status: "not completion evidence", raw: JSON.stringify(event.payload ?? {}, null, 2) });
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
  const stopping = () => props.session?.state === "stopping";
  const terminal = () => stopping() || props.session?.state === "stopped" || props.session?.state === "failed";
  const features = () => props.session?.engine.features ?? [];
  const canControl = () => app.canDispatch() && props.state.canMutate;
  const canSteer = () => !terminal() && canControl() && features().some((feature) => ["steer", "steering"].includes(feature));
  const canStop = () => !terminal() && canControl() && features().some((feature) => ["stop", "cancel", "cancellation"].includes(feature));

  return <BrainPage title="Live session" description={props.session?.task ?? "Follow authoritative model activity and its executing session."}
    breadcrumbs={[{ label: "Activity" }, { label: "Live session" }]}
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={canStop()}><Button size="lg" variant="outline" theme="red" iconLeft="lucide-square" onClick={() => setStopOpen(true)}>Stop session</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Session not found"
      emptyDescription="It may have been closed and archived, or the link belongs to another workspace."
      emptyAction={<Button size="lg" onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <div class="brain-session-status"><FactStrip label="Live session status" items={[
          { label: "Session state", value: <StatusBadge status={props.session?.state ?? "unknown"} />, hint: props.session?.engine.id ?? "Engine unavailable", icon: "lucide-activity" },
          { label: "Connection", value: <Badge theme={statusTheme("connection", stream.connected() ? "connected" : "reconnecting")} label={stream.connected() ? "Live replay" : "Reconnecting"} />, hint: "Durable SSE cursor", icon: "lucide-radio" },
          { label: "Usage", value: `${(props.session?.usedTokens ?? 0).toLocaleString()} tokens`, hint: `${formatMicroUsd(props.session?.usedMicroUsd)} used · ${formatMicroUsd(props.session?.reservedMicroUsd)} reserved`, icon: "lucide-gauge" },
          { label: "Replayed events", value: `${stream.lastSequence()} events`, hint: `${rows().length} bounded visible activities`, icon: "lucide-list-tree" },
        ]} /></div>
        <Show when={stopping()}><Alert theme="amber" variant="outline" title="Stop requested" description="The session remains stopping until the executing authority acknowledges termination. It is not shown as completed yet." /></Show>
        <div class="brain-run-layout">
          <div class="brain-detail-stack">
            <WorkspaceSection title="Agent activity" description="Model activity is not proof of completion. Tool calls group by proposal and retain their exact event payload on demand." actions={<div class="flex items-center gap-2"><Show when={!follow()}><Button variant="solid" theme="blue" size="sm" onClick={() => { setFollow(true); setNewCount(0); scrollRegion()?.scrollTo({ top: 0 }); }}>Jump to newest{newCount() > 0 ? ` (${newCount()})` : ""}</Button></Show><Button variant={follow() ? "solid" : "outline"} theme={follow() ? "blue" : "gray"} size="sm" onClick={() => setFollow((value) => !value)}>{follow() ? "Following" : "Follow"}</Button></div>}>
              <div ref={feedWrap} class="mt-3">
                <VirtualList items={rows()} label={`Live events for session ${props.sessionId}`} itemSize={ITEM_SIZE} height="32rem"
                  loading={props.state.status === "loading"} emptyTitle="No events yet" emptyDescription="Tool and state events stream in while this session runs.">
                  {(row) => <div data-event-id={row.id} class="relative flex h-full items-start gap-3 border-b border-outline-gray-1 py-2">
                    <span class={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-control ${row.kind === "tool" ? "bg-surface-blue-2 text-ink-blue-8" : row.kind === "state" ? "bg-surface-green-2 text-ink-green-8" : "bg-surface-gray-2 text-ink-gray-7"}`}><span class={`${row.kind === "tool" ? "lucide-wrench" : row.kind === "state" ? "lucide-activity" : "lucide-message-square"} size-4`} aria-hidden="true" /></span>
                    <div class="min-w-0 flex-1"><details><summary class="cursor-pointer list-none"><span class="flex items-center gap-2"><span class="truncate text-base-medium text-ink-gray-9">{row.title}</span><Badge size="sm" variant="outline" theme={row.kind === "state" ? "green" : "gray"} label={row.status} /></span></summary><pre class="absolute inset-x-0 top-full z-floating max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-card border border-outline-gray-1 bg-surface-elevation-2 p-4 text-caption shadow-lg">{row.raw}</pre></details><p class="mt-1 truncate text-caption text-ink-gray-6">{row.detail} · <RelativeTime value={row.at} /></p></div>
                  </div>}
                </VirtualList>
              </div>
            </WorkspaceSection>
            <Show when={canSteer()}><WorkspaceSection title="Steer this session" description="Send one authoritative message to this exact running session.">
              <form class="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (message().trim()) void props.onSteer(message().trim()).then(() => setMessage("")); }}>
                <Textarea label="Steering message" value={message()} placeholder="Add context or redirect the next step…" onInput={(event) => setMessage(event.currentTarget.value)} />
                <Button size="lg" type="submit" variant="solid" theme="blue" iconLeft="lucide-send" class="self-start" disabled={!message().trim()}>Send steering</Button>
              </form>
            </WorkspaceSection></Show>
            <Show when={terminal()} fallback={<Show when={!canSteer() && !canStop()}><Alert theme="gray" variant="outline" title="Read-only session" description="This engine did not negotiate steering or cancellation for your current authorization, or the session snapshot is stale." /></Show>}><Alert theme="gray" variant="outline" title={`Session ${props.session?.state ?? "closed"}`} description="Steering and stopping are unavailable while stop is pending or after the session becomes terminal." /></Show>
          </div>
          <DetailAside title="Session context" description="Engine, budget, lineage and recovery facts." sticky>
            <KeyValue label="Agent" value={props.session?.agentId ?? "—"} orientation="vertical" />
            <KeyValue label="Engine" value={`${props.session?.engine.id ?? "—"} ${props.session?.engine.version ?? ""}`} orientation="vertical" />
            <KeyValue label="Budget" value={`${props.session?.budget.maxTurns ?? "—"} turns · ${(props.session?.budget.maxTokens ?? 0).toLocaleString()} tokens`} orientation="vertical" />
            <KeyValue label="Work item" value={props.session?.workItemId ?? "Unlinked"} orientation="vertical" />
            <KeyValue label="Updated" value={<DateText value={props.session?.updatedAt} />} orientation="vertical" />
            <Show when={props.session?.mode === "managed"}><div class="grid gap-3 border-y border-outline-gray-1 py-4 text-interface"><p>Delegation depth {props.session?.delegationDepth} of 3</p><p class="break-all">Worktree {props.session?.worktreeId}</p><p class="break-all">Parent {props.session?.parentSessionId ?? "Root session"}</p></div></Show>
            <Show when={props.session?.checkpoint}>{(checkpoint) => <div><h3 class="text-base-medium">Checkpoint next action</h3><p class="mt-2 text-interface text-ink-gray-7">{checkpoint().nextAction}</p></div>}</Show>
          </DetailAside>
        </div>
      </PageStack>
      <ReasonDialog open={stopOpen()} onClose={() => setStopOpen(false)}
        title="Stop this session" description="Stopping is an authoritative command. Provide a reason for the operational record; completion waits for acknowledgement."
        reason={stopReason()} onReason={setStopReason} reasonLabel="Stop reason" confirmLabel="Stop session" tone="red"
        onConfirm={(value) => void props.onStop(value).then(() => { setStopOpen(false); setStopReason(""); })} />
    </ScreenRegion>
  </BrainPage>;
}
