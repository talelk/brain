import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { A, useParams, useSearchParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { EmptyState } from "@talelk/newui-molecules";
import { Section, StatGrid } from "@talelk/newui-organisms";
import type { InsightDays, InsightPercentiles, InsightRank, Insights } from "@brain/contracts";
import { useQuery } from "../data/api";
import { useSession } from "../data/session";
import { intlLocale, t, tn } from "../i18n";
import { count, duration, money } from "../lib/format";
import { FAILURE_BUCKETS, INSIGHT_DAYS } from "../lib/model";
import { Head } from "../components/Shell";
import { Ready } from "../components/bits";
import { DayBars, Heat, RankList, Spread, type RankRow } from "../components/InsightCharts";

/** Insights: what happened over the last 7, 30 or 90 days, for the workspaces a person sees or for one (docs/model.md, "The timeline and Insights"). */
const UTC = { timeZone: "UTC" } as const;
const dayOf = (day: string, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }): string => new Intl.DateTimeFormat(intlLocale(), { ...options, ...UTC }).format(Date.parse(`${day}T00:00:00Z`));
const weekdays = (style: "short" | "long"): string[] => Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(intlLocale(), { weekday: style, ...UTC }).format(Date.UTC(2024, 0, 1 + index)));
const hour = (value: number): string => `${String(value).padStart(2, "0")}:00`;
const peak = (values: readonly number[]): number => Math.max(0, ...values);
type Dimension = "workspace" | "agent" | "play" | "tool";
type Measure = "money" | "time";

function Card(props: { title: string; value?: string; testid?: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4">
      <div class="mb-2 flex items-baseline justify-between gap-3"><h3 class="t-small font-medium text-ink-2">{props.title}</h3><span class="t-title tabular-nums text-ink" data-testid={props.testid}>{props.value}</span></div>
      {props.children}
    </div>
  );
}

function Range(props: { days: InsightDays; onPick: (days: InsightDays) => void }): JSX.Element {
  return (
    <div class="flex items-center gap-1" role="group" aria-label={t("insights.range")} data-testid="insights-range">
      <For each={INSIGHT_DAYS}>{(days) => <Button variant={props.days === days ? "solid" : "outline"} size="sm" aria-pressed={props.days === days} onClick={() => props.onPick(days)}>{t("insights.range.days", { n: days })}</Button>}</For>
    </div>
  );
}

/** Where the work happens: goals started per day as a calendar (weeks across, Monday first) and attempts started by weekday and hour. */
function When(props: { data: Insights }): JSX.Element {
  const first = (): number => (new Date(`${props.data.days[0]}T00:00:00Z`).getUTCDay() + 6) % 7;
  const weeks = (): number => Math.ceil((first() + props.data.days.length) / 7);
  const index = (row: number, col: number): number => col * 7 + row - first();
  const months = (): Array<{ col: number; text: string }> => Array.from({ length: weeks() }, (_, col) => col).flatMap((col) => {
    const day = props.data.days[Math.max(0, index(0, col))] ?? "";
    return col === 0 || (day !== "" && Number(day.slice(8)) <= 7) ? [{ col, text: dayOf(day, { month: "short" }) }] : [];
  });
  return (
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Card title={t("insights.calendar")} value={count(props.data.totals.goals)} testid="goals-total">
        <Heat label={t("insights.calendar")} size={weeks() <= 5 ? "2.25rem" : weeks() <= 10 ? "1.75rem" : undefined} rows={7} cols={weeks()} rowLabels={weekdays("short").map((name, row) => (row % 2 === 0 ? name : ""))} colLabels={months()} max={peak(props.data.calendar)} less={t("insights.heat.less")} more={t("insights.heat.more")}
          cell={(row, col) => { const at = index(row, col); const day = props.data.days[at]; return day === undefined || at < 0 ? null : { value: props.data.calendar[at] ?? 0, label: tn("insights.cell.goal", props.data.calendar[at] ?? 0, { day: dayOf(day) }) }; }} />
      </Card>
      <Card title={t("insights.load")} value={count(props.data.totals.attempts)}>
        <Heat label={t("insights.load")} rows={7} cols={24} rowLabels={weekdays("short")} colLabels={[0, 6, 12, 18].map((col) => ({ col, text: hour(col) }))} max={peak(props.data.load)} less={t("insights.heat.less")} more={t("insights.heat.more")}
          cell={(row, col) => ({ value: props.data.load[row * 24 + col] ?? 0, label: tn("insights.cell.attempt", props.data.load[row * 24 + col] ?? 0, { day: weekdays("long")[row] ?? "", hour: hour(col) }) })} />
      </Card>
    </div>
  );
}

/** Small multiples: the same days, one chart for each way a goal can go. */
function Outcomes(props: { data: Insights }): JSX.Element {
  const series = (): Array<{ key: "done" | "failed" | "asked"; tone: "ok" | "bad" | "needs"; title: string; total: number }> => [
    { key: "done", tone: "ok", title: t("insights.outcome.done"), total: props.data.totals.done },
    { key: "failed", tone: "bad", title: t("insights.outcome.failed"), total: props.data.totals.failed },
    { key: "asked", tone: "needs", title: t("insights.outcome.asked"), total: props.data.totals.asked },
  ];
  const last = (): number => props.data.days.length - 1;
  return (
    <div class="grid gap-4 md:grid-cols-3">
      <For each={series()}>
        {(entry) => {
          const values = (): number[] => props.data.outcomes.map((day) => day[entry.key]);
          return (
            <Card title={entry.title} value={count(entry.total)}>
              <DayBars values={values()} tone={entry.tone} name={entry.title} label={(at) => `${dayOf(props.data.days[at] ?? "")}: ${values()[at] ?? 0}`} />
              <div class="mt-1 flex justify-between t-small text-ink-3"><span>{dayOf(props.data.days[0] ?? "", { day: "numeric", month: "short" })}</span><span>{dayOf(props.data.days[last()] ?? "", { day: "numeric", month: "short" })}</span></div>
            </Card>
          );
        }}
      </For>
    </div>
  );
}

/** Where time and money go, ranked, by workspace, agent, Play or tool. */
function Goes(props: { data: Insights; shared: boolean }): JSX.Element {
  const dimensions = (): Dimension[] => (props.shared ? ["workspace", "agent", "play", "tool"] : ["agent", "play", "tool"]);
  const [dimension, setDimension] = createSignal<Dimension>(props.shared ? "workspace" : "agent");
  const [measure, setMeasure] = createSignal<Measure>("money");
  const ranks = (): readonly InsightRank[] => (dimension() === "workspace" ? props.data.byWorkspace : dimension() === "agent" ? props.data.byAgent : props.data.byPlay);
  const rows = createMemo((): RankRow[] => {
    if (dimension() === "tool") {
      const byTime = measure() === "time";
      return [...props.data.byTool].sort((a, b) => (byTime ? b.ms - a.ms : b.calls - a.calls)).map((tool) => ({ key: tool.tool, label: tool.tool, value: byTime ? tool.ms : tool.calls, text: byTime ? duration(tool.ms) : tn("insights.calls", tool.calls), sub: tool.failed > 0 ? tn("insights.failedCalls", tool.failed) : undefined, trend: tool.perDay }));
    }
    const money$ = measure() === "money";
    return [...ranks()].sort((a, b) => (money$ ? b.microUsd - a.microUsd : b.ms - a.ms)).slice(0, 8).map((rank) => ({
      key: rank.key, label: rank.label || t("insights.noPlay"), value: money$ ? rank.microUsd : rank.ms, text: money$ ? money(rank.microUsd) : duration(rank.ms), sub: tn("insights.attempts", rank.attempts), trend: money$ ? rank.microPerDay : rank.msPerDay,
    }));
  });
  return (
    <div class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-1" role="group" aria-label={t("insights.by")}>
          <For each={dimensions()}>{(entry) => <Button variant={dimension() === entry ? "solid" : "outline"} size="sm" aria-pressed={dimension() === entry} onClick={() => setDimension(entry)}>{t(`insights.by.${entry}`)}</Button>}</For>
        </div>
        <div class="flex items-center gap-1" role="group" aria-label={t("insights.measure")}>
          <For each={["money", "time"] as const}>{(entry) => <Button variant={measure() === entry ? "solid" : "outline"} size="sm" aria-pressed={measure() === entry} onClick={() => setMeasure(entry)}>{t(`insights.measure.${entry}`)}</Button>}</For>
        </div>
      </div>
      <Show when={dimension() === "tool" && measure() === "money"}><p class="mb-3 t-small text-ink-3">{t("insights.tool.note")}</p></Show>
      <Show when={rows().length > 0} fallback={<p class="t-small text-ink-3">{t("insights.none")}</p>}><RankList rows={rows()} label={t(`insights.by.${dimension()}`)} /></Show>
    </div>
  );
}

function Durations(props: { title: string; rows: readonly InsightPercentiles[]; fallback: string }): JSX.Element {
  const slowest = (): number => Math.max(1, ...props.rows.map((row) => row.p90));
  return (
    <Card title={props.title}>
      <Show when={props.rows.length > 0} fallback={<p class="t-small text-ink-3">{t("insights.none")}</p>}>
        <ol class="rank rank-stack" aria-label={props.title}>
          <For each={props.rows}>
            {(row) => (
              <li class="rank-row">
                <span class="rank-label" dir="auto"><bdi>{row.label || props.fallback}</bdi><span class="text-ink-3"> · {tn("insights.samples", row.n)}</span></span>
                <span class="rank-track"><Spread p50={row.p50} p90={row.p90} peak={slowest()} /></span>
                <span class="rank-value">{t("insights.p", { p50: duration(row.p50), p90: duration(row.p90) })}</span>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </Card>
  );
}

function Slow(props: { data: Insights }): JSX.Element {
  const worst = (): { day: string; p90: number } | undefined => props.data.queueWait.map((wait, at) => ({ day: props.data.days[at] ?? "", p90: wait.p90, n: wait.n })).filter((wait) => wait.n > 0).sort((a, b) => b.p90 - a.p90)[0];
  return (
    <div class="flex flex-col gap-4">
      <div class="grid gap-4 lg:grid-cols-2">
        <Durations title={t("insights.plays")} rows={props.data.playDurations} fallback={t("insights.noPlay")} />
        <Durations title={t("insights.agents")} rows={props.data.agentDurations} fallback="" />
      </div>
      <Card title={t("insights.wait")} value={worst() ? duration(worst()?.p90 ?? 0) : "–"}>
        <p class="mb-2 t-small text-ink-3">{worst() ? t("insights.wait.worst", { day: dayOf(worst()?.day ?? ""), p90: duration(worst()?.p90 ?? 0) }) : t("insights.wait.none")}</p>
        <DayBars values={props.data.queueWait.map((wait) => wait.p90)} name={t("insights.wait")} label={(at) => { const wait = props.data.queueWait[at]; return wait && wait.n > 0 ? t("insights.wait.bar", { day: dayOf(props.data.days[at] ?? ""), p50: duration(wait.p50), p90: duration(wait.p90), n: wait.n }) : `${dayOf(props.data.days[at] ?? "")}: –`; }} />
      </Card>
    </div>
  );
}

function Failures(props: { data: Insights }): JSX.Element {
  const total = (): number => props.data.failures.reduce((sum, failure) => sum + failure.count, 0);
  const ordered = (): Insights["failures"] => FAILURE_BUCKETS.flatMap((bucket) => props.data.failures.filter((failure) => failure.bucket === bucket));
  return (
    <Show when={total() > 0} fallback={<p class="t-text text-ink-3">{t("insights.fail.none")}</p>}>
      <div class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4">
        <div class="mb-4 flex h-3 w-full overflow-hidden rounded-full bg-lilac" role="img" aria-label={ordered().map((failure) => `${t(`insights.fail.${failure.bucket}`)}: ${failure.count}`).join(", ")}>
          <For each={ordered()}>{(failure) => <span class="fail-seg" data-bucket={failure.bucket} style={{ "flex-grow": failure.count }} />}</For>
        </div>
        <ul class="grid gap-x-8 gap-y-5 md:grid-cols-2">
          <For each={ordered()}>
            {(failure) => (
              <li>
                <h3 class="flex items-center gap-2 t-text font-medium text-ink"><span class="fail-dot" data-bucket={failure.bucket} aria-hidden="true" />{t(`insights.fail.${failure.bucket}`)}<span class="ms-auto tabular-nums text-ink-2">{tn("insights.fail.count", failure.count)}</span></h3>
                <ul class="mt-1.5 flex flex-col gap-1">
                  <For each={failure.tasks}>{(task) => <li class="min-w-0 t-small"><A href={`/w/${task.workspaceSlug}/tasks/${task.rootId}?link=${task.id}`} class="block truncate text-ink-2 hover:text-ink hover:underline" dir="auto"><bdi>{task.goalTitle}</bdi>{task.title !== task.goalTitle ? <> › <bdi>{task.title}</bdi></> : null}</A></li>}</For>
                </ul>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

function Repeats(props: { data: Insights }): JSX.Element {
  return (
    <Show when={props.data.repeats.length > 0} fallback={<p class="t-text text-ink-3">{t("insights.repeat.none")}</p>}>
      <ul class="divide-y divide-outline-gray-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1">
        <For each={props.data.repeats}>
          {(row) => (
            <li class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <A href={`/w/${row.workspaceSlug}/tasks/${row.lastTaskId}`} class="min-w-0 flex-1 truncate t-text font-medium text-ink hover:underline" dir="auto" title={t("insights.repeat.open")}><bdi>{row.label}</bdi></A>
              <span class="t-small text-ink-3">{t("insights.repeat.row", { n: row.count, cost: money(row.microUsd) })}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function PerDay(props: { data: Insights }): JSX.Element {
  return (
    <details class="mt-2">
      <summary class="cursor-pointer t-small font-medium text-ink-2">{t("insights.table")}</summary>
      <div class="mt-2 max-h-96 overflow-auto" tabindex="0" role="region" aria-label={t("insights.table")}>
        <table class="w-full min-w-[30rem] t-small">
          <thead><tr class="text-ink-3"><For each={["day", "goals", "done", "failed", "asked", "wait"] as const}>{(key) => <th scope="col" class="sticky top-0 bg-surface-elevation-1 py-1 pe-3 text-start font-medium">{t(`insights.col.${key}`)}</th>}</For></tr></thead>
          <tbody>
            <For each={props.data.days}>
              {(day, at) => (
                <tr class="border-t border-outline-gray-1 tabular-nums">
                  <th scope="row" class="py-1 pe-3 text-start font-normal">{dayOf(day)}</th>
                  <td class="pe-3">{props.data.calendar[at()]}</td><td class="pe-3">{props.data.outcomes[at()]?.done}</td><td class="pe-3">{props.data.outcomes[at()]?.failed}</td><td class="pe-3">{props.data.outcomes[at()]?.asked}</td>
                  <td>{(props.data.queueWait[at()]?.n ?? 0) > 0 ? duration(props.data.queueWait[at()]?.p90 ?? 0) : "–"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default function InsightsScreen(): JSX.Element {
  const session = useSession();
  const params = useParams<{ slug?: string }>();
  const [search, setSearch] = useSearchParams<{ days?: string }>();
  const days = (): InsightDays => (INSIGHT_DAYS.find((entry) => String(entry) === search.days) ?? 30);
  const place = createMemo(() => session.workspaces().find((workspace) => workspace.slug === params.slug));
  const insights = useQuery("insights", () => (params.slug === undefined ? { days: days(), tzOffsetMinutes: -new Date().getTimezoneOffset() } : place() ? { workspaceId: (place() as { id: string }).id, days: days(), tzOffsetMinutes: -new Date().getTimezoneOffset() } : undefined));
  const crumbs = (): Array<{ label: string; route?: string }> => (place() ? [{ label: place()?.name ?? "", route: `/w/${params.slug}` }, { label: t("nav.insights") }] : [{ label: t("nav.overview"), route: "/" }, { label: t("nav.insights") }]);
  const stats = (d: Insights) => {
    const ended = d.totals.done + d.totals.failed;
    return [
      { label: t("insights.stat.goals"), icon: "lucide-target", value: count(d.totals.goals), hint: t("insights.stat.goals.hint", { done: d.totals.done, failed: d.totals.failed }) },
      { label: t("insights.stat.rate"), icon: "lucide-circle-check", value: ended === 0 ? "–" : new Intl.NumberFormat(intlLocale(), { style: "percent" }).format(d.totals.done / ended), hint: t("insights.stat.rate.hint") },
      { label: t("insights.stat.asked"), icon: "lucide-circle-alert", value: count(d.totals.asked), hint: t("insights.stat.asked.hint") },
      { label: t("insights.stat.time"), icon: "lucide-timer", value: d.totals.runMs === 0 ? "–" : duration(d.totals.runMs), hint: tn("insights.attempts", d.totals.attempts) },
      { label: t("insights.stat.spend"), icon: "lucide-wallet", value: money(d.totals.microUsd), hint: t("insights.stat.spend.hint", { n: count(d.totals.tokens) }) },
    ];
  };
  return (
    <>
      <Head title={t("insights.title")} text={t("insights.title")} description={t("insights.text")} breadcrumbs={crumbs()} />
      <Ready shape="cards" data={insights.data()} error={insights.error()} retry={insights.refetch}>
        {(data) => (
          <div class="flex flex-col gap-8">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <p class="t-small text-ink-3">{t("insights.period", { from: dayOf(data().days[0] ?? "", { day: "numeric", month: "short" }), to: dayOf(data().days.at(-1) ?? "", { day: "numeric", month: "short", year: "numeric" }) })} {t("insights.zone")}</p>
              <Range days={days()} onPick={(value) => setSearch({ days: value === 30 ? undefined : String(value) }, { replace: true })} />
            </div>
            <Show when={data().totals.goals > 0 || data().totals.attempts > 0} fallback={<EmptyState icon="lucide-chart-no-axes-combined" title={t("insights.empty")} description={t("insights.empty.text")} />}>
              <StatGrid stats={stats(data())} columns={4} class="md:grid-cols-5 lg:grid-cols-5 min-[360px]:max-md:[&>*:last-child]:col-span-2" />
              <Section title={t("insights.when")} description={t("insights.when.text")} headingLevel={2}><When data={data()} /></Section>
              <Section title={t("insights.outcomes")} description={t("insights.outcomes.text")} headingLevel={2}><Outcomes data={data()} /><PerDay data={data()} /></Section>
              <Section title={t("insights.goes")} description={t("insights.goes.text")} headingLevel={2}><Goes data={data()} shared={params.slug === undefined && data().byWorkspace.length > 1} /></Section>
              <Section title={t("insights.slow")} description={t("insights.slow.text")} headingLevel={2}><Slow data={data()} /></Section>
              <Section title={t("insights.fail")} description={t("insights.fail.text")} headingLevel={2}><Failures data={data()} /></Section>
              <Section title={t("insights.repeat")} description={t("insights.repeat.text")} headingLevel={2}><Repeats data={data()} /></Section>
            </Show>
          </div>
        )}
      </Ready>
    </>
  );
}
