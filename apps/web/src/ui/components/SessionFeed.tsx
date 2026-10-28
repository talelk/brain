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

  let lastLength = 0;
  createEffect(() => {
    const length = rows().length;
    if (length > lastLength) {
      const arrived = length - lastLength;
      lastLength = length;
      if (follow()) setNewCount(0);
      else setNewCount((n) => n + arrived);
    }
  });
  onCleanup(() => { lastLength = 0; });

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
              <Button onClick={() => { setFollow(true); setNewCount(0); }}>
                Jump to newest{newCount() > 0 ? ` (${newCount()})` : ""}
              </Button>
            </Show>
            <Button variant={follow() ? "solid" : "outline"} onClick={() => setFollow((f) => !f)}>
              {follow() ? "Following" : "Follow"}
            </Button>
          </div>
        </div>

        <VirtualList items={rows()} label={`Live events for session ${props.sessionId}`} itemSize={64} height="28rem"
          loading={props.state.status === "loading"} emptyTitle="No events yet"
          emptyDescription="Tool and state events stream in while this session runs.">
          {(row) => (
            <div class="flex h-full items-start gap-2 border-b border-outline-gray-1 py-2">
              <Badge theme={row.kind === "tool" ? "blue" : row.kind === "state" ? "green" : "gray"} label={row.kind} />
              <div class="min-w-0">
                <p class="truncate text-base-medium text-ink-gray-9">{row.title}</p>
                <p class="truncate text-caption text-ink-gray-7">{row.detail} · {new Date(row.at).toLocaleTimeString()}</p>
              </div>
            </div>
          )}
        </VirtualList>

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
