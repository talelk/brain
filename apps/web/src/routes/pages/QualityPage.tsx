import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { QualitySummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { count, formatDateTime, formatUsd } from "../../ui/format";

type Metric = QualitySummary["metrics"][number];

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1).replace(/\.0$/, "")} h` : `${(hours / 24).toFixed(1).replace(/\.0$/, "")} days`;
}

/** The figure as a person reads it; "No data yet" when the window holds nothing to divide. */
export function metricValue(metric: Metric): string {
  if (metric.value === undefined) return "No data yet";
  if (metric.unit === "ratio") return `${Math.round(metric.value * 1000) / 10}%`;
  if (metric.unit === "micro-usd") return formatUsd(metric.value);
  return duration(metric.value);
}

function basis(metric: Metric): string {
  if (metric.unit === "ratio") return `${metric.numerator ?? 0} of ${metric.denominator ?? 0}`;
  if (metric.unit === "micro-usd") return `${formatUsd(metric.numerator)} over ${count(metric.denominator ?? 0, "verified task")}`;
  return count(metric.denominator ?? 0, "mission");
}

/**
 * Quality (owner only): whether Brain is getting better, from deterministic
 * counts over existing records. Each figure shows its definition and window.
 */
export default function QualityPage(): JSX.Element {
  const app = useApp();
  const quality = createScopedRead<QualitySummary>({
    scope: app.scope,
    load: async (_scope, signal) => {
      const response = await query<{ snapshot: QualitySummary; asOf: string; sourceWatermark: number }>({ queryType: "quality.summary" }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: () => false,
    refreshMs: 60_000,
  });
  return <BrainPage title="Quality" description="Whether Brain is getting better, counted from missions, tasks, handoffs and settled spend. No model computes these figures.">
    <PageStack>
      <ScreenRegion state={quality.state()} onRetry={() => void quality.refresh({ force: true })} emptyTitle="No data" emptyDescription="Nothing has been recorded yet.">
        <Show when={quality.state().data}>{(data) => <>
          <p class="text-interface text-ink-gray-7">Window: the last {data().window.days} days, {formatDateTime(data().window.from)} to {formatDateTime(data().window.to)}.</p>
          <section aria-label="Quality metrics" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <For each={data().metrics}>{(metric) =>
              <article class="flex min-w-0 flex-col gap-1 rounded-card border border-outline-gray-2 bg-surface-white p-4" data-metric={metric.id}>
                <h2 class="text-interface font-medium text-ink-gray-8">{metric.label}</h2>
                <p class="text-heading tabular-nums text-ink-gray-9">{metricValue(metric)}</p>
                <p class="text-caption text-ink-gray-6">{basis(metric)} · last {data().window.days} days</p>
                <p class="text-caption text-ink-gray-7"><span class="font-medium">Definition:</span> {metric.definition}</p>
              </article>}</For>
          </section>
          <WorkspaceSection title="Top failure reasons" description={data().failureReasons.definition}>
            <Show when={data().failureReasons.items.length} fallback={<p class="text-interface text-ink-gray-7">No tasks were parked in this window.</p>}>
              <ol class="flex flex-col gap-1.5" aria-label="Top failure reasons"><For each={data().failureReasons.items}>{(item) =>
                <li class="flex items-baseline justify-between gap-3 rounded-control bg-surface-gray-1 px-3 py-2 text-interface"><span class="min-w-0 break-words">{item.reason}</span><span class="tabular-nums text-ink-gray-7">{item.count}×</span></li>}</For></ol>
            </Show>
          </WorkspaceSection>
        </>}</Show>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
