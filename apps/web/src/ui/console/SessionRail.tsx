import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { BrainSession, JobSnapshot } from "@brain/contracts";
import { StatusBadge } from "../components/StatusBadge";
import { RelativeTime } from "../screen-region";

/**
 * The console's left pane (plan §3): sessions and runs with their live state —
 * running, verifying, waiting — and instant switching between concurrent
 * sessions. Nothing here duplicates the Runs index screen; it links to it.
 */

const LIVE_STATES = ["starting", "running", "waiting"];

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
  const runs = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return props.jobs
      .filter((job) => !needle
        || (job.workflowTitle ?? "").toLowerCase().includes(needle)
        || job.jobId.toLowerCase().includes(needle))
      .slice(0, 20);
  });
  const liveCount = () => props.sessions.filter((session) => LIVE_STATES.includes(session.state)).length;

  return <div class="flex min-h-0 flex-1 flex-col" data-testid="console-rail">
    <div class="flex flex-col gap-1.5 border-b border-outline-gray-1 p-2.5">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base-medium text-ink-gray-9">Sessions &amp; runs</h2>
        <button type="button" aria-pressed={liveOnly()}
          class={`rounded-control border px-1.5 py-0.5 text-caption focus-visible:focus-ring ${liveOnly() ? "border-outline-blue-3 bg-surface-blue-1 text-ink-blue-8" : "border-outline-gray-2 text-ink-gray-7"}`}
          onClick={() => setLiveOnly((value) => !value)}>
          Live only ({liveCount()})
        </button>
      </div>
      <input type="search" class="w-full rounded-control border border-outline-gray-2 bg-surface-elevation-1 px-2 py-1 text-caption focus-visible:focus-ring"
        placeholder="Filter sessions and runs…" aria-label="Filter sessions and runs" value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)} />
    </div>
    <div class="brain-exec-scroll flex-1">
      <section class="flex flex-col gap-0.5 p-2" aria-label="Agent sessions">
        <h3 class="px-1 pb-1 text-caption font-medium uppercase tracking-wide text-ink-gray-6">Sessions ({sessions().length})</h3>
        <Show when={sessions().length > 0} fallback={<p class="px-1 py-2 text-caption text-ink-gray-6">No sessions match.</p>}>
          <For each={sessions()}>{(session) => (
            <button type="button" data-testid="rail-session" data-session-id={session.sessionId} aria-pressed={props.selected === session.sessionId}
              class={`flex w-full cursor-pointer items-center gap-2 rounded-control border px-2 py-1 text-start focus-visible:focus-ring ${props.selected === session.sessionId ? "border-outline-blue-3 bg-surface-blue-1" : "border-transparent hover:bg-surface-gray-1"}`}
              onClick={() => props.onSelect(session.sessionId)}>
              <span class={`size-1.5 shrink-0 rounded-full ${session.state === "running" ? "bg-surface-green-7" : session.state === "waiting" || session.state === "starting" ? "bg-surface-amber-7" : session.state === "failed" ? "bg-surface-red-7" : "bg-surface-gray-2"}`}
                role="img" aria-label={`Session ${session.state}`} />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-caption font-medium text-ink-gray-9">{session.task || session.sessionId}</span>
                <span class="block truncate text-caption text-ink-gray-6">{session.engine.id} · <RelativeTime value={session.updatedAt} /></span>
              </span>
            </button>
          )}</For>
        </Show>
      </section>
      <section class="flex flex-col gap-0.5 border-t border-outline-gray-1 p-2" aria-label="Runs">
        <div class="flex items-center justify-between px-1 pb-1">
          <h3 class="text-caption font-medium uppercase tracking-wide text-ink-gray-6">Runs ({runs().length})</h3>
          <button type="button" class="text-caption text-ink-blue-link hover:underline focus-visible:focus-ring" onClick={props.onOpenRunsIndex}>All runs</button>
        </div>
        <Show when={runs().length > 0} fallback={<p class="px-1 py-2 text-caption text-ink-gray-6">No runs match.</p>}>
          <For each={runs()}>{(job) => (
            <button type="button" data-testid="rail-run" data-job-id={job.jobId}
              class="flex w-full cursor-pointer items-center gap-2 rounded-control border border-transparent px-2 py-1 text-start hover:bg-surface-gray-1 focus-visible:focus-ring"
              onClick={() => props.onOpenRun(job.jobId)}>
              <span class="grid size-7 shrink-0 place-items-center rounded-control bg-surface-blue-2 text-ink-blue-8"><span class="lucide-workflow size-3.5" aria-hidden="true" /></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-caption font-medium text-ink-gray-9">{job.workflowTitle ?? job.jobId}</span>
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
