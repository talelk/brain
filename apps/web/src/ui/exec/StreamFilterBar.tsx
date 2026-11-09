import { For } from "solid-js";
import type { JSX } from "solid-js";
import { TextInput } from "@talelk/newui-atoms";
import { STREAM_EMITTERS, STREAM_SEVERITIES } from "../../data/exec-logs";
import type { StreamEmitter, StreamSeverity } from "../../data/exec-logs";
import { severityDotClass, severityLabel } from "../screen-region";

/**
 * The one filter bar for execution-stream surfaces: severity and emitter chip
 * toggles plus the free-text search field. Filter state lives in the URL
 * (readExecFilters/writeExecFilters); this component only renders and reports
 * toggles, so Logs, the console feed and future surfaces cannot drift apart.
 */
export function StreamFilterBar(props: {
  severities: readonly StreamSeverity[];
  emitters: readonly StreamEmitter[];
  search: string;
  onToggleSeverity: (severity: StreamSeverity) => void;
  onToggleEmitter: (emitter: StreamEmitter) => void;
  onSearch: (search: string) => void;
  searchLabel?: string;
  /** Extra controls rendered after the filters (e.g. the Export control). */
  children?: JSX.Element;
}): JSX.Element {
  return <div class="flex min-w-0 flex-col gap-2">
    <div class="flex min-w-0 flex-wrap items-end gap-x-3 gap-y-2">
      <TextInput class="min-w-0 flex-1 basis-64" label={props.searchLabel ?? "Search logs"} value={props.search}
        onInput={(event) => props.onSearch(event.currentTarget.value)} />
      {props.children}
    </div>
    <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
    <span class="text-caption font-medium text-ink-gray-6" aria-hidden="true">Severity</span>
    <fieldset class="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
      <legend class="sr-only">Severity filter</legend>
      <For each={STREAM_SEVERITIES}>
        {(severity) => {
          const selected = () => props.severities.includes(severity);
          return <button type="button" aria-pressed={selected()} title={`Severity: ${severityLabel(severity)}`}
            class={`inline-flex items-center gap-1 rounded-control border px-1.5 py-0.5 text-caption focus-visible:focus-ring ${selected() ? "border-outline-blue-3 bg-surface-blue-1 text-ink-blue-8" : "border-outline-gray-2 text-ink-gray-7 hover:bg-surface-gray-1"}`}
            onClick={() => props.onToggleSeverity(severity)}>
            <span class={`size-1.5 rounded-full ${severityDotClass(severity)}`} aria-hidden="true" />
            {severityLabel(severity)}
          </button>;
        }}
      </For>
    </fieldset>
    <span class="text-caption font-medium text-ink-gray-6" aria-hidden="true">Source</span>
    <fieldset class="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
      <legend class="sr-only">Source filter</legend>
      <For each={STREAM_EMITTERS}>
        {(emitter) => {
          const selected = () => props.emitters.includes(emitter);
          return <button type="button" aria-pressed={selected()} title={`Source: ${emitter}`}
            class={`rounded-control border px-1.5 py-0.5 text-caption capitalize focus-visible:focus-ring ${selected() ? "border-outline-blue-3 bg-surface-blue-1 text-ink-blue-8" : "border-outline-gray-2 text-ink-gray-7 hover:bg-surface-gray-1"}`}
            onClick={() => props.onToggleEmitter(emitter)}>
            {emitter}
          </button>;
        }}
      </For>
    </fieldset>
    </div>
  </div>;
}
