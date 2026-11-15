import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { Mission, PlanVersion, UsageGroup } from "@brain/contracts";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { t } from "../../i18n";
import { useApp } from "../app-context";
import { formatTokens, formatUsd } from "../format";
import { useUsage } from "./Usage";

type Dimension = "member" | "agent" | "engine" | "model";
const DIMENSIONS: ReadonlyArray<{ id: Dimension; title: "usage.breakdown.member" | "usage.breakdown.agent" | "usage.breakdown.engine" | "usage.breakdown.model" }> = [
  { id: "member", title: "usage.breakdown.member" }, { id: "agent", title: "usage.breakdown.agent" }, { id: "engine", title: "usage.breakdown.engine" }, { id: "model", title: "usage.breakdown.model" },
];

/**
 * Where a mission's usage went: the same ledger totals split by team member, agent definition, engine and model (#111). Every split adds up to
 * the mission's usage. What the Governor could not attribute is said so ("not reported"), never guessed, and the advisory judge's own calls
 * are named as such. A member is shown by its role in the confirmed plan, the way the Team tab names it.
 */
export function UsageBreakdown(props: { mission: Mission }): JSX.Element {
  const app = useApp();
  const [open, setOpen] = createSignal(false);
  return <details class="rounded-card border border-outline-gray-1" data-testid="usage-breakdown" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary class="cursor-pointer px-3 py-2 text-interface font-medium text-ink-gray-8">{t("usage.breakdown.summary")}</summary>
    <Show when={open()}><BreakdownBody mission={props.mission} scope={app.scope} /></Show>
  </details>;
}

function BreakdownBody(props: { mission: Mission; scope: ReturnType<typeof useApp>["scope"] }): JSX.Element {
  const usage = useUsage("usage.mission", () => props.mission.missionId);
  const team = createScopedRead<PlanVersion | null>({
    scope: props.scope, load: async (scope, signal) => {
      if (!props.mission.activePlanVersionId) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: PlanVersion; asOf: string; sourceWatermark: number }>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: props.mission.activePlanVersionId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const label = (dimension: Dimension, group: UsageGroup): string => {
    if (group.source === "judge") return dimension === "model" && group.id ? t("usage.breakdown.judgeModel", { model: group.id }) : t("usage.breakdown.judge");
    if (!group.id) return t("usage.breakdown.notReported");
    const member = dimension === "member" ? team.state().data?.team?.find((entry) => entry.memberId === group.id) : undefined;
    return member ? `${member.role} (${member.memberId})` : group.id;
  };
  return <div class="flex min-w-0 flex-col gap-3 border-t border-outline-gray-1 px-3 py-3">
    <Show when={usage.state().data?.breakdown} fallback={<p class="text-caption text-ink-gray-6">{t("usage.breakdown.loading")}</p>}>{(breakdown) => <>
      <div class="grid gap-4 md:grid-cols-2">
        <For each={DIMENSIONS}>{(dimension) => <section class="flex min-w-0 flex-col gap-1" aria-label={t(dimension.title)} data-testid={`usage-by-${dimension.id}`}>
          <h4 class="m-0 text-caption font-medium text-ink-gray-7">{t(dimension.title)}</h4>
          <ul class="m-0 flex list-none flex-col gap-1 p-0">
            <For each={breakdown()[dimension.id] ?? []}>{(group) => <li class="flex flex-wrap items-baseline justify-between gap-x-3 text-interface text-ink-gray-9" data-testid="usage-group">
              <span class="min-w-0 break-words">{label(dimension.id, group)}</span>
              <span class="text-caption text-ink-gray-7">{t("usage.breakdown.line", { tokens: formatTokens(group.usage.inputTokens + group.usage.outputTokens + group.usage.cachedInputTokens), cost: group.usage.settledMicroUsd === 0 && group.usage.inputTokens + group.usage.outputTokens > 0 ? t("usage.breakdown.noCost") : formatUsd(group.usage.settledMicroUsd) })}</span>
            </li>}</For>
          </ul>
        </section>}</For>
      </div>
      <p class="text-caption text-ink-gray-6">{t("usage.breakdown.hint")}</p>
    </>}</Show>
  </div>;
}
