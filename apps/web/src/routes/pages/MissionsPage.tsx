import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { FilterBar } from "@talelk/newui-organisms";
import type { AttentionItem, Mission } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";import { formatDateTime, formatUsd } from "../../ui/format";
import { NumberCard } from "../../ui/viz/NumberCard";
import { missionHref } from "../../ui/mission-links";
import { AttentionRows, attentionHref } from "../../ui/components/AttentionDrawer";
import { EmptyState } from "@talelk/newui-molecules";

/**
 * Missions home (T34, #40/#43): what needs you across every workspace you can
 * read, in fixed tiers, then the missions of this workspace.
 */
export default function MissionsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const attention = createScopedRead<AttentionItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: AttentionItem[] }; asOf: string; sourceWatermark: number }>({ queryType: "attention.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  const missions = createScopedRead<Mission[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: Mission[] }; asOf: string; sourceWatermark: number }>({ queryType: "missions.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  const [filter, setFilter] = createSignal("");
  const matches = (...fields: (string | undefined)[]) => { const needle = filter().trim().toLowerCase(); return !needle || fields.some((field) => field?.toLowerCase().includes(needle)); };
  const attentionItems = () => (attention.state().data ?? []).filter((item) => matches(item.title, item.detail, item.kind, item.workspaceId));
  const shown = () => (missions.state().data ?? []).filter((mission) => matches(mission.title, mission.intent, mission.state));
  const open = () => shown().filter((mission) => mission.state !== "closed");
  const closed = () => shown().filter((mission) => mission.state === "closed");
  const refresh = () => { void attention.refresh({ force: true }); void missions.refresh({ force: true }); };
  const row = (mission: Mission) => <QueueRow title={mission.title} description={mission.intent} icon="lucide-flag" tone={mission.state === "active" ? "blue" : mission.state === "paused" ? "amber" : mission.state === "verifying" ? "green" : "gray"}
    label={`Open mission ${mission.title}`}
    meta={<><span>{mission.state}{mission.pauseReason ? ` · ${mission.pauseReason}` : ""}{mission.outcome ? ` · ${mission.outcome}` : ""}</span><span>{mission.usage.runningMembers} running</span><Show when={mission.budget.maxMicroUsd !== undefined}><span>{`${formatUsd(mission.usage.settledMicroUsd + mission.usage.reservedMicroUsd)} / ${formatUsd(mission.budget.maxMicroUsd)}`}</span></Show><span>updated {formatDateTime(mission.updatedAt)}</span></>}
    onClick={() => void navigate(missionHref(app.workspaceId(), mission.missionId, "live"))} />;
  return <BrainPage title="Missions" description="What needs you, then every mission of this workspace."
    actions={<><Button variant="outline" iconLeft="lucide-refresh-cw" onClick={refresh}>Refresh</Button><Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => void navigate(`/w/${app.workspaceId()}/missions/new`)}>New mission</Button></>}>
    <PageStack>
      <div class="grid gap-3 sm:grid-cols-3">
        <NumberCard title="Needs you" value={attention.state().data?.length ?? 0} />
        <NumberCard title="Open missions" value={open().length} />
        <NumberCard title="Closed" value={closed().length} />
      </div>
      <FilterBar resultCount={attentionItems().length + shown().length}
        query={{ value: filter(), placeholder: "Search attention, missions, or workspace…", onInput: setFilter }}
        chips={filter() ? [{ label: `Search: ${filter()}`, onRemove: () => setFilter("") }] : []}
        onClearAll={filter() ? () => setFilter("") : undefined} />
      <WorkspaceSection title="Needs you" description="Approvals first, then stopped missions, proposals and parked work, verdicts ready to close and routed findings — the longest wait first.">
        <ScreenRegion state={attention.state()} onRetry={() => void attention.refresh({ force: true })} emptyTitle="Nothing needs you" emptyDescription="Missions are moving on their own. Brain notifies you when a person is needed.">
          <AttentionRows items={attentionItems()} onOpen={(item) => void navigate(attentionHref(item))} />
        </ScreenRegion>
      </WorkspaceSection>
      <WorkspaceSection title="All missions" description="Long-running and interactive missions of this workspace.">
        <ScreenRegion state={missions.state()} onRetry={() => void missions.refresh({ force: true })} emptyTitle="No missions yet" emptyDescription="Start a mission from a play or describe one yourself.">
          <Show when={open().length} fallback={<EmptyState size="sm" icon="lucide-flag" title="No open missions" description="Every mission here is closed. Start a new one when there is work to do." />}>
            <div class="brain-queue"><For each={open()}>{row}</For></div>
          </Show>
          <Show when={closed().length}><details class="mt-4"><summary class="cursor-pointer text-base-medium">Closed missions ({closed().length})</summary><div class="brain-queue mt-2"><For each={closed()}>{row}</For></div></details></Show>
        </ScreenRegion>
      </WorkspaceSection>
    </PageStack>
  </BrainPage>;
}
