import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { SessionDetail } from "../../data/exec-console";
import type { FeedEntry } from "./ConsoleFeed";
import { Button } from "@talelk/newui-atoms";

/** What the feed has seen so far, reported upward so the header can say what the session is doing. */
export interface FeedActivity {
  readonly latest?: FeedEntry;
  readonly lastTool?: FeedEntry;
  readonly lastMessage?: FeedEntry;
  readonly toolCalls: number;
  readonly firstAt?: string;
}

export const NO_ACTIVITY: FeedActivity = { toolCalls: 0 };

export function summarizeActivity(entries: readonly FeedEntry[]): FeedActivity {
  let lastTool: FeedEntry | undefined;
  let lastMessage: FeedEntry | undefined;
  let toolCalls = 0;
  for (const entry of entries) {
    if (entry.kind === "tool") { lastTool = entry; toolCalls += 1; }
    else if (entry.kind === "message" && entry.type === "text") lastMessage = entry;
  }
  const latest = entries.at(-1);
  return { ...(latest ? { latest } : {}), ...(lastTool ? { lastTool } : {}), ...(lastMessage ? { lastMessage } : {}), toolCalls, ...(entries[0] ? { firstAt: entries[0].at } : {}) };
}

/** The plain sentence for the session's current condition, built from its latest tool and message. */
export function nowSentence(session: SessionDetail | undefined, activity: FeedActivity): string {
  const state = session?.state;
  if (state === "failed") return "This session stopped because of an error. The last activity is listed below.";
  if (state === "stopped") return "This session has finished. Its full transcript is below.";
  if (state === "stopping") return "A stop was requested; the session is wrapping up.";
  if (state === "starting") return "The agent is starting up and will begin working shortly.";
  if (state === "waiting") return "The agent is waiting for a person before it continues.";
  const tool = activity.lastTool;
  const message = activity.lastMessage;
  if (tool && (!message || tool.streamSeq > message.streamSeq)) {
    const name = tool.tool?.name ?? "a tool";
    return tool.tool?.result ? `Ran ${name}; deciding the next step.` : `Running ${name}…`;
  }
  if (message) return "Writing an update; the latest message is at the bottom of the transcript.";
  return state === "running" ? "Working. The first activity will appear here in a moment." : "No activity has been recorded for this session yet.";
}

/** "42s", "3 min 5s", "2 h 4 min" — or undefined for a start time that is missing or implausible (an unset timestamp). */
export function elapsedText(from: string | undefined, to: number): string | undefined {
  const start = from ? Date.parse(from) : Number.NaN;
  if (!Number.isFinite(start) || start <= 0 || to < start || to - start > 30 * 86_400_000) return undefined;
  const seconds = Math.floor((to - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60}s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A clock that ticks once a second while the component lives. */
export function createNow(): () => number {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  return now;
}

const ORB: Record<string, string> = {
  running: "bg-surface-green-7 brain-live-dot", starting: "bg-surface-blue-7 brain-live-dot", waiting: "bg-surface-amber-6 brain-live-dot",
  stopping: "bg-surface-amber-6", stopped: "bg-surface-gray-5", failed: "bg-surface-red-7",
};

/**
 * The pinned top of the console: one plain-language line about what the agent
 * is doing right now, with how long it has run, the tool steps taken and how
 * much of its allowance is used. A session waiting for a person turns the line
 * amber and offers the reply in place.
 */
export function ConsoleNowLine(props: { session?: SessionDetail; activity: FeedActivity; onReply?: () => void }): JSX.Element {
  const now = createNow();
  const live = () => props.session?.state === "running" || props.session?.state === "starting" || props.session?.state === "waiting";
  const waiting = () => props.session?.state === "waiting";
  const startedAt = () => (elapsedText(props.session?.createdAt, now()) ? props.session?.createdAt : props.activity.firstAt);
  const endMs = () => (live() ? now() : Date.parse(props.session?.updatedAt ?? "") || now());
  const elapsed = () => elapsedText(startedAt(), endMs());
  const budgetShare = () => {
    const max = props.session?.budget.maxTokens ?? 0;
    return max > 0 ? Math.min(100, Math.round(((props.session?.usedTokens ?? 0) / max) * 100)) : 0;
  };
  return <section class={`flex flex-col gap-2 border-b px-3 py-2.5 ${waiting() ? "border-outline-amber-2 bg-surface-amber-1" : "border-outline-gray-1 bg-surface-gray-1"}`} data-testid="console-now" aria-label="What this session is doing now">
    <div class="flex items-start gap-2.5">
      <span class={`mt-1.5 size-2.5 shrink-0 rounded-full ${ORB[props.session?.state ?? ""] ?? "bg-surface-gray-5"}`} aria-hidden="true" />
      <p class="min-w-0 flex-1 text-base text-ink-gray-9" role="status">{nowSentence(props.session, props.activity)}</p>
      <Show when={waiting() && props.onReply}><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-corner-down-right" onClick={() => props.onReply?.()}>Reply</Button></Show>
    </div>
    <Show when={props.session}>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 ps-5 text-caption text-ink-gray-7">
        <Show when={elapsed()}><span class="inline-flex items-center gap-1 tabular-nums" title="Time since the session started"><span class="lucide-timer size-3.5" aria-hidden="true" />{live() ? "Running for" : "Ran for"} {elapsed()}</span></Show>
        <span class="inline-flex items-center gap-1" title="Tool calls so far in the loaded transcript"><span class="lucide-wrench size-3.5" aria-hidden="true" />{props.activity.toolCalls} {props.activity.toolCalls === 1 ? "step" : "steps"} taken</span>
        <span class="inline-flex items-center gap-2" title="Share of this session's token allowance already used">
          <span class="inline-flex items-center gap-1"><span class="lucide-gauge size-3.5" aria-hidden="true" />Allowance used {budgetShare()}%</span>
          <span role="progressbar" aria-label="Session allowance used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={budgetShare()} class="flex h-1.5 w-28 overflow-hidden rounded-full bg-surface-gray-3">
            <span class={`h-full ${budgetShare() >= 90 ? "bg-surface-amber-6" : "bg-surface-blue-9"}`} style={{ width: `${budgetShare()}%` }} />
          </span>
        </span>
      </div>
    </Show>
  </section>;
}
