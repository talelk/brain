import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { SessionDetail } from "../../data/exec-console";
import type { FeedEntry } from "./ConsoleFeed";
import { PlainSummary } from "../viz/PlainSummary";

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
  if (state === "waiting") return "The agent is waiting for input before it continues.";
  const tool = activity.lastTool;
  const message = activity.lastMessage;
  if (tool && (!message || tool.streamSeq > message.streamSeq)) {
    const name = tool.tool?.name ?? "a tool";
    return tool.tool?.result ? `Finished using ${name}; deciding the next step.` : `Using ${name}.`;
  }
  if (message) return "Thinking out loud: the agent is writing up its progress (latest message below).";
  return state === "running" ? "Working. The first activity will appear here in a moment." : "No activity has been recorded for this session yet.";
}

function elapsedText(from: string | undefined, to: number): string {
  const start = from ? Date.parse(from) : Number.NaN;
  if (!Number.isFinite(start) || to < start) return "just started";
  const seconds = Math.floor((to - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60}s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The top of the console: one plain-language line about what the agent is doing
 * right now, with the time it has been running, the tool steps taken and how
 * much of its budget is used. Technical state stays in the badges and facts.
 */
export function ConsoleNowLine(props: { session?: SessionDetail; activity: FeedActivity }): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const live = () => props.session?.state === "running" || props.session?.state === "starting" || props.session?.state === "waiting";
  // A start time that is implausibly old (an unset timestamp) is ignored rather than shown as "498404 h".
  const plausible = (value: string | undefined) => !!value && Date.now() - Date.parse(value) < 30 * 86_400_000 && Date.parse(value) > 0;
  const startedAt = () => (plausible(props.session?.createdAt) ? props.session?.createdAt : plausible(props.activity.firstAt) ? props.activity.firstAt : undefined);
  const endMs = () => (live() ? now() : Date.parse(props.session?.updatedAt ?? "") || now());
  const budgetShare = () => {
    const max = props.session?.budget.maxTokens ?? 0;
    return max > 0 ? Math.min(100, Math.round(((props.session?.usedTokens ?? 0) / max) * 100)) : 0;
  };
  return <section class="flex flex-col gap-1.5 border-b border-outline-gray-1 bg-surface-gray-1 px-3 py-2" data-testid="console-now" aria-label="What this session is doing now">
    <PlainSummary icon={live() ? "lucide-activity" : "lucide-info"}>{nowSentence(props.session, props.activity)}</PlainSummary>
    <Show when={props.session}>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-ink-gray-7">
        <Show when={startedAt()}><span title="Time since the session started"><span class="lucide-timer me-1 size-3.5 align-text-bottom" aria-hidden="true" />{live() ? "Running for" : "Ran for"} {elapsedText(startedAt(), endMs())}</span></Show>
        <span title="Tool calls so far in the loaded transcript"><span class="lucide-wrench me-1 size-3.5 align-text-bottom" aria-hidden="true" />{props.activity.toolCalls} {props.activity.toolCalls === 1 ? "step" : "steps"} taken</span>
        <span class="flex items-center gap-2" title="Share of this session's token allowance already used">
          <span>Allowance used {budgetShare()}%</span>
          <span role="progressbar" aria-label="Session allowance used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={budgetShare()} class="flex h-1.5 w-24 overflow-hidden rounded-full bg-surface-gray-3">
            <span class="h-full bg-surface-blue-9" style={{ width: `${budgetShare()}%` }} />
          </span>
        </span>
      </div>
    </Show>
  </section>;
}
