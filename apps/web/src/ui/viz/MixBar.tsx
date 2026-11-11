import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

export interface MixSegment { label: string; count: number; tone?: "blue" | "green" | "amber" | "red" | "gray" }

const FILL: Record<string, string> = { gray: "bg-surface-gray-5", blue: "bg-surface-blue-7", red: "bg-surface-red-7", amber: "bg-surface-amber-6", green: "bg-surface-green-7" };

/** A segmented proportion bar with a visible text legend (label and count, never colour alone); role="img" repeats the counts for assistive tech. */
export function MixBar(props: { label: string; segments: MixSegment[]; empty?: string }): JSX.Element {
  const rows = () => props.segments.filter((segment) => segment.count > 0);
  const total = () => rows().reduce((sum, segment) => sum + segment.count, 0);
  return <Show when={total() > 0} fallback={<p class="text-interface text-ink-gray-6">{props.empty ?? "Nothing to show yet."}</p>}>
    <div class="flex min-w-0 flex-col gap-1.5">
      <p class="text-caption font-medium text-ink-gray-7">{props.label}</p>
      <Show when={rows().length > 1}><div role="img" aria-label={`${props.label}: ${rows().map((segment) => `${segment.count} ${segment.label.toLowerCase()}`).join(", ")}`} class="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-gray-3">
        <For each={rows()}>{(segment) => <span class={`h-full ${FILL[segment.tone ?? "gray"]}`} style={{ width: `${(segment.count / total()) * 100}%` }} />}</For>
      </div></Show>
      <ul class="flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-ink-gray-7" aria-hidden={rows().length > 1}>
        <For each={rows()}>{(segment) => <li>{segment.label} {segment.count}</li>}</For>
      </ul>
    </div>
  </Show>;
}
