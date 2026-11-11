import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { BrainSession, JobSnapshot } from "@brain/contracts";
import { StatusBadge, statusLabel } from "../components/StatusBadge";
import { createNow } from "./NowLine";
import { elapsedText, taskNowLine } from "./doing-now";

/**
 * The console's left pane (plan §3): who is working right now — each session
 * with its agent, state and how long it has been at it — then what finished,
 * then the runs. Switching is instant; nothing here duplicates the Runs index
 * screen, it links to it.
 */

const LIVE_STATES = ["starting", "running", "waiting"];

const DOT: Record<string, string> = {
  running: "bg-surface-green-7 brain-live-dot", starting: "bg-surface-blue-7 brain-live-dot", waiting: "bg-surface-amber-6 brain-live-dot",
  stopping: "bg-surface-amber-6", failed: "bg-surface-red-7", stopped: "bg-surface-gray-5",
};
const STATE_INK: Record<string, string> = {
  running: "text-ink-green-8", starting: "text-ink-blue-8", waiting: "text-ink-amber-8", stopping: "text-ink-amber-8", failed: "text-ink-red-8", stopped: "text-ink-gray-6",
};

export function SessionRail(props: {
  workspaceId: string;
  sessions: readonly BrainSession[];
  jobs: readonly JobSnapshot[];
  selected?: string;
  onSelect: (sessionId: string) => void;
  onOpenRun: (jobId: string) => void;
  onOpenRunsIndex: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [liveOnly, setLiveOnly] = createSignal(false);
  const now = createNow();

  const sessions = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return props.sessions
      .filter((session) => (liveOnly() ? LIVE_STATES.includes(session.state) : true))
      .filter((session) => !needle
        || session.task.toLowerCase().includes(needle)
        || session.sessionId.toLowerCase().includes(needle)
        || session.agentId.toLowerCase().includes(needle))
      .slice(0, 50);
  });
  const working = () => sessions().filter((session) => LIVE_STATES.includes(session.state));
  const earlier = () => sessions().filter((session) => !LIVE_STATES.includes(session.state));
  const runs = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return props.jobs
      .filter((job) => !needle
        || (job.workflowTitle ?? "").toLowerCase().includes(needle)
        || job.jobId.toLowerCase().includes(needle))
      .slice(0, 20);
  });
  const liveCount = () => props.sessions.filter((session) => LIVE_STATES.includes(session.state)).length;

  const row = (session: BrainSession) => {
    const live = () => LIVE_STATES.includes(session.state);
    const elapsed = () => elapsedText(session.createdAt, live() ? now() : Date.parse(session.updatedAt) || now());
    const selected = () => props.selected === session.sessionId;
    return <button type="button" data-testid="rail-session" data-session-id={session.sessionId} aria-pressed={selected()}
      class={`group relative flex w-full cursor-pointer items-start gap-2.5 rounded-control px-2 py-2 text-start focus-visible:focus-ring ${selected() ? "bg-surface-blue-1 shadow-[inset_2px_0_var(--surface-blue-7)]" : "hover:bg-surface-gray-1"}`}
      onClick={() => props.onSelect(session.sessionId)}>
      <span class="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-gray-2 text-ink-gray-7" aria-hidden="true">
        <span class="lucide-bot size-4" />
        <span class={`absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface-elevation-1 ${DOT[session.state] ?? DOT.stopped}`} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-caption font-medium text-ink-gray-9">{session.task || `${session.agentId ?? "Agent"} session`}</span>
        <span class="block truncate text-caption text-ink-gray-6">{[session.agentId, session.engine.id].filter(Boolean).join(" · ")}</span>
        <span class="mt-0.5 flex items-center gap-1.5 text-caption">
          <span class={`font-medium ${STATE_INK[session.state] ?? "text-ink-gray-6"}`}>{statusLabel(undefined, session.state)}</span>
          <Show when={elapsed()}><span class="tabular-nums text-ink-gray-6">· {live() ? "" : "ran "}{elapsed()}</span></Show>
        </span>
        <Show when={live() && taskNowLine(undefined, session.state)}>{(text) => <span class="block truncate text-caption text-ink-gray-7" data-testid="rail-doing-now">{text()}</span>}</Show>
      </span>
    </button>;
  };

  return <div class="flex min-h-0 flex-1 flex-col" data-testid="console-rail">
    <div class="flex flex-col gap-2 border-b border-outline-gray-1 p-2.5">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base-medium text-ink-gray-9">Sessions &amp; runs</h2>
        <button type="button" aria-pressed={liveOnly()}
          class={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption focus-visible:focus-ring ${liveOnly() ? "border-outline-blue-3 bg-surface-blue-1 text-ink-blue-8" : "border-outline-gray-2 text-ink-gray-7 hover:bg-surface-gray-1"}`}
          onClick={() => setLiveOnly((value) => !value)}>
          <span class={`size-1.5 rounded-full ${liveCount() > 0 ? "bg-surface-green-7" : "bg-surface-gray-5"}`} aria-hidden="true" />Live only ({liveCount()})
        </button>
      </div>
      <input type="search" class="w-full rounded-control border border-outline-gray-2 bg-surface-elevation-1 px-2 py-1 text-caption focus-visible:focus-ring"
        placeholder="Filter sessions and runs…" aria-label="Filter sessions and runs" value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)} />
    </div>
    <div class="brain-exec-scroll flex-1">
      <section class="flex flex-col gap-0.5 p-2" aria-label="Agent sessions">
        <Show when={sessions().length > 0} fallback={<p class="px-1 py-2 text-caption text-ink-gray-6">No sessions match.</p>}>
          <Show when={working().length > 0}>
            <h3 class="flex items-center gap-1.5 px-1 pb-1 text-caption font-medium text-ink-gray-7"><span class="size-1.5 rounded-full bg-surface-green-7" aria-hidden="true" />Working now ({working().length})</h3>
            <For each={working()}>{row}</For>
          </Show>
          <Show when={earlier().length > 0}>
            <h3 class={`px-1 pb-1 text-caption font-medium text-ink-gray-7 ${working().length > 0 ? "pt-2" : ""}`}>Earlier ({earlier().length})</h3>
            <For each={earlier()}>{row}</For>
          </Show>
        </Show>
      </section>
      <section class="flex flex-col gap-0.5 border-t border-outline-gray-1 p-2" aria-label="Runs">
        <div class="flex items-center justify-between px-1 pb-1">
          <h3 class="text-caption font-medium text-ink-gray-7">Runs ({runs().length})</h3>
          <button type="button" class="text-caption text-ink-blue-link hover:underline focus-visible:focus-ring" onClick={props.onOpenRunsIndex}>All runs</button>
        </div>
        <Show when={runs().length > 0} fallback={<p class="px-1 py-2 text-caption text-ink-gray-6">No runs match.</p>}>
          <For each={runs()}>{(job) => (
            <button type="button" data-testid="rail-run" data-job-id={job.jobId}
              class="flex w-full cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-start hover:bg-surface-gray-1 focus-visible:focus-ring"
              onClick={() => props.onOpenRun(job.jobId)}>
              <span class="grid size-7 shrink-0 place-items-center rounded-full bg-surface-gray-2 text-ink-gray-7" aria-hidden="true"><span class="lucide-workflow size-3.5" /></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-caption font-medium text-ink-gray-9">{job.workflowTitle ?? "Run"}</span>
                <span class="block truncate text-caption text-ink-gray-6">{job.attempts.length} {job.attempts.length === 1 ? "attempt" : "attempts"}</span>
              </span>
              <StatusBadge kind="job" status={job.workflowState ?? job.state} />
            </button>
          )}</For>
        </Show>
      </section>
    </div>
  </div>;
}
