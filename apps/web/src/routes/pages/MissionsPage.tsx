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
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { formatDateTime, formatUsd } from "../../ui/format";
import { missionHref } from "../../ui/mission-links";
import { AttentionRows, attentionHref } from "../../ui/components/AttentionDrawer";
import { blockingCount } from "../../ui/attention";
import { EmptyState } from "@talelk/newui-molecules";
import { Meter } from "../../ui/viz/Meter";
import { PlainSummary } from "../../ui/viz/PlainSummary";

/** Search only earns its place once the list is long enough to need it. */
const SEARCH_FROM = 8;

/**
 * Missions home (T34, #40/#43): what needs you first, with a button per row,
 * then the open missions of this workspace; closed missions stay collapsed.
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
  const newMission = () => void navigate(`/w/${app.workspaceId()}/missions/new`);
  const matches = (...fields: (string | undefined)[]) => { const needle = filter().trim().toLowerCase(); return !needle || fields.some((field) => field?.toLowerCase().includes(needle)); };
  const attentionCount = () => attention.state().data?.length ?? 0;
  const allMissions = () => missions.state().data ?? [];
  const attentionItems = () => (attention.state().data ?? []).filter((item) => matches(item.title, item.detail, item.kind, item.workspaceId));
  const shown = () => allMissions().filter((mission) => matches(mission.title, mission.intent, mission.state));
  const open = () => shown().filter((mission) => mission.state !== "closed");
  const closed = () => shown().filter((mission) => mission.state === "closed");
  const openAll = () => allMissions().filter((mission) => mission.state !== "closed");
  const showSearch = () => attentionCount() + allMissions().length >= SEARCH_FROM || filter() !== "";
  /** Spend across the open missions that carry a ceiling: one quiet bar, only where the data exists. */
  const capped = () => openAll().filter((mission) => mission.budget.maxMicroUsd !== undefined);
  const spend = () => ({
    settled: capped().reduce((sum, mission) => sum + mission.usage.settledMicroUsd, 0),
    reserved: capped().reduce((sum, mission) => sum + mission.usage.reservedMicroUsd, 0),
    limit: capped().reduce((sum, mission) => sum + (mission.budget.maxMicroUsd ?? 0), 0),
  });
  const running = () => openAll().reduce((sum, mission) => sum + mission.usage.runningMembers, 0);
  const summary = () => {
    const waiting = blockingCount(attention.state().data ?? []);
    const lead = waiting ? `${waiting} ${waiting === 1 ? "thing needs" : "things need"} you.` : "Nothing needs you right now.";
    return `${lead} ${openAll().length} open ${openAll().length === 1 ? "mission" : "missions"}, ${running()} ${running() === 1 ? "agent" : "agents"} working.`;
  };
  const noMissionsAtAll = () => missions.state().status === "empty-authorized" && attention.state().status === "empty-authorized";
  const refresh = () => { void attention.refresh({ force: true }); void missions.refresh({ force: true }); };
  const row = (mission: Mission) => <QueueRow title={mission.title} description={mission.intent} icon="lucide-flag" tone={mission.state === "active" ? "blue" : mission.state === "paused" ? "amber" : mission.state === "verifying" ? "green" : "gray"}
    label={`Open mission ${mission.title}`}
    meta={<><span>{mission.state}{mission.pauseReason ? ` · ${mission.pauseReason}` : ""}{mission.outcome ? ` · ${mission.outcome}` : ""}</span><span>{mission.usage.runningMembers} running</span><Show when={mission.budget.maxMicroUsd !== undefined}><span>{`${formatUsd(mission.usage.settledMicroUsd + mission.usage.reservedMicroUsd)} of ${formatUsd(mission.budget.maxMicroUsd)} spent`}</span></Show><span>updated {formatDateTime(mission.updatedAt)}</span></>}
    onClick={() => void navigate(missionHref(app.workspaceId(), mission.missionId, "live"))} />;
  const firstMission = <EmptyState icon="lucide-flag" title="Start your first mission"
    description="A mission is a goal Brain's agents work on while you stay in control. Pick a ready-made play or describe what you want in a sentence; nothing runs until you confirm the plan."
    action={<Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={newMission}>Start a mission</Button>} />;
  return <BrainPage title="Missions" description="What needs you, then every mission of this workspace."
    actions={<><Button variant="outline" iconLeft="lucide-refresh-cw" onClick={refresh}>Refresh</Button><Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={newMission}>New mission</Button></>}>
    <PageStack>
      <Show when={!noMissionsAtAll()} fallback={firstMission}>
        <PlainSummary icon={attentionCount() ? "lucide-bell-ring" : "lucide-circle-check"}>{summary()}</PlainSummary>
        <Show when={showSearch()}>
          <FilterBar resultCount={attentionItems().length + shown().length}
            query={{ value: filter(), placeholder: "Search attention and missions…", onInput: setFilter }}
            chips={filter() ? [{ label: `Search: ${filter()}`, onRemove: () => setFilter("") }] : []}
            onClearAll={filter() ? () => setFilter("") : undefined} />
        </Show>
        <WorkspaceSection title="Needs you" description="Approvals first, then stopped missions, proposals and parked work, verdicts ready to close and routed findings — the longest wait first.">
          <ScreenRegion state={attention.state()} onRetry={() => void attention.refresh({ force: true })} emptyTitle="Nothing needs you" emptyDescription="Missions are moving on their own. Brain notifies you when a person is needed.">
            <AttentionRows items={attentionItems()} onOpen={(item) => void navigate(attentionHref(item))} />
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection title="All missions" description="Long-running and interactive missions of this workspace."
          actions={<Show when={spend().limit > 0}><div class="w-56 max-w-full"><Meter label="Spend across open missions" settled={spend().settled} reserved={spend().reserved} limit={spend().limit} format={formatUsd} /></div></Show>}>
          <ScreenRegion state={missions.state()} onRetry={() => void missions.refresh({ force: true })} emptyTitle="No missions yet" emptyDescription="Start a mission from a play or describe one yourself." emptyAction={<Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={newMission}>Start a mission</Button>}>
            <Show when={open().length} fallback={<EmptyState size="sm" icon="lucide-flag" title="No open missions" description="Every mission here is closed. Start a new one when there is work to do." />}>
              <div class="brain-queue"><For each={open()}>{row}</For></div>
            </Show>
            <Show when={closed().length}><details class="mt-4"><summary class="cursor-pointer text-base-medium">Closed missions ({closed().length})</summary><div class="brain-queue mt-2"><For each={closed()}>{row}</For></div></details></Show>
          </ScreenRegion>
        </WorkspaceSection>
      </Show>
    </PageStack>
  </BrainPage>;
}
