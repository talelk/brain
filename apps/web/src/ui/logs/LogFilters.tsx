import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import { StreamFilterBar } from "../exec/StreamFilterBar";
import type { StreamEmitter, StreamSeverity } from "../../data/exec-logs";
import type { ExecLogFilters } from "../exec/exec-filters";

/**
 * The Log Explorer's filter bar (T61): severity and source chip toggles,
 * full-text search, correlation scope chips and the bounded NDJSON export
 * control. Filter state lives in the URL (ExecLogFilters); this component only
 * renders and reports, so deep links and cross-navigation keep their filters.
 */

export type LogViewMode = "readable" | "raw";

const SCOPE_LABELS: Readonly<Record<"session" | "job" | "run" | "attempt", string>> = {
  session: "Session", job: "Job", run: "Run", attempt: "Attempt",
};

function ScopeChips(props: { filters: ExecLogFilters; onRemove: (axis: "session" | "job" | "run" | "attempt") => void }): JSX.Element {
  return <Show when={props.filters.session || props.filters.job || props.filters.run || props.filters.attempt}>
    <div class="flex flex-wrap items-center gap-1" data-testid="log-scope-chips">
      <For each={(["session", "job", "run", "attempt"] as const)}>
        {(axis) => <Show when={props.filters[axis]}>
          <button type="button" class="inline-flex max-w-56 items-center gap-1 rounded-control border border-outline-blue-2 bg-surface-blue-1 px-1.5 py-0.5 text-xs text-ink-blue-8 focus-visible:focus-ring"
            title={`Scoped to ${SCOPE_LABELS[axis]} ${props.filters[axis]} — click to clear`}
            onClick={() => props.onRemove(axis)}>
            <span class="shrink-0">{SCOPE_LABELS[axis]}</span>
            <span class="truncate brain-exec-log">{props.filters[axis]}</span>
            <span class="lucide-x size-3 shrink-0" aria-hidden="true" />
            <span class="sr-only">clear {SCOPE_LABELS[axis]} scope</span>
          </button>
        </Show>}
      </For>
    </div>
  </Show>;
}

/** Readable / Raw presentation toggle: the same records, one preserves the original redacted record beside the grouped view. */
function ModeToggle(props: { mode: LogViewMode; onMode: (mode: LogViewMode) => void }): JSX.Element {
  return <fieldset class="m-0 flex overflow-hidden rounded-control border border-outline-gray-2 p-0" aria-label="Log presentation mode">
    <For each={(["readable", "raw"] as const)}>{(mode) => (
      <button type="button" aria-pressed={props.mode === mode}
        class={`px-2 py-1 text-base capitalize focus-visible:focus-ring ${props.mode === mode ? "bg-surface-blue-1 text-ink-blue-8" : "text-ink-gray-7 hover:bg-surface-gray-1"}`}
        onClick={() => props.onMode(mode)}>{mode}</button>
    )}</For>
  </fieldset>;
}

export function LogFilters(props: {
  filters: ExecLogFilters;
  search: string;
  mode: LogViewMode;
  exportUrl: string;
  compareOpen: boolean;
  compareAvailable: boolean;
  onToggleSeverity: (severity: StreamSeverity) => void;
  onToggleEmitter: (emitter: StreamEmitter) => void;
  onSearch: (search: string) => void;
  onSessionScope: (sessionId: string) => void;
  onRemoveScope: (axis: "session" | "job" | "run" | "attempt") => void;
  onMode: (mode: LogViewMode) => void;
  onToggleCompare: () => void;
}): JSX.Element {
  const [sessionDraft, setSessionDraft] = createSignal("");
  const commitSession = () => {
    const value = sessionDraft().trim();
    if (value.length > 0) props.onSessionScope(value);
    setSessionDraft("");
  };
  return <div class="flex flex-col gap-2" data-testid="log-filters">
    <StreamFilterBar
      severities={props.filters.severity}
      emitters={props.filters.emitter}
      search={props.search}
      searchLabel="Search retained logs (full text)"
      onToggleSeverity={props.onToggleSeverity}
      onToggleEmitter={props.onToggleEmitter}
      onSearch={props.onSearch}>
      <Show when={!props.filters.session}>
        <span class="flex items-end gap-1">
          <TextInput class="w-56" label="Session scope" value={sessionDraft()}
            placeholder="Scope by session id…"
            onInput={(event) => setSessionDraft(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitSession(); } }} />
          <Button size="md" variant="outline" theme="gray" disabled={!sessionDraft().trim()} onClick={commitSession}>Scope</Button>
        </span>
      </Show>
      <ModeToggle mode={props.mode} onMode={props.onMode} />
      <Show when={props.compareAvailable}>
        <Button size="md" variant={props.compareOpen ? "solid" : "outline"} theme={props.compareOpen ? "blue" : "gray"}
          iconLeft="lucide-columns-2" onClick={props.onToggleCompare}>Compare attempts</Button>
      </Show>
      <a href={props.exportUrl} download="" data-testid="log-export"
        class="inline-flex items-center gap-1.5 rounded-control border border-outline-gray-2 px-2 py-1 text-base text-ink-gray-8 hover:border-outline-blue-3 hover:bg-surface-blue-1 focus-visible:focus-ring"
        title="Download the bounded sanitized NDJSON segment of the current filtered view (source and time included)">
        <span class="lucide-download size-4" aria-hidden="true" />
        Export
      </a>
    </StreamFilterBar>
    <ScopeChips filters={props.filters} onRemove={props.onRemoveScope} />
  </div>;
}
