import { createSignal, For, Show, type JSX } from "solid-js";
import { direction } from "../i18n";

/**
 * The marks of the Insights screen, built by hand from the design tokens (charts.css): a heat grid, bars by day, a trend line and ranked bars. Each has its words next
 * to it or a table behind it, a cell or a day can be reached with the arrow keys, and what is under the pointer or the focus is said in a line below.
 */

/** Which of four strengths a value is drawn in, against the biggest value; 0 for none. */
export const levelOf = (value: number, max: number): 0 | 1 | 2 | 3 | 4 => (value <= 0 || max <= 0 ? 0 : (Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4));

export interface HeatCell { readonly value: number; readonly label: string }

/** A grid of squares in one blue, light to strong. `cell` is null where the grid has no square (before the first day, after today). */
export function Heat(props: { rows: number; cols: number; cell: (row: number, col: number) => HeatCell | null; rowLabels: readonly string[]; colLabels: ReadonlyArray<{ readonly col: number; readonly text: string }>; label: string; max: number; less: string; more: string; size?: string }): JSX.Element {
  const first = (): [number, number] => { for (let col = 0; col < props.cols; col += 1) for (let row = 0; row < props.rows; row += 1) if (props.cell(row, col)) return [row, col]; return [0, 0]; };
  const [active, setActive] = createSignal<[number, number]>();
  const [said, setSaid] = createSignal("");
  let grid: HTMLDivElement | undefined;
  /** The square that holds the tab stop; when the data changes under it, the first square takes over. */
  const here = (): [number, number] => { const now = active(); return now && props.cell(now[0], now[1]) ? now : first(); };
  const go = (row: number, col: number): void => {
    setActive([row, col]);
    setSaid(props.cell(row, col)?.label ?? "");
    queueMicrotask(() => grid?.querySelector<HTMLElement>(`[data-r="${row}"][data-c="${col}"]`)?.focus());
  };
  /** The next square in a direction, skipping places with none. */
  const step = (dRow: number, dCol: number): void => {
    const [row, col] = here();
    for (let r = row + dRow, c = col + dCol; r >= 0 && r < props.rows && c >= 0 && c < props.cols; r += dRow, c += dCol) if (props.cell(r, c)) { go(r, c); return; }
  };
  const key = (event: KeyboardEvent): void => {
    const flip = direction() === "rtl" ? -1 : 1;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -flip], ArrowRight: [0, flip] };
    const move = moves[event.key];
    if (move) { event.preventDefault(); step(move[0], move[1]); }
    else if (event.key === "Home") { event.preventDefault(); go(...first()); }
  };
  return (
    <div>
      <div class="heat-scroll">
        <div class="heat" ref={grid} role="grid" aria-label={props.label} style={{ "--cols": props.cols, ...(props.size ? { "--cell": props.size } : {}) }} onKeyDown={key}>
          <div class="heat-cols" aria-hidden="true">
            <For each={props.colLabels}>{(entry) => <span style={{ "grid-column": `${entry.col + 2} / span 4` }}>{entry.text}</span>}</For>
          </div>
          <For each={Array.from({ length: props.rows }, (_, row) => row)}>
            {(row) => (
              <div role="row" class="heat-row">
                <span class="heat-row-label" role="rowheader">{props.rowLabels[row]}</span>
                <For each={Array.from({ length: props.cols }, (_, col) => col)}>
                  {(col) => {
                    const cell = (): HeatCell | null => props.cell(row, col);
                    return (
                      <Show when={cell()} fallback={<span class="heat-gap" aria-hidden="true" />}>
                        {(found) => (
                          <span role="gridcell" class="heat-cell" data-level={levelOf(found().value, props.max)} data-r={row} data-c={col} tabindex={here()[0] === row && here()[1] === col ? 0 : -1} aria-label={found().label}
                            onFocus={() => { setActive([row, col]); setSaid(found().label); }} onPointerEnter={() => setSaid(found().label)} onPointerLeave={() => setSaid("")} onClick={() => go(row, col)} />
                        )}
                      </Show>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p class="min-h-5 t-small text-ink-2" aria-live="polite">{said()}</p>
        <div class="flex items-center gap-1.5 t-small text-ink-3" aria-hidden="true">{props.less}<For each={[0, 1, 2, 3, 4]}>{(level) => <span class="heat-cell heat-key" data-level={level} />}</For>{props.more}</div>
      </div>
    </div>
  );
}

/** One bar for each day (left to right, oldest first; right to left in Arabic). The arrow keys move over the days and the line above says what the day holds. */
export function DayBars(props: { values: readonly number[]; label: (index: number) => string; name: string; tone?: "ok" | "bad" | "needs" | "base"; max?: number }): JSX.Element {
  const peak = (): number => Math.max(1, props.max ?? 0, ...props.values);
  const [at, setAt] = createSignal<number>();
  const rtl = (): boolean => direction() === "rtl";
  const last = (): number => props.values.length - 1;
  const key = (event: KeyboardEvent): void => {
    const delta = event.key === "ArrowLeft" ? (rtl() ? 1 : -1) : event.key === "ArrowRight" ? (rtl() ? -1 : 1) : event.key === "Home" ? -Infinity : event.key === "End" ? Infinity : 0;
    if (delta === 0) return;
    event.preventDefault();
    setAt(Math.min(last(), Math.max(0, (at() ?? last()) + delta)));
  };
  return (
    <div>
      <p class="min-h-5 t-small text-ink-2" aria-live="polite">{at() === undefined ? "" : props.label(at() as number)}</p>
      <div class="daybars" data-tone={props.tone ?? "base"} role="group" tabindex={0} aria-label={props.name} onKeyDown={key} onBlur={() => setAt(undefined)} onPointerLeave={() => setAt(undefined)}>
        <For each={props.values}>{(value, index) => <span class="daybar" data-active={at() === index()} data-zero={value === 0} style={{ "--h": `${(value / peak()) * 100}%` }} onPointerEnter={() => setAt(index())}><span /></span>}</For>
      </div>
    </div>
  );
}

/** A line of values over the window, drawn small beside the number it belongs to. */
export function Trend(props: { values: readonly number[]; class?: string }): JSX.Element {
  const path = (): string => {
    const peak = Math.max(...props.values, 0);
    if (props.values.length < 2 || peak === 0) return "";
    return props.values.map((value, index) => `${index === 0 ? "M" : "L"}${((index / (props.values.length - 1)) * 100).toFixed(2)},${(22 - (value / peak) * 20).toFixed(2)}`).join(" ");
  };
  return (
    <svg class={`trend ${props.class ?? ""}`} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <Show when={path()} fallback={<line x1="0" y1="22" x2="100" y2="22" />}><path d={path()} /></Show>
    </svg>
  );
}

export interface RankRow { readonly key: string; readonly label: string; readonly value: number; readonly text: string; readonly sub?: string; readonly trend?: readonly number[] }
/** Things ranked by one number: a bar as long as its share of the biggest, the number in words, and a small trend. */
export function RankList(props: { rows: readonly RankRow[]; label: string }): JSX.Element {
  const peak = (): number => Math.max(1, ...props.rows.map((row) => row.value));
  return (
    <ol class="rank" aria-label={props.label}>
      <For each={props.rows}>
        {(row) => (
          <li class="rank-row">
            <span class="rank-label" dir="auto"><bdi>{row.label}</bdi><Show when={row.sub}><span class="text-ink-3"> · {row.sub}</span></Show></span>
            <span class="rank-track" aria-hidden="true"><span class="rank-fill" style={{ "inline-size": `${Math.max(2, (row.value / peak()) * 100)}%` }} /></span>
            <span class="rank-value">{row.text}</span>
            <Show when={row.trend}>{(trend) => <Trend values={trend()} class="rank-trend" />}</Show>
          </li>
        )}
      </For>
    </ol>
  );
}

/** A bar that runs from nothing to the slow end (p90) with a mark at the typical value (p50). */
export function Spread(props: { p50: number; p90: number; peak: number }): JSX.Element {
  const share = (value: number): string => `${Math.min(100, (value / Math.max(1, props.peak)) * 100)}%`;
  return <span class="spread" aria-hidden="true"><span class="spread-p90" style={{ "inline-size": share(props.p90) }} /><span class="spread-p50" style={{ "inset-inline-start": share(props.p50) }} /></span>;
}
