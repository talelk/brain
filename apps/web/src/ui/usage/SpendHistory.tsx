import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { UsageSeries, VerifiedCostReport } from "@brain/contracts";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { t } from "../../i18n";
import { useApp } from "../app-context";
import { formatTokens, formatUsd } from "../format";
import { DailyBars, dayLabel } from "../viz/DailyBars";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };
export const SERIES_DAYS = 30;

/** The daily series of one scope from the Governor: `workspace`, `mission:<id>` or `agent:<id>`. The browser only draws what the ledger says. */
export function useSpendSeries(resource: () => string) {
  const app = useApp();
  return createScopedRead<UsageSeries>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<UsageSeries>>({ queryType: "usage.series", workspaceId: scope.workspaceId, resourceId: resource(), limit: SERIES_DAYS } as never, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
}

/** The chart of one series with its definition and the same values as a table. Dollars lead; a scope that only ran local models (no cost reported) is drawn in tokens. */
export function SpendChart(props: { series: UsageSeries }): JSX.Element {
  const inTokens = () => props.series.totalMicroUsd === 0 && props.series.totalTokens > 0;
  const bars = () => props.series.days.map((day) => ({ day: day.day, value: inTokens() ? day.settledTokens : day.settledMicroUsd }));
  const format = (value: number): string => (inTokens() ? t("spend.tokens", { n: formatTokens(value) }) : formatUsd(value));
  const total = () => (inTokens() ? props.series.totalTokens : props.series.totalMicroUsd);
  const peak = () => bars().reduce((top, bar) => (bar.value > top.value ? bar : top), bars()[0]!);
  const days = () => props.series.window.days;
  return <div class="flex min-w-0 flex-col gap-2" data-testid="spend-series">
    <Show when={total() > 0} fallback={<p class="text-interface text-ink-gray-7" data-testid="spend-none">{t("spend.none", { days: days() })}</p>}>
      <p class="m-0 text-interface text-ink-gray-9" data-testid="spend-total">{t(inTokens() ? "spend.totalTokens" : "spend.total", { amount: format(total()), days: days() })}</p>
      <DailyBars label={t("spend.chart.caption")} bars={bars()} format={format} testId="spend-chart"
        summary={t("spend.chart.summary", { days: days(), total: format(total()), peak: format(peak().value), day: dayLabel(peak().day) })} />
    </Show>
    <p class="m-0 text-caption text-ink-gray-6"><span class="font-medium">{t("spend.definition")}:</span> {props.series.definition}</p>
    <details data-testid="spend-table-toggle">
      <summary class="cursor-pointer text-caption font-medium text-ink-gray-7">{t("spend.table")}</summary>
      <div class="mt-1 max-h-72 overflow-auto">
        <table class="w-full border-collapse text-caption tabular-nums text-ink-gray-8" data-testid="spend-table">
          <caption class="sr-only">{t("spend.table.caption", { days: days() })}</caption>
          <thead><tr class="text-left text-ink-gray-6"><th scope="col" class="py-0.5 pr-3 font-medium">{t("spend.col.day")}</th><th scope="col" class="py-0.5 pr-3 text-right font-medium">{t("spend.col.spend")}</th><th scope="col" class="py-0.5 pr-3 text-right font-medium">{t("spend.col.tokens")}</th><th scope="col" class="py-0.5 text-right font-medium">{t("spend.col.attempts")}</th></tr></thead>
          <tbody><For each={[...props.series.days].reverse()}>{(day) => <tr class="border-t border-outline-gray-1" data-day={day.day}>
            <th scope="row" class="py-0.5 pr-3 text-left font-normal">{day.day}</th><td class="py-0.5 pr-3 text-right">{day.settledMicroUsd === 0 ? "$0" : formatUsd(day.settledMicroUsd)}</td>
            <td class="py-0.5 pr-3 text-right">{formatTokens(day.settledTokens)}</td><td class="py-0.5 text-right">{day.attempts}</td></tr>}</For></tbody>
        </table>
      </div>
    </details>
  </div>;
}

/** "Spend over time": a collapsed section that reads and draws the series only once it is opened. */
export function SpendHistory(props: { resource: string; testId: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return <details class="rounded-card border border-outline-gray-1" data-testid={props.testId} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary class="cursor-pointer px-3 py-2 text-interface font-medium text-ink-gray-8">{t("spend.summary")}</summary>
    <Show when={open()}><SpendBody resource={props.resource} /></Show>
  </details>;
}

function SpendBody(props: { resource: string }): JSX.Element {
  const series = useSpendSeries(() => props.resource);
  return <div class="flex min-w-0 flex-col gap-2 border-t border-outline-gray-1 px-3 py-3">
    <Show when={series.state().data} fallback={<p class="text-caption text-ink-gray-6">{t("spend.loading")}</p>}>{(data) => <SpendChart series={data()} />}</Show>
  </div>;
}

const costOf = (row: { costPerVerifiedMicroUsd?: number | undefined }): string => (row.costPerVerifiedMicroUsd === undefined ? t("verified.noTasks") : formatUsd(row.costPerVerifiedMicroUsd));

function CostTable(props: { title: string; definition: string; first: string; rows: VerifiedCostReport["byAgent"]; name: (id: string | undefined) => string; testId: string }): JSX.Element {
  return <section class="flex min-w-0 flex-col gap-1" aria-label={props.title} data-testid={props.testId}>
    <h4 class="m-0 text-caption font-medium text-ink-gray-7">{props.title}</h4>
    <Show when={props.rows.length} fallback={<p class="text-caption text-ink-gray-7">{t("verified.empty")}</p>}>
      <div class="overflow-x-auto"><table class="w-full border-collapse text-caption tabular-nums text-ink-gray-8">
        <thead><tr class="text-left text-ink-gray-6"><th scope="col" class="py-0.5 pr-3 font-medium">{props.first}</th><th scope="col" class="py-0.5 pr-3 text-right font-medium">{t("verified.col.spend")}</th><th scope="col" class="py-0.5 pr-3 text-right font-medium">{t("verified.col.tasks")}</th><th scope="col" class="py-0.5 text-right font-medium">{t("verified.col.cost")}</th></tr></thead>
        <tbody><For each={props.rows}>{(row) => <tr class="border-t border-outline-gray-1" data-testid="verified-row" data-row={row.id ?? ""}>
          <th scope="row" class="min-w-0 break-words py-0.5 pr-3 text-left font-normal">{props.name(row.id)}</th><td class="py-0.5 pr-3 text-right">{row.spendMicroUsd === 0 ? "$0" : formatUsd(row.spendMicroUsd)}</td>
          <td class="py-0.5 pr-3 text-right">{row.verifiedTasks}</td><td class="py-0.5 text-right font-medium text-ink-gray-9">{costOf(row)}</td></tr>}</For></tbody>
      </table></div>
    </Show>
    <p class="m-0 text-caption text-ink-gray-6"><span class="font-medium">{t("spend.definition")}:</span> {props.definition}</p>
  </section>;
}

/** Cost per verified task by agent and by Play over the trailing window; each table ships its definition, and a row with no verified task says so instead of dividing by zero. */
export function VerifiedCost(): JSX.Element {
  const app = useApp();
  const [open, setOpen] = createSignal(false);
  return <details class="rounded-card border border-outline-gray-1" data-testid="verified-cost" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary class="cursor-pointer px-3 py-2 text-interface font-medium text-ink-gray-8">{t("verified.summary")}</summary>
    <Show when={open()}><VerifiedBody scope={app.scope} /></Show>
  </details>;
}

function VerifiedBody(props: { scope: ReturnType<typeof useApp>["scope"] }): JSX.Element {
  const report = createScopedRead<VerifiedCostReport>({
    scope: props.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<VerifiedCostReport>>({ queryType: "usage.verifiedCost", workspaceId: scope.workspaceId } as never, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  return <div class="flex min-w-0 flex-col gap-3 border-t border-outline-gray-1 px-3 py-3">
    <Show when={report.state().data} fallback={<p class="text-caption text-ink-gray-6">{t("spend.loading")}</p>}>{(data) => <>
      <p class="m-0 text-caption text-ink-gray-7">{t("verified.window", { days: data().window.days })}</p>
      <div class="grid gap-4 md:grid-cols-2">
        <CostTable testId="verified-by-agent" title={t("verified.byAgent")} first={t("verified.col.agent")} rows={data().byAgent} definition={data().byAgentDefinition} name={(id) => id ?? t("verified.noAgent")} />
        <CostTable testId="verified-by-play" title={t("verified.byPlay")} first={t("verified.col.play")} rows={data().byPlay} definition={data().byPlayDefinition} name={(id) => id ?? t("verified.noPlay")} />
      </div>
    </>}</Show>
  </div>;
}
