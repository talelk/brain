import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type Accessor, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Avatar } from "@talelk/newui-atoms";
import type { OverviewWorkspace, QueueRun, QueueRunner } from "@brain/contracts";
import { intlLocale, t, tn } from "../i18n";
import { ago, count, duration, money } from "../lib/format";
import { areaPath, flowLinks, ribbonWidth, STAGES, successRate, type FeedGroup, type Stage, type StageCounts } from "../lib/live";
import { Icon, Keyed } from "./bits";

/** The drawings of the Live screen. Motion is CSS (`.live-*` in index.css) and one counter on `requestAnimationFrame`; all of it stops while the tab is hidden and under `prefers-reduced-motion`. */

const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
export const reduced = (): boolean => motion.matches;

const [seen, setSeen] = createSignal(document.visibilityState === "visible");
document.addEventListener("visibilitychange", () => setSeen(document.visibilityState === "visible"));
/** Whether the tab is on screen. Timers and tweens that nobody sees do nothing. */
export const visible = seen;

/** The time, read again every `everyMs` while the tab is visible. */
export function useTick(everyMs: number): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => { if (visible()) setNow(Date.now()); }, everyMs);
  onCleanup(() => clearInterval(timer));
  return now;
}

/** The time of day, for the wall display. */
export const Tick = (props: { now: number }): JSX.Element => <>{new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit" }).format(props.now)}</>;

/** A number that glides to its new value; it jumps when the tab is hidden or the person asked for less motion. */
export function Counter(props: { value: number; format?: (value: number) => string; class?: string; testId?: string }): JSX.Element {
  const [shown, setShown] = createSignal(props.value);
  let frame = 0;
  createEffect(on(() => props.value, (to) => {
    cancelAnimationFrame(frame);
    const from = shown();
    if (reduced() || !visible() || from === to) { setShown(to); return; }
    const start = performance.now();
    const step = (now: number): void => {
      const progress = Math.min(1, (now - start) / 600);
      setShown(from + (to - from) * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }, { defer: true }));
  onCleanup(() => cancelAnimationFrame(frame));
  return <span class={`tabular-nums ${props.class ?? ""}`} data-testid={props.testId} data-value={props.value}>{(props.format ?? ((value: number) => String(Math.round(value))))(shown())}</span>;
}

/** An arc around something: `fraction` of the circle, in the colour of its meaning. Decorative; the number it stands for is written beside it. */
export function Ring(props: { fraction: number | null; size?: number; tone?: string; children?: JSX.Element; class?: string }): JSX.Element {
  const size = (): number => props.size ?? 40;
  return (
    <span class={`relative inline-grid shrink-0 place-items-center ${props.class ?? ""}`} style={{ width: `${size()}px`, height: `${size()}px` }}>
      <svg viewBox="0 0 36 36" class="absolute inset-0 size-full -rotate-90 rtl:scale-x-[-1]" aria-hidden="true" fill="none" stroke-width="3.2">
        <circle cx="18" cy="18" r="15.5" stroke="var(--rule-2)" />
        <Show when={props.fraction !== null}>
          <circle cx="18" cy="18" r="15.5" pathLength="100" stroke={props.tone ?? "var(--violet)"} stroke-linecap="round" stroke-dasharray={`${Math.max(1.5, (props.fraction ?? 0) * 100)} 100`} class="live-arc" />
        </Show>
      </svg>
      <span class="relative">{props.children}</span>
    </span>
  );
}

const STAGE_TONE: Record<Stage, string> = { queued: "var(--ink-gray-5)", running: "var(--violet)", checking: "var(--ink-blue-8)", needs: "var(--needs)", done: "var(--ok-mark)", failed: "var(--bad)" };

/** The flow of work: the six counts in a row, thin ribbons between them whose width follows the count, and the last hour's activity underneath. */
export function River(props: { counts: StageCounts; activity: readonly number[]; ambient?: boolean }): JSX.Element {
  const links = createMemo(() => flowLinks(props.counts));
  const largest = (): number => Math.max(1, ...links().map((link) => link.value));
  const total = (): number => STAGES.reduce((sum, stage) => sum + props.counts[stage], 0);
  const x = (stage: Stage): number => (STAGES.indexOf(stage) + 0.5) * 100;
  const shape = createMemo(() => areaPath(props.activity, 240, 28));
  return (
    <div class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 px-3 pt-4 pb-3 sm:px-5" data-testid="river">
      <ul class="grid grid-cols-3 gap-y-5 sm:grid-cols-6" aria-label={t("live.flow.title")}>
        <For each={STAGES}>
          {(stage) => (
            <li class="flex flex-col items-center text-center" data-stage={stage}>
              <span class={`relative grid place-items-center rounded-full px-3 ${stage === "needs" && props.counts.needs > 0 ? "live-attn" : ""}`}>
                <Counter value={props.counts[stage]} testId={`stage-${stage}`} class={`font-display font-semibold leading-none text-ink ${props.ambient ? "text-[4.5rem]" : "text-[2.75rem]"}`} />
              </span>
              <span class="mt-2 flex items-center gap-1.5 t-small font-medium text-ink-2"><span class="size-2 rounded-full" style={{ background: STAGE_TONE[stage] }} aria-hidden="true" />{t(`live.stage.${stage}`)}</span>
              <span class="t-small text-ink-3 min-h-[1.4em]">{stage === "done" || stage === "failed" ? t("live.stage.hour") : ""}</span>
            </li>
          )}
        </For>
      </ul>
      {/* Wide screens: ribbons between the columns. Phones: one bar with each stage's share. */}
      <svg viewBox="0 0 600 100" preserveAspectRatio="none" class="mt-2 hidden h-24 w-full overflow-visible sm:block rtl:scale-x-[-1]" aria-hidden="true" fill="none">
        <For each={[...links()].sort((one, other) => Math.abs(x(other.to) - x(other.from)) - Math.abs(x(one.to) - x(one.from)))}>
          {(link) => {
            const from = x(link.from);
            const to = x(link.to);
            const bend = 30 + (Math.abs(to - from) / 100) * 22;
            const path = `M${from} 0 C${from} ${bend} ${to} ${bend} ${to} 0`;
            return (<>
              <path d={path} stroke={STAGE_TONE[link.to]} stroke-opacity="0.26" stroke-width={ribbonWidth(link.value, largest(), 18)} vector-effect="non-scaling-stroke" />
              <path d={path} stroke={STAGE_TONE[link.to]} stroke-opacity="0.75" stroke-width="1.5" stroke-dasharray="3 9" class="live-flow" vector-effect="non-scaling-stroke" />
            </>);
          }}
        </For>
      </svg>
      <div class="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-gray-2 sm:hidden" aria-hidden="true">
        <For each={STAGES}>{(stage) => <span class="h-full transition-[flex-grow] duration-500" style={{ "flex-grow": props.counts[stage], background: STAGE_TONE[stage], opacity: 0.8 }} />}</For>
        <Show when={total() === 0}><span class="h-full grow" /></Show>
      </div>
      <div class="mt-3 flex items-center gap-3 border-t border-outline-gray-1 pt-3">
        <svg viewBox="0 0 240 28" preserveAspectRatio="none" class="h-7 min-w-0 flex-1 rtl:scale-x-[-1]" aria-hidden="true">
          <path d={shape().area} fill="var(--violet)" fill-opacity="0.12" />
          <path d={shape().line} fill="none" stroke="var(--violet)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        </svg>
        <span class="shrink-0 t-small text-ink-3 tabular-nums">{tn("live.activity", props.activity.reduce((sum, n) => sum + n, 0))}</span>
      </div>
    </div>
  );
}

const THEMES = ["violet", "blue", "green", "amber", "red"] as const;
/** One agent keeps one colour. */
export const themeOf = (name: string): (typeof THEMES)[number] => THEMES[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % THEMES.length] ?? "violet";

/** What ended an attempt, for the pill that is leaving. */
/** How a run left its slot: the state its task is in now, so a retried or checked attempt is not shown as done. */
export type Ending = "done" | "failed" | "stopped" | "running" | "ready" | "waiting" | "needs_you";
export interface Leaving { readonly runner: string; readonly run: QueueRun; readonly state: Ending }

/** A small line of numbers: tokens used so far, sampled each time the page read them. */
function Spark(props: { values: readonly number[] }): JSX.Element {
  const shape = createMemo(() => areaPath(props.values.length > 1 ? props.values : [0, 0], 72, 20));
  return (
    <svg viewBox="0 0 72 20" preserveAspectRatio="none" class="h-5 min-w-0 flex-1 rtl:scale-x-[-1]" aria-hidden="true">
      <Show when={props.values.length < 2}><path d="M0 18H72" fill="none" stroke="var(--rule-2)" stroke-width="1.5" stroke-dasharray="2 4" vector-effect="non-scaling-stroke" /></Show>
      <path d={shape().area} fill-opacity={props.values.length > 1 ? 0.14 : 0} fill="var(--violet)" />
      <path d={shape().line} fill="none" stroke={props.values.length > 1 ? "var(--violet)" : "none"} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" class={props.values.length > 1 ? "live-spark" : ""} />
    </svg>
  );
}

const TEN_MINUTES = 600_000;

/** An attempt in a slot: who runs it, on what, for how long, with its token stream and a ring that fills over ten minutes. */
function Pill(props: { run: QueueRun; samples: readonly number[]; now: number; ending?: Ending; ambient?: boolean }): JSX.Element {
  const run = (): QueueRun => props.run;
  const elapsed = (): number => (run().startedAt ? Math.max(0, props.now - run().startedAt!) : 0);
  const tone = (): string => (props.ending === "done" ? "var(--ok-mark)" : props.ending === "failed" ? "var(--bad)" : props.ending === "stopped" ? "var(--ink-gray-5)" : "var(--violet)");
  return (
    <li class={`live-pill flex items-center gap-3 rounded-control border border-outline-gray-2 bg-surface-elevation-1 px-3 py-2.5 ${props.ending ? "live-leave" : ""}`} data-testid="live-run" data-ending={props.ending}>
      <Ring fraction={props.ending ? 1 : Math.min(1, elapsed() / TEN_MINUTES)} tone={tone()} size={props.ambient ? 52 : 44}>
        <Show when={props.ending} fallback={<Avatar size="md" theme={themeOf(run().agent)} label={run().agent} />}>
          <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke={tone()} stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={props.ending === "failed" ? "M7 7l10 10M17 7L7 17" : props.ending === "stopped" ? "M8 8h8v8H8z" : props.ending === "done" ? "M5 12.5l4.5 4.5L19 7.5" : "M12 12h.01"} pathLength="1" class="live-check" /></svg>
        </Show>
      </Ring>
      <div class="min-w-0 flex-1">
        <A href={`/w/${run().workspaceSlug}/tasks/${run().rootId}?link=${run().taskId}`} class="block truncate t-text font-medium text-ink hover:underline" dir="auto">{run().goalTitle}</A>
        <p class="truncate t-small text-ink-3"><bdi>{run().agent}</bdi> · <bdi>{run().workspaceName}</bdi> · <bdi class="tabular-nums">{props.ending ? t(`state.${props.ending}`) : run().startedAt ? duration(elapsed()) : "…"}</bdi></p>
        <div class="mt-1 flex items-center gap-2">
          <Spark values={props.samples} />
          <span class="shrink-0 t-small text-ink-3 tabular-nums">{t("queue.run.tokens", { n: count(run().tokens) })}</span>
        </div>
      </div>
    </li>
  );
}

/** A runner as a lane: its slots in a row, each holding the attempt that runs there, one that just ended (leaving), or nothing. */
export function Lane(props: { runner: QueueRunner; samples: ReadonlyMap<string, readonly number[]>; leaving: readonly Leaving[]; now: number; ambient?: boolean }): JSX.Element {
  const r = (): QueueRunner => props.runner;
  const mine = (): readonly Leaving[] => props.leaving.filter((entry) => entry.runner === r().id);
  const used = (): number => r().occupied.length + r().hiddenOccupied;
  const free = (): number => Math.max(0, r().slots - used() - mine().length);
  return (
    <li class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4" data-testid="live-lane">
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class={`size-2 rounded-full ${r().online ? "bg-ok-mark live-breathe" : "bg-ink-gray-4"}`} aria-hidden="true" />
        <h3 class="t-head text-ink">{r().name}</h3>
        <span class="t-small text-ink-3">{r().online ? t("queue.runner.online") : t("queue.runner.offline")} · <span data-testid="live-slots">{t("queue.runner.slots", { used: used(), total: r().slots })}</span></span>
      </div>
      <ul class="grid gap-2 sm:grid-cols-2">
        <Keyed each={r().occupied} by={(run) => run.attemptId}>{(run) => <Pill run={run()} samples={props.samples.get(run().attemptId) ?? []} now={props.now} ambient={props.ambient} />}</Keyed>
        <For each={mine()}>{(entry) => <Pill run={entry.run} samples={[]} now={props.now} ending={entry.state} ambient={props.ambient} />}</For>
        <For each={Array.from({ length: r().hiddenOccupied })}>{() => <li class="flex min-h-[5.5rem] items-center rounded-control border border-dashed border-outline-gray-2 bg-surface-gray-1 px-3 t-small text-ink-3">{t("queue.slot.hidden")}</li>}</For>
        <For each={Array.from({ length: free() })}>{() => <li class="live-free flex min-h-[5.5rem] items-center rounded-control border border-dashed border-outline-gray-2 px-3 t-small text-ink-3">{t("queue.slot.free")}</li>}</For>
      </ul>
    </li>
  );
}

/** What an event reads as, with the agent and the goal in it. */
const eventText = (group: FeedGroup): string => t(`live.event.${group.kind}`, { agent: group.agent ?? t("live.event.someone"), goal: group.goalTitle, title: group.title });

/** The feed: one line per kind of thing that happened to a goal, newest first, with a count when it happened many times. */
export function Feed(props: { groups: readonly FeedGroup[]; now: number; shared: boolean }): JSX.Element {
  return (
    <Show when={props.groups.length > 0} fallback={<p class="px-1 py-6 text-center t-small text-ink-3">{t("live.feed.empty")}</p>}>
      <ol class="flex flex-col" data-testid="live-feed">
        <Keyed each={props.groups} by={(group) => group.id}>
          {(group) => (
            <li class="live-arrive flex items-start gap-3 border-b border-outline-gray-1 py-2.5 last:border-b-0">
              <Show when={group().agent && !group().kind.startsWith("goal")} fallback={<span class="grid size-8 shrink-0 place-items-center rounded-full bg-lilac text-ink-2" aria-hidden="true"><Icon name="lucide-target" /></span>}><Avatar size="xl" theme={themeOf(group().agent ?? "")} label={group().agent ?? ""} /></Show>
              <div class="min-w-0 flex-1">
                <A href={`/w/${group().slug}/tasks/${group().rootId}?link=${group().taskId}`} class="t-text text-ink hover:underline" dir="auto">{eventText(group())}</A>
                <Show when={group().count > 1}><span class="ms-2 rounded-full bg-surface-gray-3 px-1.5 text-[0.6875rem] font-semibold leading-[1.125rem] text-ink-gray-8 tabular-nums"><span aria-hidden="true">×{group().count}</span><span class="sr-only">{tn("live.feed.times", group().count)}</span></span></Show>
                <p class="t-small text-ink-3"><Show when={props.shared}>{group().workspace} · </Show>{ago(group().at, props.now)}</p>
              </div>
              <Icon name={group().kind.endsWith("failed") || group().kind === "check-failed" ? "lucide-circle-x" : group().kind.endsWith("done") ? "lucide-circle-check" : group().kind === "task-started" || group().kind === "goal-started" ? "lucide-play" : "lucide-circle-alert"} class={`mt-1 size-4 ${group().kind.endsWith("failed") || group().kind === "check-failed" ? "text-bad" : group().kind.endsWith("done") ? "text-ok" : group().kind.endsWith("started") ? "text-violet-text" : "text-needs-text"}`} />
            </li>
          )}
        </Keyed>
      </ol>
    </Show>
  );
}

/** Spend today against the cap, with the last fourteen days behind it, and the tokens running now. */
export function Ticker(props: { spent: number; cap: number; days: readonly number[]; tokens: number }): JSX.Element {
  const shape = createMemo(() => areaPath(props.days, 280, 56, 4));
  const share = (): number => (props.cap > 0 ? Math.min(1, props.spent / props.cap) : 0);
  return (
    <section class="flex flex-col gap-3 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4" aria-labelledby="live-cost">
      <h2 id="live-cost" class="t-small font-medium text-ink-3">{t("live.cost.title")}</h2>
      <div class="flex flex-wrap items-baseline gap-x-2">
        <Counter value={props.spent} format={money} class="font-display text-3xl font-semibold text-ink" testId="live-spend" />
        <span class="t-small text-ink-3">{props.cap > 0 ? t("live.cost.cap", { cap: money(props.cap) }) : t("overview.spend.nocap")}</span>
      </div>
      <Show when={props.cap > 0}><div class="h-1.5 overflow-hidden rounded-full bg-surface-gray-2" aria-hidden="true"><div class="h-full rounded-full transition-[width] duration-700" style={{ width: `${share() * 100}%`, background: share() > 0.85 ? "var(--needs)" : "var(--violet)" }} /></div></Show>
      <svg viewBox="0 0 280 56" preserveAspectRatio="none" class="h-14 w-full rtl:scale-x-[-1]" role="img" aria-label={t("live.cost.days")}>
        <path d={shape().area} fill="var(--violet)" fill-opacity="0.12" />
        <path d={shape().line} fill="none" stroke="var(--violet)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      </svg>
      <p class="t-small text-ink-3"><Counter value={props.tokens} format={count} class="font-medium text-ink-2" /> {t("live.cost.tokens")}</p>
    </section>
  );
}

/** A workspace as a tile: a ring for how much of today's work finished, what runs and what needs you, and its week when opened. */
export function Tile(props: { workspace: OverviewWorkspace }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const w = (): OverviewWorkspace => props.workspace;
  const rate = (): number | null => successRate(w().doneToday, w().failedToday);
  const week = (): number[] => w().days.slice(-7).map((day) => day.done);
  const shape = createMemo(() => areaPath(week(), 160, 36, 3));
  return (
    <li class={`rounded-card border bg-surface-elevation-1 p-4 ${w().needsYou > 0 ? "border-[var(--needs-line)]" : "border-outline-gray-1"}`} data-testid="live-tile">
      <button type="button" class="flex w-full items-center gap-3 rounded-control text-start focus-visible:focus-ring" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Ring fraction={rate()} tone={rate() !== null && (rate() as number) < 0.5 ? "var(--bad)" : "var(--ok-mark)"} size={48}>
          <span class="t-small font-semibold text-ink tabular-nums">{rate() === null ? "–" : `${Math.round((rate() as number) * 100)}`}</span>
        </Ring>
        <span class="min-w-0 flex-1">
          <span class="block truncate t-text font-medium text-ink">{w().name}</span>
          <span class="block t-small text-ink-3">{rate() === null ? t("live.tile.rate.none") : t("live.tile.rate", { n: Math.round((rate() as number) * 100) })}</span>
        </span>
        <span class="flex shrink-0 flex-col items-end gap-0.5 t-small tabular-nums">
          <span class="text-ink-2">{t("live.tile.running", { n: w().attemptsRunning })}</span>
          <Show when={w().needsYou > 0}><span class="font-medium text-needs-text">{t("live.tile.needs", { n: w().needsYou })}</span></Show>
        </span>
        <Icon name="lucide-chevron-down" class={`size-4 text-ink-3 transition-transform ${open() ? "rotate-180" : ""}`} />
      </button>
      <Show when={open()}>
        <div class="live-arrive mt-3 flex flex-col gap-3 border-t border-outline-gray-1 pt-3">
          <svg viewBox="0 0 160 36" preserveAspectRatio="none" class="h-9 w-full rtl:scale-x-[-1]" aria-hidden="true">
            <path d={shape().area} fill="var(--ok-mark)" fill-opacity="0.15" />
            <path d={shape().line} fill="none" stroke="var(--ok-mark)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
          </svg>
          <p class="t-small text-ink-3">{t("live.tile.detail", { done: w().doneToday, failed: w().failedToday, waiting: w().attemptsWaiting, spent: money(w().spend.todayMicroUsd) })}</p>
          <div class="flex flex-wrap gap-x-4 gap-y-1 t-small">
            <A href={`/w/${w().slug}`} class="font-medium text-violet-text hover:underline">{t("live.tile.open")}</A>
            <A href={`/w/${w().slug}/tasks`} class="text-ink-2 hover:underline">{t("nav.tasks")}</A>
            <A href={`/w/${w().slug}/live`} class="text-ink-2 hover:underline">{t("live.tile.live")}</A>
          </div>
        </div>
      </Show>
    </li>
  );
}
