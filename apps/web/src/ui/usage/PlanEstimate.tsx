import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "@talelk/newui-atoms";
import type { PlanEstimate as PlanEstimateView } from "@brain/contracts";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { useApp } from "../app-context";
import { count, formatTokens, formatUsd } from "../format";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

const minutesText = (minutes: number): string => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`);

/**
 * Plan-time estimates (#54). The Governor computes every total; this only
 * words them. A task without an estimate counts as unknown, never as zero,
 * and the ceiling is the mission budget exactly as admission enforces it.
 */
export function PlanEstimate(props: { planVersionId: string; compact?: boolean }): JSX.Element {
  const app = useApp();
  const estimate = createScopedRead<PlanEstimateView>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<PlanEstimateView>>({ queryType: "plans.estimate", workspaceId: scope.workspaceId, resourceId: props.planVersionId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    refreshMs: 15_000,
  });
  return <Show when={estimate.state().data}>{(plan) => {
    const known = (kind: "minutes" | "cost") => plan().taskCount - (kind === "minutes" ? plan().unknownMinutesTasks : plan().unknownCostTasks);
    const unknownNote = (unknown: number) => (unknown > 0 ? ` (${count(unknown, "task")} without an estimate not included)` : "");
    const limits = () => [
      plan().ceilingMicroUsd !== undefined ? formatUsd(plan().ceilingMicroUsd) : undefined,
      plan().ceilingTokens !== undefined ? `${formatTokens(plan().ceilingTokens)} tokens` : undefined,
      plan().ceilingWallClockMs !== undefined ? `${minutesText(Math.round((plan().ceilingWallClockMs ?? 0) / 60_000))} of working time` : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    const stops = () => plan().ceilingMicroUsd !== undefined || plan().ceilingTokens !== undefined || plan().ceilingWallClockMs !== undefined;
    const warning = <Show when={plan().timeLimitBelowEstimate}><p role="alert" class="m-0 text-interface text-ink-amber-9" data-testid="estimate-time-warning">
      The time limit ({minutesText(Math.round((plan().ceilingWallClockMs ?? 0) / 60_000))} of working time) is shorter than this plan's own estimate (about {minutesText(plan().totalEstimatedMinutes ?? 0)}), so the mission will pause before it can finish. Raise the limit first, or confirm and add time when it pauses.</p></Show>;
    if (props.compact) return <div class="flex min-w-0 flex-col gap-1" data-testid="plan-estimate">
      <p class="m-0 text-caption text-ink-gray-7" data-testid="estimate-ceiling"><Show when={stops()} fallback="No spending, token or time limit is set.">This plan stops at {limits().join(" or ")}{limits().length > 1 ? ", whichever comes first" : ""}.</Show>{plan().totalEstimatedMinutes !== undefined ? ` Estimated: about ${minutesText(plan().totalEstimatedMinutes ?? 0)}.` : ""}</p>
      {warning}
    </div>;
    return <section class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-1 bg-surface-gray-1 p-3" aria-label="Plan estimates" data-testid="plan-estimate">
      <p class="flex items-center gap-2 text-base-medium text-ink-gray-9"><span class="lucide-calculator size-4 text-ink-gray-6" aria-hidden="true" />What this plan may take<Badge size="sm" theme="gray" label="estimate" /></p>
      <ul class="flex flex-col gap-1 text-interface text-ink-gray-8">
        <li data-testid="estimate-time">
          <Show when={plan().totalEstimatedMinutes !== undefined} fallback="Time: unknown. No task has a time estimate.">
            Time: about {minutesText(plan().totalEstimatedMinutes ?? 0)} across {count(known("minutes"), "task")}{unknownNote(plan().unknownMinutesTasks)}.
          </Show>
        </li>
        <li data-testid="estimate-cost">
          <Show when={plan().totalMicroUsd !== undefined} fallback="Cost: unknown. No task has a cost cap.">
            Cost: up to {formatUsd(plan().totalMicroUsd)} across {count(known("cost"), "task")}{unknownNote(plan().unknownCostTasks)}.
          </Show>
        </li>
        <li data-testid="estimate-ceiling">
          <Show when={plan().ceilingMicroUsd !== undefined || plan().ceilingTokens !== undefined || plan().ceilingWallClockMs !== undefined} fallback="Ceiling: this mission has no spending, token or time limit, so nothing stops this plan automatically.">
            This plan stops at {limits().join(" or ")}{limits().length > 1 ? ", whichever comes first" : ""} (the mission budget Brain enforces).
          </Show>
        </li>
      </ul>
      {warning}
      <details class="min-w-0"><summary class="cursor-pointer text-caption text-ink-gray-7">Estimate for each task</summary>
        <ul class="mt-1 flex flex-col gap-0.5 text-caption text-ink-gray-7" aria-label="Estimates by task">
          <For each={plan().tasks}>{(task) => <li>{task.title}: {task.estimatedMinutes !== undefined ? `about ${minutesText(task.estimatedMinutes)}` : "time unknown"} · {task.maxMicroUsd !== undefined ? `up to ${formatUsd(task.maxMicroUsd)}` : "cost unknown"}</li>}</For>
        </ul>
      </details>
    </section>;
  }}</Show>;
}
