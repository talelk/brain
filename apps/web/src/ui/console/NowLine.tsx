import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { A } from "@solidjs/router";
import { createAttentionRead } from "../attention";
import type { JSX } from "solid-js";
import type { SessionDetail } from "../../data/exec-console";
import { elapsedText, etaBand, nowSentence, type EtaBand, type FeedActivity, type TaskState } from "./doing-now";
import { Button } from "@talelk/newui-atoms";
import { formatTokens } from "../format";

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
export function ConsoleNowLine(props: { session?: SessionDetail; activity: FeedActivity; onReply?: () => void; estimatedMinutes?: number; taskState?: TaskState }): JSX.Element {
  const now = createNow();
  const live = () => props.session?.state === "running" || props.session?.state === "starting" || props.session?.state === "waiting";
  const waiting = () => props.session?.state === "waiting";
  // A waiting session is most often waiting on an approval; the call carries no link until it runs,
  // so the line offers the workspace's pending approvals instead of claiming a match.
  const attention = createAttentionRead();
  const pendingApprovals = () => (attention.state().data ?? []).filter((item) => item.kind === "approval").length;
  const startedAt = () => (elapsedText(props.session?.createdAt, now()) ? props.session?.createdAt : props.activity.firstAt);
  const endMs = () => (live() ? now() : Date.parse(props.session?.updatedAt ?? "") || now());
  const elapsed = () => elapsedText(startedAt(), endMs());
  const band = (): EtaBand => etaBand({ ...(props.estimatedMinutes !== undefined ? { estimatedMinutes: props.estimatedMinutes } : {}), ...(startedAt() ? { startedAt: startedAt()! } : {}), nowMs: now(), endedAtMs: endMs(), finished: !live() });
  const budgetShare = () => {
    const max = props.session?.budget.maxTokens ?? 0;
    return max > 0 ? Math.min(100, Math.round(((props.session?.usedTokens ?? 0) / max) * 100)) : 0;
  };
  return <section class={`flex flex-col gap-2 border-b px-3 py-2.5 ${waiting() ? "border-outline-amber-2 bg-surface-amber-1" : "border-outline-gray-1 bg-surface-gray-1"}`} data-testid="console-now" aria-label="What this session is doing now">
    <div class="flex items-start gap-2.5">
      <span class={`mt-1.5 size-2.5 shrink-0 rounded-full ${ORB[props.session?.state ?? ""] ?? "bg-surface-gray-5"}`} aria-hidden="true" />
      <p class="min-w-0 flex-1 text-base text-ink-gray-9" role="status">{nowSentence(props.session, props.activity, props.taskState)}</p>
      <Show when={waiting() && pendingApprovals() > 0}>
        <A class="inline-flex shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-interface font-medium text-ink-amber-8 hover:bg-surface-amber-2" href="/approvals"><span class="lucide-shield-check size-3.5" aria-hidden="true" />Review {pendingApprovals()} pending {pendingApprovals() === 1 ? "approval" : "approvals"}</A>
      </Show>
      <Show when={waiting() && props.onReply}><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-corner-down-right" onClick={() => props.onReply?.()}>Reply</Button></Show>
    </div>
    <Show when={props.session}>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 ps-5 text-caption text-ink-gray-7">
        <Show when={elapsed()}><span class="inline-flex items-center gap-1 tabular-nums" title="Time since the session started"><span class="lucide-timer size-3.5" aria-hidden="true" />{live() ? "Running for" : "Ran for"} {elapsed()}</span></Show>
        <Show when={props.session?.workItemId}><EtaBandView band={band()} /></Show>
        <span class="inline-flex items-center gap-1" title="Tool calls so far in the loaded transcript"><span class="lucide-wrench size-3.5" aria-hidden="true" />{props.activity.toolCalls} {props.activity.toolCalls === 1 ? "step" : "steps"} taken</span>
        <span class="inline-flex items-center gap-2" title="Share of this session's token allowance already used">
          <span class="inline-flex items-center gap-1"><span class="lucide-gauge size-3.5" aria-hidden="true" />Allowance used {budgetShare()}%<Show when={(props.session?.usedTokens ?? 0) > 0}> · {formatTokens(props.session?.usedTokens)} tokens so far</Show></span>
          <span role="progressbar" aria-label="Session allowance used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={budgetShare()} class="flex h-1.5 w-28 overflow-hidden rounded-full bg-surface-gray-3">
            <span class={`h-full ${budgetShare() >= 90 ? "bg-surface-amber-6" : "bg-surface-blue-9"}`} style={{ width: `${budgetShare()}%` }} />
          </span>
        </span>
      </div>
    </Show>
  </section>;
}

/** The ETA band: elapsed time against the plan's estimate, as words and a thin bar; "unknown" when the plan gave no estimate. */
export function EtaBandView(props: { band: EtaBand }): JSX.Element {
  return <span class="inline-flex items-center gap-2" data-testid="eta-band" data-kind={props.band.kind} title="Elapsed time against the plan's estimate for this task">
    <span class={`inline-flex items-center gap-1 ${props.band.kind === "over" ? "text-ink-amber-8" : ""}`}><span class="lucide-hourglass size-3.5" aria-hidden="true" />{props.band.label}</span>
    <Show when={props.band.fraction !== undefined}>
      <span role="progressbar" aria-label="Share of the estimated time used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((props.band.fraction ?? 0) * 100)} class="flex h-1.5 w-20 overflow-hidden rounded-full bg-surface-gray-3">
        <span class={`h-full ${props.band.kind === "over" ? "bg-surface-amber-6" : props.band.kind === "done" ? "bg-surface-green-7" : "bg-surface-blue-9"}`} style={{ width: `${Math.round((props.band.fraction ?? 0) * 100)}%` }} />
      </span>
    </Show>
  </span>;
}
