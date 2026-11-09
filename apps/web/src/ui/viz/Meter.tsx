import { Show } from "solid-js";
import type { JSX } from "solid-js";

/**
 * A budget meter: settled spend (solid), reserved spend (hatched) and what remains (empty) against a limit.
 * role="progressbar" carries the full sentence as its value text; the legend repeats it visibly so nothing depends on colour.
 */
export function Meter(props: { label: string; settled: number; reserved: number; limit: number; format: (value: number) => string }): JSX.Element {
  const used = () => props.settled + props.reserved;
  const share = (value: number) => `${props.limit > 0 ? Math.min(100, (Math.max(0, value) / props.limit) * 100) : 0}%`;
  const remaining = () => Math.max(0, props.limit - used());
  const text = () => `Settled ${props.format(props.settled)}, reserved ${props.format(props.reserved)}, remaining ${props.format(remaining())} of ${props.format(props.limit)}`;
  return <div class="flex min-w-0 flex-col gap-1.5">
    <div role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={props.limit} aria-valuenow={Math.min(used(), props.limit)} aria-valuetext={text()}
      class="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-gray-3">
      <span class="h-full bg-surface-blue-9" style={{ width: share(props.settled) }} />
      <span class="h-full bg-surface-blue-4" style={{ width: share(props.reserved), "background-image": "repeating-linear-gradient(135deg, transparent 0 3px, rgb(255 255 255 / 0.55) 3px 5px)" }} />
    </div>
    <p class="flex flex-wrap gap-x-3 text-caption text-ink-gray-7" aria-hidden="true">
      <span>Settled {props.format(props.settled)}</span>
      <Show when={props.reserved > 0}><span>Reserved {props.format(props.reserved)}</span></Show>
      <span>Remaining {props.format(remaining())}</span>
    </p>
  </div>;
}
