import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { statusLabel, statusTheme } from "../components/StatusBadge";
import { StatusIcon } from "./StatusIcon";

/** The work-item states in lifecycle order. */
export const WORK_ITEM_STATES = ["backlog", "ready", "in-progress", "blocked", "review", "done", "abandoned"] as const;

const FILL: Record<string, string> = { gray: "bg-surface-gray-5", blue: "bg-surface-blue-7", red: "bg-surface-red-7", amber: "bg-surface-amber-6", green: "bg-surface-green-7" };

/** A segmented bar of work items by state with a text legend (icon, label, count); role="img" summarises the same counts for assistive tech. */
export function StateBar(props: { counts: Partial<Record<string, number>>; label?: string }): JSX.Element {
  const rows = () => WORK_ITEM_STATES.map((state) => ({ state, count: props.counts[state] ?? 0, theme: statusTheme("workItem", state) })).filter((row) => row.count > 0);
  const total = () => rows().reduce((sum, row) => sum + row.count, 0);
  const summary = () => `${props.label ?? "Work items"}: ${rows().map((row) => `${row.count} ${statusLabel("workItem", row.state).toLowerCase()}`).join(", ")}`;
  return <Show when={total() > 0} fallback={<p class="text-interface text-ink-gray-6">No work items yet.</p>}>
    <div class="flex min-w-0 flex-col gap-2">
      <div role="img" aria-label={summary()} class="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-surface-gray-3">
        <For each={rows()}>{(row) => <span class={`h-full ${FILL[row.theme] ?? FILL.gray}`} style={{ width: `${(row.count / total()) * 100}%` }} />}</For>
      </div>
      <ul class="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-7" aria-hidden="true">
        <For each={rows()}>{(row) => <li class="inline-flex items-center gap-1"><StatusIcon state={row.state} theme={row.theme} />{statusLabel("workItem", row.state)} {row.count}</li>}</For>
      </ul>
    </div>
  </Show>;
}
