import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Button, KeyValue, createMediaQuery } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { FilterBar } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import type { TodayItem, WorkspaceSummary } from "@brain/contracts";
import { DateText, ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { formatDateTime, formatMicroUsd } from "../ui/format";
import { CardTile, IconTile, RefreshButton } from "../ui/components/primitives";
import { EmptyPreview, FactStrip, Freshness, QueueRow, WorkspaceSection } from "../ui/components/Domain";
import { WorkspaceManagementDialog } from "../ui/components/WorkspaceManagementDialog";
import { useApp } from "../ui/app-context";

const PRIORITY_LABEL: Record<number, string> = { 0: "Monitor", 1: "Soon", 2: "Today", 3: "Now" };
const ACTION_LABEL: Record<string, string> = {
  review: "Review exact proposal", investigate: "Investigate blocker",
  reconcile: "Reconcile outcome", decide: "Record decision", inspect: "Inspect record",
};
const TYPE_LABEL: Record<string, string> = { approval: "Approval", job: "Run", incident: "Incident", sla: "SLA", decision: "Decision" };
const TYPE_ICON: Record<string, string> = {
  approval: "lucide-shield-check", job: "lucide-activity", incident: "lucide-siren", sla: "lucide-clock", decision: "lucide-scale",
};

function attentionGroup(item: TodayItem): "Now" | "Soon" | "Monitoring" {
  if (item.priority >= 2 || item.stale) return "Now";
  return item.priority === 1 ? "Soon" : "Monitoring";
}

export function TodayScreen(props: {
  items: TodayItem[];
  state: ScreenState<TodayItem[]>;
  onRefresh: () => void;
  onOpen: (item: TodayItem) => void;
  onStart?: () => void;
  asOf?: string;
}): JSX.Element {
  const desktop = createMediaQuery("(min-width: 1024px)");
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = () => typeof searchParams.q === "string" ? searchParams.q : "";
  const type = () => typeof searchParams.type === "string" ? searchParams.type : undefined;
  const selectedId = () => typeof searchParams.selected === "string" ? searchParams.selected : "";
  const setFilter = (value: string) => setSearchParams({ q: value || undefined, selected: undefined });
  const setType = (value?: string) => setSearchParams({ type: value || undefined, selected: undefined });
  const visible = () => props.items.filter((item) =>
    (!type() || item.type === type()) &&
    (!filter() || `${item.title} ${item.detail} ${item.workspaceId}`.toLowerCase().includes(filter().toLowerCase())),
  );
  const current = () => visible().find((item) => item.id === selectedId()) ?? visible()[0];
  const staleCount = () => props.items.filter((item) => item.stale).length;
  const open = (item: TodayItem) => {
    if (desktop()) setSearchParams({ selected: item.id });
    else props.onOpen(item);
  };

  const list = <WorkspaceSection title="Attention inbox" description={`Ordered by operational urgency · verified ${props.asOf ? formatDateTime(props.asOf) : "by Governor"}`}>
    <Show when={visible().length} fallback={<EmptyPreview icon="lucide-filter" title="No matching attention" description="Clear the search or type filter to return to the authorized inbox." action={<Button size="lg" variant="outline" onClick={() => { setFilter(""); setType(undefined); }}>Clear filters</Button>} />}>
      <For each={(["Now", "Soon", "Monitoring"] as const)}>{(group) => {
        const items = () => visible().filter((item) => attentionGroup(item) === group);
        return <Show when={items().length}><section class="mb-5 last:mb-0" aria-label={`${group} attention`}>
          <h3 class="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wider text-ink-gray-6"><span class={`size-1.5 rounded-full ${group === "Now" ? "bg-surface-red-7" : group === "Soon" ? "bg-surface-amber-7" : "bg-surface-blue-7"}`} aria-hidden="true" />{group}<span class="tabular-nums">{items().length}</span></h3>
          <div class="brain-queue"><For each={items()}>{(item) => <QueueRow
            title={item.title} description={item.detail} icon={TYPE_ICON[item.type] ?? "lucide-circle"}
            tone={item.priority >= 2 || item.stale ? "red" : item.priority === 1 ? "amber" : "blue"}
            eyebrow={`${TYPE_LABEL[item.type] ?? item.type} · ${PRIORITY_LABEL[item.priority] ?? `P${item.priority}`}`}
            meta={<><span>{item.workspaceId}</span><Freshness value={item.updatedAt} stale={item.stale} /></>}
            trailing={<span class="flex items-center gap-2 text-caption font-medium text-ink-blue-link">{ACTION_LABEL[item.nextAction] ?? "Open"}<span class="lucide-arrow-right size-4" aria-hidden="true" /></span>}
            selected={desktop() && current()?.id === item.id} onClick={() => open(item)} />}</For></div>
        </section></Show>;
      }}</For>
    </Show>
  </WorkspaceSection>;

  return <BrainPage title="Today"
    description="Decide what needs your attention next, with the reason and current source close at hand."
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={props.onStart}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onStart}>Start a task</Button></Show></>}>
    <PageStack>
      <Show when={staleCount() > 0}>
        <Alert theme="amber" variant="outline" title="Fresh review required"
          description={`${staleCount()} of ${props.items.length} items have not been re-verified. Open the current record before acting.`} />
      </Show>
      <FilterBar resultCount={visible().length}
        query={{ value: filter(), placeholder: "Search attention, reason, or workspace…", onInput: setFilter }}
        tabs={{ label: "Item type", value: type() ?? "all", options: [
          { label: "All", value: "all" }, { label: "Approvals", value: "approval" }, { label: "Runs", value: "job" },
          { label: "Incidents", value: "incident" }, { label: "SLA", value: "sla" }, { label: "Decisions", value: "decision" },
        ], onValueChange: (value) => setType(value === "all" ? undefined : value) }}
        chips={[
          ...(type() ? [{ label: `Type: ${TYPE_LABEL[type()!] ?? type()}`, onRemove: () => setType(undefined) }] : []),
          ...(filter() ? [{ label: `Search: ${filter()}`, onRemove: () => setFilter("") }] : []),
        ]}
        onClearAll={type() || filter() ? () => { setFilter(""); setType(undefined); } : undefined} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="You’re all caught up"
        emptyDescription="No expiring approvals, blocked runs, open incidents, or decisions need your attention."
        emptyAction={<RefreshButton onClick={props.onRefresh} label="Check again" />} onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={58} minStartSize={38} maxStartSize={68} start={list} end={<Show when={current()} keyed fallback={<EmptyPreview icon="lucide-inbox" title="Select an attention item" description="Its reason, freshness and next authorized action will appear here." />}>{(item) => <div class="flex flex-col gap-5">
          <div class="flex items-start justify-between gap-3"><IconTile icon={TYPE_ICON[item.type] ?? "lucide-circle"} tone={item.stale ? "amber" : "blue"} size="lg" /><StatusBadge kind="priority" status={String(item.priority)} label={PRIORITY_LABEL[item.priority] ?? "Attention"} /></div>
          <div><p class="text-caption font-medium uppercase tracking-wider text-ink-gray-6">{TYPE_LABEL[item.type]} · {item.workspaceId}</p><h2 class="mt-2 text-section text-ink-gray-9">{item.title}</h2><p class="brain-prose mt-3 text-interface text-ink-gray-7">{item.detail}</p></div>
          <dl class="grid gap-4 border-y border-outline-gray-1 py-4 sm:grid-cols-2">
            <KeyValue label="Why it needs you" value={ACTION_LABEL[item.nextAction] ?? "Inspect the current record"} orientation="vertical" />
            <KeyValue label="Last source update" value={<DateText value={item.updatedAt} asOf={props.asOf} />} orientation="vertical" />
          </dl>
          <p class="text-interface text-ink-gray-6">Evidence, policy and the current authorization state are checked on the source record. This inbox does not infer completion.</p>
          <Button size="lg" variant="solid" theme="blue" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpen(item)}>{ACTION_LABEL[item.nextAction] ?? "Open current record"}</Button>
          <TechnicalDetails label="Source reference"><p class="break-all">Item {item.id} · source {item.resourceId} · workspace {item.workspaceId}</p></TechnicalDetails>
        </div>}</Show>} />
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}

export function BridgeScreen(props: {
  workspaces: WorkspaceSummary[];
  state: ScreenState<WorkspaceSummary[]>;
  onRefresh: () => void;
  onOpen: (workspaceId: string) => void;
}): JSX.Element {
  const app = useApp();
  const [createOpen, setCreateOpen] = createSignal(false);
  const [managing, setManaging] = createSignal<WorkspaceSummary>();
  const total = () => props.workspaces.reduce((sum, ws) => sum + ws.pendingApprovals + ws.blockedJobs, 0);
  const ordered = () => [...props.workspaces].sort((a, b) => (b.pendingApprovals + b.blockedJobs) - (a.pendingApprovals + a.blockedJobs) || a.displayName.localeCompare(b.displayName));
  return <BrainPage title="Bridge" description="Enter the workspace that needs you first; health stays scoped to its own observations."
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={app.identity()?.actor.scopes.includes("config:activate")}><Button size="lg" theme="blue" iconLeft="lucide-plus" onClick={() => setCreateOpen(true)}>Create workspace</Button></Show></>}>
    <PageStack>
      <FactStrip label="Workspace access summary" items={[
        { label: "Readable workspaces", value: String(props.workspaces.length), hint: "Authorized to your account", icon: "lucide-building-2" },
        { label: "Actionable exceptions", value: String(total()), hint: "Pending approvals and blocked runs", icon: "lucide-inbox" },
      ]} />
      <WorkspaceSection title="Workspace control" description="Actionable workspaces are first. Quiet workspaces remain available without implying systemwide health.">
        <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No workspaces assigned"
          emptyDescription="Ask an organization administrator to grant you workspace access."
          emptyAction={<Button size="lg" onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
          <div class={`grid gap-4 ${ordered().length === 1 ? "max-w-3xl" : "md:grid-cols-2"}`}>
            <For each={ordered()}>{(ws) => {
              const attention = ws.pendingApprovals + ws.blockedJobs;
              return <CardTile wide class="flex min-w-0 flex-col gap-5">
                <div class="flex items-start justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-3"><IconTile icon="lucide-building-2" tone={attention ? "amber" : "gray"} size="lg" /><div class="min-w-0"><h3 class="break-words text-section text-ink-gray-9">{ws.displayName}</h3><p class="mt-1 text-caption text-ink-gray-6">{attention ? `${attention} items need attention` : "No approval or blocked-run exceptions"}</p></div></div>
                  <StatusBadge kind="health" status={ws.health} />
                </div>
                <dl class="grid grid-cols-2 gap-4 border-y border-outline-gray-1 py-4 text-interface sm:grid-cols-4">
                  <div><dt class="text-caption text-ink-gray-6">Active runs</dt><dd class="mt-1 text-base-medium tabular-nums">{ws.activeJobs}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Approvals</dt><dd class="mt-1 text-base-medium tabular-nums">{ws.pendingApprovals}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Blocked</dt><dd class="mt-1 text-base-medium tabular-nums">{ws.blockedJobs}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Spend today</dt><dd class="mt-1 text-base-medium tabular-nums">{formatMicroUsd(ws.dailyMicroUsd)}</dd></div>
                </dl>
                <div class="flex flex-wrap items-center justify-between gap-3"><Freshness value={ws.observedAt} stale={ws.health === "unknown"} /><div class="flex flex-wrap gap-2"><Show when={app.canAdminister()}><Button size="lg" variant="ghost" onClick={() => setManaging(ws)}>Manage</Button></Show><Button size="lg" variant={attention ? "solid" : "outline"} theme="blue" iconRight="lucide-arrow-right" onClick={() => props.onOpen(ws.workspaceId)}>Open workspace</Button></div></div>
              </CardTile>;
            }}</For>
          </div>
        </ScreenRegion>
      </WorkspaceSection>
      <WorkspaceManagementDialog open={createOpen()} onClose={() => setCreateOpen(false)} onChanged={async () => { props.onRefresh(); }} />
      <Show when={managing()}>{(workspace) => <WorkspaceManagementDialog open workspace={workspace()} onClose={() => setManaging(undefined)} onChanged={async () => { setManaging(undefined); props.onRefresh(); }} />}</Show>
    </PageStack>
  </BrainPage>;
}
