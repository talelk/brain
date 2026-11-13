import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { EmptyState, TabButtons } from "@talelk/newui-molecules";
import { FilterBar } from "@talelk/newui-organisms";
import type { Mission } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { formatDateTime, formatUsd } from "../../ui/format";
import { missionHref } from "../../ui/mission-links";
import { attentionHref, AttentionRows } from "../../ui/components/AttentionDrawer";
import { NeedsYouQueue } from "../../ui/components/NeedsYouQueue";
import { runningMissions } from "../../ui/components/WorkingNow";
import { ATTENTION_CHANGED, blockingCount } from "../../ui/attention";
import { missionOutcomeLabel, missionPauseLabel, missionStateLabel } from "../../ui/mission-words";
import { Meter } from "../../ui/viz/Meter";
import { WorkspaceUsage } from "../../ui/usage/Usage";
import { PlainSummary } from "../../ui/viz/PlainSummary";
import { t, tn } from "../../i18n";

/** Search only earns its place once the list is long enough to need it. */
const SEARCH_FROM = 8;

/**
 * Missions home (T34, #40/#43): what needs you first (one decision card each), then the missions of this
 * workspace, filterable to the ones running right now. Closed missions stay collapsed. Header counts, the
 * Running filter and Today's Working-now strip read the same shared snapshot, so they always agree.
 */
export default function MissionsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const attention = app.useAttention();
  const missions = app.useMissions();
  const [filter, setFilter] = createSignal("");
  const view = (): "all" | "running" => (searchParams.show === "running" ? "running" : "all");
  const newMission = () => void navigate(`/w/${app.workspaceId()}/missions/new`);
  const matches = (...fields: (string | undefined)[]) => { const needle = filter().trim().toLowerCase(); return !needle || fields.some((field) => field?.toLowerCase().includes(needle)); };
  const attentionCount = () => attention.state().data?.length ?? 0;
  const allMissions = () => missions.state().data ?? [];
  const attentionItems = () => (attention.state().data ?? []).filter((item) => matches(item.title, item.detail, item.kind, item.workspaceId));
  const shown = () => allMissions().filter((mission) => matches(mission.title, mission.intent, mission.state));
  const runningNow = () => runningMissions(shown());
  const open = () => (view() === "running" ? runningNow() : shown().filter((mission) => mission.state !== "closed"));
  const closed = () => (view() === "running" ? [] : shown().filter((mission) => mission.state === "closed"));
  const openAll = () => allMissions().filter((mission) => mission.state !== "closed");
  const runningAll = () => runningMissions(allMissions());
  const showSearch = () => attentionCount() + allMissions().length >= SEARCH_FROM || filter() !== "";
  /** Spend across the open missions that carry a ceiling: one quiet bar, only where the data exists. */
  const capped = () => openAll().filter((mission) => mission.budget.maxMicroUsd !== undefined);
  const spend = () => ({
    settled: capped().reduce((sum, mission) => sum + mission.usage.settledMicroUsd, 0),
    reserved: capped().reduce((sum, mission) => sum + mission.usage.reservedMicroUsd, 0),
    limit: capped().reduce((sum, mission) => sum + (mission.budget.maxMicroUsd ?? 0), 0),
  });
  const running = () => runningAll().reduce((sum, mission) => sum + mission.usage.runningMembers, 0);
  const summary = () => {
    const waiting = blockingCount(attention.state().data ?? []);
    const lead = waiting ? tn("missions.summary.waiting", waiting) : t("missions.summary.none");
    return `${lead} ${tn("missions.summary.open", openAll().length)}, ${t("missions.summary.running", { m: running() })}`;
  };
  const noMissionsAtAll = () => missions.state().status === "empty-authorized" && attention.state().status === "empty-authorized";
  const waiting = () => attentionItems().filter((item) => item.kind !== "result-ready");
  const ready = () => attentionItems().filter((item) => item.kind === "result-ready");
  const changed = () => window.dispatchEvent(new Event(ATTENTION_CHANGED));
  const row = (mission: Mission) => <QueueRow title={mission.title} description={mission.intent.trim().toLowerCase() === mission.title.trim().toLowerCase() ? "" : mission.intent} icon="lucide-flag" tone={mission.state === "active" ? "blue" : mission.state === "paused" ? "amber" : mission.state === "verifying" ? "green" : "gray"}
    label={t("missions.open", { title: mission.title })}
    meta={<><span>{missionStateLabel(mission.state)}{mission.pauseReason ? ` · ${missionPauseLabel(mission.pauseReason)}` : ""}{mission.outcome ? ` · ${missionOutcomeLabel(mission.outcome)}` : ""}</span><span>{t("missions.runningCount", { n: mission.usage.runningMembers })}</span><Show when={mission.budget.maxMicroUsd !== undefined}><span>{t("missions.spent", { spent: formatUsd(mission.usage.settledMicroUsd + mission.usage.reservedMicroUsd), limit: formatUsd(mission.budget.maxMicroUsd) })}</span></Show><span>{t("missions.updated", { when: formatDateTime(mission.updatedAt) })}</span></>}
    onClick={() => void navigate(missionHref(app.workspaceId(), mission.missionId, "live"))} />;
  const firstMission = <EmptyState icon="lucide-flag" title={t("missions.first.title")}
    description={t("missions.first.description")}
    action={<Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={newMission}>{t("missions.first.action")}</Button>} />;
  return <BrainPage title={t("nav.missions")} description={t("missions.description")}
    actions={<Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={newMission}>{t("missions.new")}</Button>}>
    <PageStack>
      <Show when={!noMissionsAtAll()} fallback={firstMission}>
        <PlainSummary icon={attentionCount() ? "lucide-bell-ring" : "lucide-circle-check"}>{summary()}</PlainSummary>
        <WorkspaceUsage />
        <Show when={showSearch()}>
          <FilterBar resultCount={attentionItems().length + shown().length}
            query={{ value: filter(), placeholder: t("missions.search"), onInput: setFilter }}
            chips={filter() ? [{ label: t("missions.searchChip", { text: filter() }), onRemove: () => setFilter("") }] : []}
            onClearAll={filter() ? () => setFilter("") : undefined} />
        </Show>
        <WorkspaceSection title={t("decision.queue")} description={t("missions.needs.description")}>
          <ScreenRegion state={attention.state()} onRetry={() => void attention.refresh({ force: true })} emptyTitle={t("decision.empty.title")} emptyDescription={t("decision.empty.description")}>
            {/* What needs a person comes first, as decision cards; finished results are good news, not work, so they wait in a closed list below it. */}
            <Show when={waiting().length} fallback={<p class="text-interface text-ink-gray-7">{t("missions.summary.none")}</p>}>
              <NeedsYouQueue items={waiting()} missions={allMissions()} onChanged={changed} />
            </Show>
            <Show when={ready().length}>
              <details class="mt-3 rounded-card border border-outline-gray-2 bg-surface-gray-1" data-testid="missions-results-ready">
                <summary class="cursor-pointer px-3 py-2 text-base-medium text-ink-gray-9">{tn("missions.results.ready", ready().length)}</summary>
                <AttentionRows items={ready()} onOpen={(item) => void navigate(attentionHref(item))} />
              </details>
            </Show>
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection title={t("missions.all.title")} description={t("missions.all.description")}
          actions={<Show when={spend().limit > 0}><div class="w-56 max-w-full"><Meter label={t("missions.spendLabel")} settled={spend().settled} reserved={spend().reserved} limit={spend().limit} format={formatUsd} /></div></Show>}>
          <div class="mb-3">
            <TabButtons label={t("missions.filter.label")} value={view()} onValueChange={(value) => setSearchParams({ show: value === "running" ? "running" : undefined })}
              options={[{ value: "all", label: `${t("missions.filter.all")} (${openAll().length})` }, { value: "running", label: `${t("missions.filter.running")} (${runningAll().length})` }]} />
          </div>
          <ScreenRegion state={missions.state()} onRetry={() => void missions.refresh({ force: true })} emptyTitle={t("missions.none.title")} emptyDescription={t("missions.none.description")} emptyAction={<Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={newMission}>{t("missions.first.action")}</Button>}>
            <Show when={open().length} fallback={view() === "running"
              ? <EmptyState size="sm" icon="lucide-radio" title={t("missions.running.none.title")} description={t("missions.running.none.description")} />
              : <EmptyState size="sm" icon="lucide-flag" title={t("missions.open.none.title")} description={t("missions.open.none.description")} />}>
              <div class="brain-queue"><For each={open()}>{row}</For></div>
            </Show>
            <Show when={closed().length}><details class="mt-4"><summary class="cursor-pointer text-base-medium">{t("missions.closed", { n: closed().length })}</summary><div class="brain-queue mt-2"><For each={closed()}>{row}</For></div></details></Show>
          </ScreenRegion>
        </WorkspaceSection>
      </Show>
    </PageStack>
  </BrainPage>;
}
