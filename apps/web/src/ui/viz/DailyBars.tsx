import { For, createSignal } from "solid-js";
import type { JSX } from "solid-js";

export interface DailyBar { /** The day, `YYYY-MM-DD` (UTC). */ day: string; value: number }

/** A UTC calendar day as a short date; the series is bucketed in UTC, so it is read in UTC too. */
export const dayLabel = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * One series of values per day as thin bars on a shared zero baseline: one hue, no legend box (the title names the series), the highest value
 * labelled at the top and the first and last day under the axis. Hovering or focusing a day reads its value in the line above, and role="img"
 * carries the whole summary for assistive tech; the same numbers are always available as a table next to this chart. A day with no value has
 * no bar but keeps its place, so gaps in spend read as gaps.
 */
export function DailyBars(props: { label: string; summary: string; bars: readonly DailyBar[]; format: (value: number) => string; testId?: string }): JSX.Element {
  const peak = () => Math.max(1, ...props.bars.map((bar) => bar.value));
  const [hovered, setHovered] = createSignal<DailyBar | undefined>();
  const first = () => props.bars[0], last = () => props.bars[props.bars.length - 1];
  return <figure class="m-0 flex min-w-0 flex-col gap-1" data-testid={props.testId}>
    <figcaption class="min-h-[1.25rem] text-caption text-ink-gray-7" aria-hidden="true" data-testid="daily-bars-readout">
      {hovered() ? `${dayLabel(hovered()!.day)}: ${props.format(hovered()!.value)}` : props.label}
    </figcaption>
    <div class="relative" role="img" aria-label={props.summary}>
      <span class="pointer-events-none absolute -top-0.5 left-0 z-10 rounded-sm bg-surface-white/80 px-1 text-caption tabular-nums text-ink-gray-6" aria-hidden="true">{props.format(peak())}</span>
      <div class="flex h-32 items-end gap-px border-b border-outline-gray-3 border-t border-t-outline-gray-1" onPointerLeave={() => setHovered(undefined)}>
        <For each={props.bars}>{(bar) => <div class="group flex h-full min-w-0 flex-1 items-end hover:bg-surface-gray-2" data-testid="daily-bar" data-day={bar.day} data-value={bar.value}
          onPointerEnter={() => setHovered(bar)} title={`${dayLabel(bar.day)}: ${props.format(bar.value)}`}>
          <div class="w-full rounded-t-[2px] bg-surface-blue-7" style={{ height: bar.value > 0 ? `max(2px, ${(bar.value / peak()) * 100}%)` : "0" }} />
        </div>}</For>
      </div>
      <div class="mt-1 flex justify-between text-caption tabular-nums text-ink-gray-6" aria-hidden="true"><span>{first() ? dayLabel(first()!.day) : ""}</span><span>{last() ? dayLabel(last()!.day) : ""}</span></div>
    </div>
  </figure>;
}
