import type { JSX } from "solid-js";
import { NumberCard as ChartNumberCard } from "@talelk/newui-charts";

/**
 * Brain's KPI card over the charts package: a reading plus, when a `trend` series is given, its sparkline and the change across it.
 * Set `negativeIsBetter` for spend and failures so a rise reads as bad.
 */
export function NumberCard(props: { title: string; value: number | string; suffix?: string; prefix?: string; trend?: number[]; negativeIsBetter?: boolean; caption?: string }): JSX.Element {
  const delta = () => props.trend && props.trend.length > 1 ? props.trend[props.trend.length - 1]! - props.trend[0]! : undefined;
  return <ChartNumberCard title={props.title} value={props.value} suffix={props.suffix} prefix={props.prefix} negativeIsBetter={props.negativeIsBetter}
    {...(props.trend ? { sparkline: { data: props.trend } } : {})} delta={delta()} deltaCaption={props.caption ?? "over the period"} />;
}
