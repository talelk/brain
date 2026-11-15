import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Alert, Timeline } from "@talelk/newui-molecules";
import type { RunToolCalls as RunToolCallsView } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../screen-region";
import { missionHref } from "../mission-links";
import { WorkspaceSection } from "./Domain";
import { t, tOr } from "../../i18n";

type Outcome = RunToolCallsView["items"][number]["outcome"];
const TONE: Readonly<Record<Outcome, "green" | "red" | "blue" | "amber">> = { succeeded: "green", failed: "red", running: "blue", "no-result": "amber" };
const ICON: Readonly<Record<Outcome, string>> = { succeeded: "lucide-circle-check", failed: "lucide-circle-x", running: "lucide-loader-circle", "no-result": "lucide-circle-help" };
const linkClass = "inline-flex items-center gap-1 rounded-control text-caption font-medium text-ink-blue-link focus-visible:focus-ring";

/**
 * The run page's Tool calls tab (spec #90, story 53): every tool call the run made, in order, with what became of each, so a person can
 * inspect them without leaving the mission. A call that proposed a change names its approval; a failed call carries the plain-words
 * diagnosis the tool catalog uses. When the run belongs to a mission, the tab links back to that mission's timeline.
 */
export function RunToolCalls(props: { runId: string; mission?: { missionId: string; workspaceId: string } }): JSX.Element {
  const app = useApp();
  const read = createScopedRead<RunToolCallsView>({
    scope: app.scope,
    resource: () => props.runId,
    load: async (scope, signal, resource) => {
      const response = await query<{ snapshot: RunToolCallsView; asOf: string; sourceWatermark: number }>({ queryType: "run.toolCalls", workspaceId: scope.workspaceId, resourceId: resource! } as never, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
  });
  return <WorkspaceSection title={t("toolcalls.title")} description={t("toolcalls.description")}
    actions={<Show when={props.mission}>{(mission) => <A class={linkClass} href={missionHref(mission().workspaceId, mission().missionId, "timeline")}>{t("toolcalls.timeline")}</A>}</Show>}>
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh({ force: true })} emptyTitle={t("toolcalls.empty.title")} emptyDescription={t("toolcalls.empty.detail")}>
      <div class="flex min-w-0 flex-col gap-3" data-testid="run-tool-calls">
        <Show when={read.state().data?.truncated}><Alert theme="blue" variant="outline" title={t("toolcalls.truncated")} /></Show>
        <Timeline items={(read.state().data?.items ?? []).map((call) => ({
          id: `${call.attemptId}:${call.proposalId}`,
          icon: ICON[call.outcome],
          tone: TONE[call.outcome],
          title: <span class="flex flex-wrap items-center gap-2 break-all" data-tool-call={call.toolId} data-outcome={call.outcome}><span class="font-mono">{call.toolId}</span><span class="text-caption text-ink-gray-6">{tOr(`toolcalls.outcome.${call.outcome}`, call.outcome)}</span></span>,
          description: <span class="flex min-w-0 flex-col gap-1">
            <Show when={call.diagnosis}>{(diagnosis) => <span class="break-words text-interface text-ink-gray-8">{diagnosis().headline} {diagnosis().nextStep}</span>}</Show>
            <Show when={call.message}><span class="break-words font-mono text-caption text-ink-gray-7">{call.message}</span></Show>
            <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-gray-6">
              <Show when={call.attemptNumber}><span>{t("toolcalls.attempt", { n: call.attemptNumber ?? 0 })}</span></Show>
              <Show when={call.approvalId}>{(approvalId) => <A class={linkClass} href={`/approvals/${encodeURIComponent(approvalId())}`} data-tool-call-approval>{t("toolcalls.approval")}</A>}</Show>
            </span>
          </span>,
          timestamp: <DateText value={call.proposedAt} />,
        }))} />
      </div>
    </ScreenRegion>
  </WorkspaceSection>;
}
