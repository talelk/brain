import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { QualitySummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { qualityBreakdownRead, type BreakdownRow, type QualityBreakdown } from "../../data/engine";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { failureSentence } from "../../ui/components/TaskFailure";
import { formatDateTime, formatUsd } from "../../ui/format";
import { t, tn, type MessageKey } from "../../i18n";

type Metric = QualitySummary["metrics"][number];

const METRICS: Readonly<Record<string, { label: MessageKey; definition: MessageKey }>> = {
  "verified-unaided": { label: "quality.metric.verified-unaided.label", definition: "quality.metric.verified-unaided.definition" },
  "stall-rate": { label: "quality.metric.stall-rate.label", definition: "quality.metric.stall-rate.definition" },
  "reopen-rate": { label: "quality.metric.reopen-rate.label", definition: "quality.metric.reopen-rate.definition" },
  "cost-per-verified-task": { label: "quality.metric.cost-per-verified-task.label", definition: "quality.metric.cost-per-verified-task.definition" },
  "time-to-first-result": { label: "quality.metric.time-to-first-result.label", definition: "quality.metric.time-to-first-result.definition" },
};
/** The metric's name and definition in the interface language; a figure Brain adds later keeps the server's own words. */
const metricLabel = (metric: Metric): string => (METRICS[metric.id] ? t(METRICS[metric.id]!.label) : metric.label);
const metricDefinition = (metric: Metric): string => (METRICS[metric.id] ? t(METRICS[metric.id]!.definition) : metric.definition);

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t("quality.duration.under");
  if (minutes < 90) return t("quality.duration.min", { n: minutes });
  const hours = minutes / 60;
  return hours < 48 ? t("quality.duration.hours", { n: hours.toFixed(1).replace(/\.0$/, "") }) : t("quality.duration.days", { n: (hours / 24).toFixed(1).replace(/\.0$/, "") });
}

const percent = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;

/** The figure as a person reads it; "No data yet" when the window holds nothing to divide. */
export function metricValue(metric: Metric): string {
  if (metric.value === undefined) return t("quality.noData");
  if (metric.unit === "ratio") return percent(metric.value);
  if (metric.unit === "micro-usd") return formatUsd(metric.value);
  return duration(metric.value);
}

function basis(metric: Metric): string {
  if (metric.unit === "ratio") return t("quality.basis.ratio", { numerator: metric.numerator ?? 0, denominator: metric.denominator ?? 0 });
  if (metric.unit === "micro-usd") return tn("quality.basis.cost", metric.denominator ?? 0, { amount: formatUsd(metric.numerator) });
  return tn("quality.basis.missions", metric.denominator ?? 0);
}

/** Verified (blue) and stopped (amber) tasks per day as bars; the same numbers are in the label. */
function Trend(props: { row: BreakdownRow; days: number }): JSX.Element {
  const peak = () => Math.max(1, ...props.row.daily.map((day) => Math.max(day.verified, day.parked)));
  const verified = () => props.row.daily.reduce((sum, day) => sum + day.verified, 0);
  const stopped = () => props.row.daily.reduce((sum, day) => sum + day.parked, 0);
  return <svg role="img" aria-label={t("quality.breakdown.trend", { days: props.days, verified: verified(), stopped: stopped() })} viewBox={`0 0 ${props.row.daily.length * 4} 24`} preserveAspectRatio="none" class="h-8 w-full max-w-72 text-ink-blue-8" data-quality-trend>
    <For each={props.row.daily}>{(day, index) => <>
      <rect x={index() * 4} y={24 - (day.verified / peak()) * 22} width="1.6" height={(day.verified / peak()) * 22} fill="currentColor" />
      <rect class="text-ink-amber-8" x={index() * 4 + 1.8} y={24 - (day.parked / peak()) * 22} width="1.6" height={(day.parked / peak()) * 22} fill="currentColor" />
    </>}</For>
    <line x1="0" y1="23.6" x2={props.row.daily.length * 4} y2="23.6" stroke="currentColor" stroke-opacity="0.25" stroke-width="0.4" />
  </svg>;
}

function BreakdownCard(props: { name: string; note?: string; row: BreakdownRow; days: number; testId: string }): JSX.Element {
  const rate = (value: number | undefined) => value === undefined ? t("quality.breakdown.noRate") : percent(value);
  return <article class="flex min-w-0 flex-col gap-1.5 rounded-card border border-outline-gray-2 bg-surface-white p-4" data-quality-row={props.testId}>
    <div class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
      <h3 class="min-w-0 break-words text-interface font-medium text-ink-gray-9">{props.name}</h3>
      <Show when={props.note}><span class="text-caption text-ink-gray-6">{props.note}</span></Show>
    </div>
    <p class="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-interface tabular-nums text-ink-gray-8">
      <span>{t("quality.breakdown.verified", { n: props.row.figures.verified })}</span>
      <span>{t("quality.breakdown.stopped", { n: props.row.figures.stalled })}</span>
      <span>{t("quality.breakdown.unaided", { pct: rate(props.row.rates.verifiedUnaided) })}</span>
      <span>{t("quality.breakdown.stall", { pct: rate(props.row.rates.stall) })}</span>
    </p>
    <p class="m-0 flex flex-wrap gap-x-3 text-caption text-ink-gray-6">
      <span>{t("quality.breakdown.missions", { achieved: props.row.figures.missionsAchieved, open: props.row.figures.missionsOpen })}</span>
      <span>{t("quality.breakdown.spend", { amount: formatUsd(props.row.figures.spendMicroUsd) })}</span>
    </p>
    <Trend row={props.row} days={props.days} />
  </article>;
}

/**
 * Quality (owner only): whether Brain is getting better, from deterministic
 * counts over existing records. Each figure shows its definition and window,
 * and the same figures are broken down per practice and per workspace.
 */
export default function QualityPage(): JSX.Element {
  const app = useApp();
  const quality = createScopedRead<QualitySummary>({
    scope: app.scope, live: true,
    load: async (_scope, signal) => {
      const response = await query<{ snapshot: QualitySummary; asOf: string; sourceWatermark: number }>({ queryType: "quality.summary" }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: () => false,
  });
  const breakdown = createScopedRead<QualityBreakdown>({
    scope: app.scope, live: true,
    load: (_scope, signal) => qualityBreakdownRead(signal),
    isEmpty: (data) => data.workspaces.length === 0,
  });
  return <BrainPage title={t("quality.title")} description={t("quality.description")}>
    <PageStack>
      <ScreenRegion state={quality.state()} onRetry={() => void quality.refresh({ force: true })} emptyTitle={t("quality.region.empty.title")} emptyDescription={t("quality.region.empty.description")}>
        <Show when={quality.state().data}>{(data) => <>
          <p class="text-interface text-ink-gray-7">{t("quality.window", { days: data().window.days, from: formatDateTime(data().window.from), to: formatDateTime(data().window.to) })}</p>
          <section aria-label={t("quality.metrics")} class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <For each={data().metrics}>{(metric) =>
              <article class="flex min-w-0 flex-col gap-1 rounded-card border border-outline-gray-2 bg-surface-white p-4" data-metric={metric.id}>
                <h2 class="text-interface font-medium text-ink-gray-8">{metricLabel(metric)}</h2>
                <p class="text-heading tabular-nums text-ink-gray-9">{metricValue(metric)}</p>
                <p class="text-caption text-ink-gray-6">{basis(metric)} · {t("quality.lastDays", { days: data().window.days })}</p>
                <p class="text-caption text-ink-gray-7"><span class="font-medium">{t("quality.definition")}:</span> {metricDefinition(metric)}</p>
              </article>}</For>
          </section>
          <WorkspaceSection title={t("quality.failures.title")} description={t("quality.failures.description")}>
            <Show when={data().failureReasons.items.length} fallback={<p class="text-interface text-ink-gray-7">{t("quality.failures.none")}</p>}>
              <ol class="flex flex-col gap-1.5" aria-label={t("quality.failures.title")}><For each={data().failureReasons.items}>{(item) =>
                <li class="flex items-baseline justify-between gap-3 rounded-control bg-surface-gray-1 px-3 py-2 text-interface" data-failure-code={item.code ?? ""}>
                  <span class="min-w-0 break-words">{item.code ? failureSentence(item.code) : item.reason}</span><span class="tabular-nums text-ink-gray-7">{t("quality.failures.count", { n: item.count })}</span></li>}</For></ol>
            </Show>
          </WorkspaceSection>
        </>}</Show>
      </ScreenRegion>
      <ScreenRegion state={breakdown.state()} onRetry={() => void breakdown.refresh({ force: true })} emptyTitle={t("quality.breakdown.title")} emptyDescription={t("quality.breakdown.empty")}>
        <Show when={breakdown.state().data}>{(data) => <WorkspaceSection title={t("quality.breakdown.title")} description={t("quality.breakdown.description", { days: data().window.days })}>
          <h3 class="m-0 text-interface font-medium text-ink-gray-8">{t("quality.breakdown.practices")}</h3>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-quality-practices>
            <For each={data().practices}>{(entry) => <BreakdownCard testId={`practice:${entry.practice}`} name={entry.practice === "untagged" ? t("quality.breakdown.untagged") : entry.practice} note={tn("quality.breakdown.workspaceCount", entry.workspaces)} row={entry} days={data().window.days} />}</For>
          </div>
          <h3 class="m-0 mt-2 text-interface font-medium text-ink-gray-8">{t("quality.breakdown.workspaces")}</h3>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-quality-workspaces>
            <For each={data().workspaces}>{(entry) => <BreakdownCard testId={`workspace:${entry.workspaceId}`} name={entry.name} note={entry.practice === "untagged" ? t("quality.breakdown.untagged") : entry.practice} row={entry} days={data().window.days} />}</For>
          </div>
        </WorkspaceSection>}</Show>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
