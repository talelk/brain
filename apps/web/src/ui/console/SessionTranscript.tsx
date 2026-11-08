import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { StreamEvent } from "../../data/screens";
import { ConsoleFeed, hydrateConsoleHistory } from "./ConsoleFeed";
import { readExecFilters, type ExecLogFilters } from "../exec/exec-filters";

/**
 * One session's transcript with its own filters and live tail, without the
 * console's controls — the building block of the cockpit's split compare.
 */
export function SessionTranscript(props: { workspaceId: string; sessionId: string; title: string }): JSX.Element {
  const [filters, setFilters] = createSignal<ExecLogFilters>(readExecFilters({}));
  const [ready, setReady] = createSignal<{ history: StreamEvent[]; head: number }>();
  const [error, setError] = createSignal("");
  const [reload, setReload] = createSignal(0);
  createEffect(() => {
    reload();
    const controller = new AbortController();
    setReady(undefined); setError("");
    void hydrateConsoleHistory(props.workspaceId, props.sessionId, controller.signal)
      .then((loaded) => setReady({ history: loaded.frames, head: loaded.head }))
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The transcript could not be loaded."); });
    onCleanup(() => controller.abort());
  });
  return <section aria-label={`Transcript of ${props.title}`} class="flex min-h-[28rem] min-w-0 flex-col rounded-control border border-outline-gray-1">
    <h3 class="border-b border-outline-gray-1 px-3 py-2 text-base-medium">{props.title}</h3>
    <Show when={!error()} fallback={<p role="alert" class="px-3 py-2 text-interface text-ink-red-8">{error()}</p>}>
      <Show when={ready()} keyed fallback={<p role="status" class="px-3 py-2 text-caption text-ink-gray-6">Loading the session transcript…</p>}>
        {(loaded) => <ConsoleFeed workspaceId={props.workspaceId} sessionId={props.sessionId} streamCursor={loaded.head} history={loaded.history}
          filters={filters()} onFiltersChange={(patch) => setFilters({ ...filters(), ...patch })} onResync={() => setReload((value) => value + 1)} />}
      </Show>
    </Show>
  </section>;
}
