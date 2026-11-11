import { For, Show, createResource } from "solid-js";
import type { JSX } from "solid-js";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { formatDateTime } from "../format";

interface DiffLine { type: "context" | "add" | "del"; text: string }
interface OutputChange { name: string; status: "unchanged" | "changed"; added: number; removed: number; hunks: Array<{ header: string; lines: DiffLine[] }> }
export interface OccurrenceDiffView {
  kind: "not-scheduled" | "first-run" | "previous-pending" | "unchanged" | "changed";
  previous?: { occurrenceId: string; plannedAt: string };
  waitingFor?: "previous" | "current";
  outputs: OutputChange[];
}

/** The one plain sentence for a diff; the same words in the schedule history and on the Result. */
export function changeSentence(view: OccurrenceDiffView): string | undefined {
  const since = view.previous ? ` the run of ${formatDateTime(view.previous.plannedAt)}` : " the previous run";
  switch (view.kind) {
    case "not-scheduled": return undefined;
    case "first-run": return "First run of this schedule, so there is nothing to compare with yet.";
    case "previous-pending": return view.waitingFor === "previous" ? "The previous run left no result to compare with." : "This run has no result yet; the comparison appears when it does.";
    case "unchanged": return `Same result as${since}.`;
    case "changed": {
      const added = view.outputs.reduce((sum, output) => sum + output.added, 0);
      const removed = view.outputs.reduce((sum, output) => sum + output.removed, 0);
      return `Changed since${since}: ${added} ${added === 1 ? "line" : "lines"} added, ${removed} removed.`;
    }
  }
}

/**
 * What a scheduled run changed since the one before it (#57). The server
 * computes the comparison from the stored results (no model summary); this
 * only reads it. Renders nothing for work no schedule started.
 */
export function OccurrenceChange(props: { refId: string }): JSX.Element {
  const app = useApp();
  const [view] = createResource(() => ({ workspaceId: app.workspaceId(), refId: props.refId }), async ({ workspaceId, refId }) => {
    try {
      return (await query<{ snapshot: OccurrenceDiffView }>({ queryType: "automations.diff", workspaceId, resourceId: refId })).snapshot;
    } catch { return undefined; }
  });
  return <Show when={view()}>{(loaded) => <Show when={changeSentence(loaded())}>{(sentence) =>
    <div class="min-w-0 rounded-control border border-outline-gray-2 bg-surface-gray-1 px-3 py-2" data-testid="occurrence-change" data-kind={loaded().kind}>
      <p class="flex items-center gap-2 text-interface text-ink-gray-9"><span class={`size-4 shrink-0 ${loaded().kind === "changed" ? "lucide-git-compare text-ink-blue-7" : loaded().kind === "unchanged" ? "lucide-equal text-ink-gray-6" : "lucide-info text-ink-gray-6"}`} aria-hidden="true" />{sentence()}</p>
      <Show when={loaded().kind === "changed"}>
        <details class="mt-2">
          <summary class="cursor-pointer text-caption text-ink-blue-link">Show what changed</summary>
          <For each={loaded().outputs.filter((output) => output.status === "changed")}>{(output) => <section class="mt-2 min-w-0">
            <Show when={loaded().outputs.length > 1}><h4 class="text-caption font-medium text-ink-gray-7">{output.name}</h4></Show>
            <For each={output.hunks}>{(hunk) => <pre class="brain-exec-log mt-1 max-h-72 overflow-auto rounded-sm border border-outline-gray-1 bg-surface-white p-2 text-[0.8rem] leading-5"><For each={hunk.lines}>{(line) =>
              <div class={line.type === "add" ? "bg-surface-green-1 text-ink-green-8" : line.type === "del" ? "bg-surface-red-1 text-ink-red-8" : "text-ink-gray-6"}>{line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}{line.text}</div>}</For></pre>}</For>
          </section>}</For>
        </details>
      </Show>
    </div>}</Show>}</Show>;
}
