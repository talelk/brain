import type { JSX } from "solid-js";
import { BarChart, ChartLegend } from "@talelk/newui-charts";
import type { OverviewWorkspace } from "@brain/contracts";
import { direction, intlLocale, t } from "../i18n";
import { money } from "../lib/format";

/** The two charts of the Overview: goals finished and spend, a bar per day, stacked by workspace. Kept apart because the chart engine is a large download. */
export default function Charts(props: { workspaces: readonly OverviewWorkspace[] }): JSX.Element {
  const dayLabel = (value: unknown): string => new Intl.DateTimeFormat(intlLocale(), { day: "numeric", timeZone: "UTC" }).format(Date.parse(`${String(value)}T00:00:00Z`));
  /** One row per day, one column per workspace. */
  const rows = (pick: (day: OverviewWorkspace["days"][number]) => number): Record<string, unknown>[] =>
    (props.workspaces[0]?.days ?? []).map((day, index) => ({ day: day.day, ...Object.fromEntries(props.workspaces.map((workspace) => [workspace.name, pick(workspace.days[index] ?? day)])) }));
  const names = (): string[] => props.workspaces.map((workspace) => workspace.name);
  return (
    <div class="flex flex-col gap-3">
    <div class="grid gap-3 lg:grid-cols-2">
      <BarChart title={t("overview.chart.goals")} aria-label={t("overview.chart.goals.label")} data={rows((day) => day.done)} x="day" y={names()} stacked palette="categorical" height={220} dir={direction()}
        xAxis={{ type: "category", format: dayLabel }} yAxis={{ min: 0 }} />
      <BarChart title={t("overview.chart.spend")} aria-label={t("overview.chart.spend.label")} data={rows((day) => day.microUsd / 1_000_000)} x="day" y={names()} stacked palette="categorical" height={220} dir={direction()}
        xAxis={{ type: "category", format: dayLabel }} yAxis={{ min: 0, format: (value) => money(value * 1_000_000) }} />
    </div>
    <ChartLegend items={props.workspaces.map((workspace, index) => ({ name: workspace.name, label: workspace.name, color: `var(--chart-${(index % 8) + 1})` }))} />
    </div>
  );
}
