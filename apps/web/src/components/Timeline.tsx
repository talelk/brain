import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import type { Task, TaskSummary } from "@brain/contracts";
import { direction, intlLocale, t } from "../i18n";
import { useNow } from "../lib/clock";
import { dateTime, duration, isolate, money, titleOf } from "../lib/format";
import { buildTimeline, fractionOf, pan, ticks, zoom, type Timeline as Model, type TimelineBar, type TimelineRow, type TimelineWait, type View } from "../lib/timeline";

/**
 * The Timeline of a goal: a Gantt of its attempts (lib/timeline.ts has the data and the arithmetic). Bars, marks and ticks are drawn as elements positioned by
 * logical, percentage offsets, so a bar is a real button that takes the focus, and right-to-left mirrors the whole axis. The list of attempts is behind it as a table.
 */
const KINDS = ["work", "plan", "check", "judge", "act"] as const;
const LANE = 28;
const STRIP = 7;

const tickLabel = (at: number, span: number): string =>
  new Intl.DateTimeFormat(intlLocale(), span > 2 * 86_400_000 ? { day: "numeric", month: "short" } : span > 600_000 ? { hour: "2-digit", minute: "2-digit" } : { minute: "2-digit", second: "2-digit" }).format(at);

export function Timeline(props: { record: Task; selected: string; onSelect: (id: string) => void }): JSX.Element {
  const now = useNow(3000);
  /** The clock only moves while the goal can still change: a finished goal's model is built once, so its rows and bars keep their identity (and a keyboard user's focus). */
  const settled = (): boolean => ["done", "failed", "stopped"].includes(props.record.state) && props.record.subtasks.every((task) => ["done", "failed", "stopped"].includes(task.state));
  const clock = createMemo((previous: number): number => (settled() ? previous : now()), Date.now());
  const model = createMemo((): Model => buildTimeline(props.record, clock()));
  const whole = (): View => ({ from: model().start, to: model().end });
  const [custom, setCustom] = createSignal<View>();
  const view = (): View => custom() ?? whole();
  const [critical, setCritical] = createSignal(false);
  const [focus, setFocus] = createSignal<string>();
  const [plot, setPlot] = createSignal<HTMLElement>();
  const rtl = (): boolean => direction() === "rtl";
  const zoomed = (): boolean => custom() !== undefined;
  const change = (next: View): void => { setCustom(next.to - next.from >= whole().to - whole().from - 1 ? undefined : next); };
  const zoomBy = (factor: number, anchor = 0.5): void => change(zoom(view(), whole(), factor, rtl() ? 1 - anchor : anchor));
  const panBy = (by: number): void => change(pan(view(), whole(), rtl() ? -by : by));
  const offset = (): number => -new Date().getTimezoneOffset() * 60_000;

  const tasks = createMemo(() => new Map<string, TaskSummary>([props.record, ...props.record.subtasks].map((task) => [task.id, task])));
  const label = (taskId: string): string => (taskId === props.record.id ? t("graph.goal") : titleOf(tasks().get(taskId) as TaskSummary));
  const bars = createMemo((): TimelineBar[] => model().groups.flatMap((group) => group.rows.flatMap((row) => row.bars)));
  const barById = (id: string | undefined): TimelineBar | undefined => bars().find((bar) => bar.id === id);

  const at = (time: number): string => `${fractionOf(view(), time) * 100}%`;
  const wide = (from: number, to: number): string => `${Math.max(0, ((to - from) / (view().to - view().from)) * 100)}%`;
  const inView = (from: number, to: number): boolean => to >= view().from && from <= view().to;

  /** Zoom with a pinch or ctrl and the wheel, move sideways with shift and the wheel or a sideways swipe, drag to move; a plain wheel scrolls the page. */
  const wire = (element: HTMLElement): void => {
    const wheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); const box = (plot() ?? element).getBoundingClientRect(); zoomBy(event.deltaY < 0 ? 1.4 : 1 / 1.4, Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))); }
      else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) { event.preventDefault(); panBy((event.shiftKey ? event.deltaY : event.deltaX) / (plot() ?? element).getBoundingClientRect().width); }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => element.removeEventListener("wheel", wheel));
  };
  let drag: { x: number; from: View } | undefined;
  const move = (event: PointerEvent): void => {
    const element = plot();
    if (!drag || !element) return;
    const by = ((drag.x - event.clientX) / element.getBoundingClientRect().width) * (rtl() ? -1 : 1);
    change(pan(drag.from, whole(), by));
  };

  const kindOf = (bar: TimelineBar): string => t(`attempt.kind.${bar.kind}`);
  const describe = (bar: TimelineBar): string => {
    const waited = bar.start - bar.queuedAt;
    return [`${kindOf(bar)}, ${bar.agent}${bar.round > 1 ? `, ${t("graph.round", { round: bar.round })}` : ""}${bar.retry ? `, ${t("timeline.retry")}` : ""}`, t(`attempt.state.${bar.state}`), duration(bar.end - bar.start),
      ...(waited >= 1000 ? [t("timeline.waited", { time: duration(waited) })] : []), ...(bar.tokens > 0 ? [t("timeline.tokens", { n: bar.tokens.toLocaleString(intlLocale()) })] : []), ...(bar.microUsd > 0 ? [money(bar.microUsd)] : [])].join(" · ");
  };
  const waitText = (wait: TimelineWait): string => `${t(`timeline.wait.${wait.kind}`, { tool: isolate(wait.tool) })}: ${wait.open ? t("timeline.wait.open", { time: duration(wait.to - wait.from) }) : duration(wait.to - wait.from)}`;
  const readout = (): string => {
    const shown = barById(focus());
    if (shown) return `${label(shown.taskId)}: ${describe(shown)}`;
    const mine = bars().filter((bar) => bar.taskId === props.selected);
    const last = mine.at(-1);
    return last ? `${label(last.taskId)}: ${describe(last)}${mine.length > 1 ? ` (${t("timeline.attempts", { n: mine.length })})` : ""}` : t("timeline.hint");
  };
  const height = (row: TimelineRow): number => row.lanes * LANE + (row.waits.length > 0 ? STRIP : 0) + 8;

  return (
    <section class="tl" data-critical={critical()} aria-label={t("timeline.label")} data-testid="timeline" onKeyDown={(event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "+" || event.key === "=") zoomBy(1.5);
      else if (event.key === "-") zoomBy(1 / 1.5);
      else if (event.key === "0") setCustom(undefined);
    }}>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-1" role="group" aria-label={t("timeline.zoom")}>
          <Button variant="outline" size="sm" icon="lucide-zoom-in" aria-label={t("timeline.zoomIn")} onClick={() => zoomBy(1.5)} />
          <Button variant="outline" size="sm" icon="lucide-zoom-out" aria-label={t("timeline.zoomOut")} disabled={!zoomed()} onClick={() => zoomBy(1 / 1.5)} />
          <Button variant="outline" size="sm" icon="lucide-chevron-left" aria-label={t("timeline.earlier")} disabled={!zoomed()} onClick={() => panBy(-0.5)} />
          <Button variant="outline" size="sm" icon="lucide-chevron-right" aria-label={t("timeline.later")} disabled={!zoomed()} onClick={() => panBy(0.5)} />
          <Button variant="ghost" size="sm" disabled={!zoomed()} onClick={() => setCustom(undefined)}>{t("timeline.fit")}</Button>
        </div>
        <label class="ms-auto flex cursor-pointer items-center gap-2 t-small text-ink-2">
          <input type="checkbox" class="size-4 accent-[var(--violet)]" checked={critical()} onChange={(event) => setCritical(event.currentTarget.checked)} />
          {t("timeline.critical")}
        </label>
      </div>

      <div class="tl-grid" ref={wire}>
        <div class="tl-axis" aria-hidden="true" ref={setPlot}>
          <For each={ticks(view(), 7, offset())}>{(tick) => <span class="tl-tick-label" style={{ "inset-inline-start": at(tick) }}>{tickLabel(tick, view().to - view().from)}</span>}</For>
        </div>
        <For each={model().groups}>
          {(group) => (
            <section class="tl-group" aria-label={isolate(group.agent || "Brain")}>
              <h4 class="tl-agent">{isolate(group.agent || "Brain")}</h4>
              <ul>
                <For each={group.rows}>
                  {(row) => (
                    <li class="tl-row" data-selected={props.selected === row.taskId} data-critical-row={model().critical.has(row.taskId)} data-state={row.state}>
                      <button type="button" class="tl-label" aria-current={props.selected === row.taskId ? "true" : undefined} onClick={() => props.onSelect(row.taskId)}>
                        <span class="truncate" dir="auto">{label(row.taskId)}</span>
                        <Show when={model().critical.has(row.taskId)}><span class="tl-flag" title={t("timeline.critical.row")}><span class="lucide-flag" aria-hidden="true" /><span class="sr-only">{t("timeline.critical.row")}</span></span></Show>
                      </button>
                      <div class="tl-plot" style={{ height: `${height(row)}px` }} onPointerDown={(event) => { if (!(event.target as HTMLElement).closest("button")) { drag = { x: event.clientX, from: view() }; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={move} onPointerUp={() => { drag = undefined; }} onPointerCancel={() => { drag = undefined; }}>
                        <For each={ticks(view(), 7, offset())}>{(tick) => <span class="tl-grid-line" aria-hidden="true" style={{ "inset-inline-start": at(tick) }} />}</For>
                        <For each={row.waits}>
                          {(wait) => (
                            <Show when={inView(wait.from, wait.to)}>
                              <button type="button" class="tl-wait" data-open={wait.open} data-kind={wait.kind} style={{ "inset-inline-start": at(wait.from), "inline-size": wide(wait.from, wait.to) }} title={waitText(wait)} aria-label={waitText(wait)} onClick={() => props.onSelect(row.taskId)} />
                            </Show>
                          )}
                        </For>
                        <For each={row.bars}>
                          {(bar) => (
                            <Show when={inView(bar.queuedAt, bar.end)}>
                              <Show when={bar.start - bar.queuedAt > 0}><span class="tl-queued" aria-hidden="true" style={{ "inset-inline-start": at(bar.queuedAt), "inline-size": wide(bar.queuedAt, bar.start), top: `${(row.waits.length > 0 ? STRIP : 0) + bar.lane * LANE + 4}px` }} /></Show>
                              <button type="button" class="tl-bar" data-kind={bar.kind} data-state={bar.state} data-selected={props.selected === row.taskId} title={describe(bar)} aria-label={`${label(row.taskId)}: ${describe(bar)}`}
                                style={{ "inset-inline-start": at(bar.start), "inline-size": wide(bar.start, bar.end), top: `${(row.waits.length > 0 ? STRIP : 0) + bar.lane * LANE + 4}px` }}
                                onClick={() => props.onSelect(row.taskId)} onPointerEnter={() => setFocus(bar.id)} onPointerLeave={() => setFocus(undefined)} onFocus={() => setFocus(bar.id)} onBlur={() => setFocus(undefined)}>
                                <span class="tl-bar-text">{kindOf(bar)}{bar.round > 1 ? ` R${bar.round}` : ""}{bar.retry ? " ↻" : ""}</span>
                              </button>
                            </Show>
                          )}
                        </For>
                        <For each={row.ticks}>
                          {(call) => {
                            const lane = (): number => row.bars.find((bar) => bar.id === call.attemptId)?.lane ?? 0;
                            return <Show when={inView(call.at, call.at)}><span class="tl-call" data-failed={call.failed} aria-hidden="true" style={{ "inset-inline-start": at(call.at), top: `${(row.waits.length > 0 ? STRIP : 0) + lane() * LANE + 4 + 16}px` }} /></Show>;
                          }}
                        </For>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>

      <Show when={model().groups.length === 0}><p class="py-6 text-center t-text text-ink-3">{t("timeline.empty")}</p></Show>
      <p class="mt-3 min-h-[2.5rem] t-small text-ink-2" aria-live="polite" data-testid="timeline-readout">{readout()}</p>
      <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 t-small text-ink-3" aria-label={t("timeline.legend")}>
        <For each={KINDS}>{(kind) => <li class="flex items-center gap-1.5"><span class="tl-swatch" data-kind={kind} aria-hidden="true" />{t(`attempt.kind.${kind}`)}</li>}</For>
        <li class="flex items-center gap-1.5"><span class="tl-swatch" data-kind="work" data-state="failed" aria-hidden="true" />{t("attempt.state.failed")}</li>
        <li class="flex items-center gap-1.5"><span class="tl-swatch tl-swatch-wait" aria-hidden="true" />{t("timeline.legend.person")}</li>
        <li class="flex items-center gap-1.5"><span class="tl-swatch tl-swatch-queued" aria-hidden="true" />{t("timeline.legend.queued")}</li>
      </ul>
      <Show when={model().notStarted > 0}><p class="mt-2 t-small text-ink-3">{t("timeline.notStarted", { n: model().notStarted })}</p></Show>

      <details class="mt-4">
        <summary class="cursor-pointer t-small font-medium text-ink-2">{t("timeline.table")}</summary>
        <div class="mt-2 overflow-x-auto" tabindex="0" role="region" aria-label={t("timeline.table")}>
          <table class="w-full min-w-[34rem] t-small">
            <thead><tr class="text-start text-ink-3">
              <For each={["timeline.col.task", "timeline.col.attempt", "timeline.col.state", "timeline.col.start", "timeline.col.duration", "timeline.col.waited", "timeline.col.cost"] as const}>{(key) => <th scope="col" class="py-1 pe-3 text-start font-medium">{t(key)}</th>}</For>
            </tr></thead>
            <tbody>
              <For each={bars()}>
                {(bar) => (
                  <tr class="border-t border-outline-gray-1">
                    <td class="py-1.5 pe-3"><bdi>{label(bar.taskId)}</bdi></td>
                    <td class="py-1.5 pe-3 whitespace-nowrap">{kindOf(bar)}, <bdi>{bar.agent}</bdi>{bar.round > 1 ? `, ${t("graph.round", { round: bar.round })}` : ""}</td>
                    <td class="py-1.5 pe-3 whitespace-nowrap">{t(`attempt.state.${bar.state}`)}</td>
                    <td class="py-1.5 pe-3 whitespace-nowrap">{dateTime(bar.start)}</td>
                    <td class="py-1.5 pe-3 whitespace-nowrap tabular-nums">{duration(bar.end - bar.start)}</td>
                    <td class="py-1.5 pe-3 whitespace-nowrap tabular-nums">{duration(bar.start - bar.queuedAt)}</td>
                    <td class="py-1.5 whitespace-nowrap tabular-nums">{bar.microUsd > 0 ? money(bar.microUsd) : "–"}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
