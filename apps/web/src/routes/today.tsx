import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { FilterBar, Section, StatGrid } from "@talelk/newui-organisms";
import type { TodayItem, WorkspaceSummary } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { BrainPage, PageStack } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { formatDateTime, formatMicroUsd } from "../ui/format";
import { CardTile, RefreshButton } from "../ui/components/primitives";
import { IconTile } from "../ui/components/primitives";

const PRIORITY_LABEL: Record<number, string> = { 0: "Routine", 1: "Immediate", 2: "Today", 3: "Now" };
const ACTION_LABEL: Record<string, string> = {
  review: "Review exact proposal", investigate: "Investigate blocker",
  reconcile: "Reconcile outcome", decide: "Record decision", inspect: "Inspect record",
};
const TYPE_LABEL: Record<string, string> = { approval: "Approval", job: "Run", incident: "Incident", sla: "SLA", decision: "Decision" };
const TYPE_ICON: Record<string, string> = {
  approval: "lucide-shield-check", job: "lucide-activity", incident: "lucide-siren", sla: "lucide-clock", decision: "lucide-scale",
};

export function TodayScreen(props: {
  items: TodayItem[];
  state: ScreenState<TodayItem[]>;
  onRefresh: () => void;
  onOpen: (item: TodayItem) => void;
  onStart?: () => void;
  asOf?: string;
}): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = () => typeof searchParams.q === "string" ? searchParams.q : "";
  const type = () => typeof searchParams.type === "string" ? searchParams.type : undefined;
  const setFilter = (value: string) => setSearchParams({ q: value || undefined });
  const setType = (value?: string) => setSearchParams({ type: value || undefined });
  const visible = () => props.items.filter((item) =>
    (!type() || item.type === type()) &&
    (!filter() || `${item.title} ${item.detail}`.toLowerCase().includes(filter().toLowerCase())),
  );
  const staleCount = () => props.items.filter((item) => item.stale).length;

  return <BrainPage title="Today"
    description="Your next authorized actions across every workspace you can read, ordered by urgency."
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={props.onStart}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onStart}>Start a task</Button></Show></>}>
    <PageStack>
      <Show when={staleCount() > 0}>
        <Alert theme="amber" variant="outline" title="Some items need a fresh review"
          description={`${staleCount()} of ${props.items.length} rows have not been re-verified. Open the current record before acting.`} />
      </Show>
      <FilterBar resultCount={visible().length}
        query={{ value: filter(), placeholder: "Find an action or resource…", onInput: setFilter }}
        tabs={{ label: "Item type", value: type() ?? "all", options: [
          { label: "All", value: "all" }, { label: "Approvals", value: "approval" }, { label: "Runs", value: "job" },
          { label: "Incidents", value: "incident" }, { label: "SLA", value: "sla" }, { label: "Decisions", value: "decision" },
        ], onValueChange: (value) => setType(value === "all" ? undefined : value) }}
        chips={[
          ...(type() ? [{ label: `Type: ${TYPE_LABEL[type()!] ?? type()}`, onRemove: () => setType(undefined) }] : []),
          ...(filter() ? [{ label: `Search: ${filter()}`, onRemove: () => setFilter("") }] : []),
        ]}
        onClearAll={type() || filter() ? () => { setFilter(""); setType(undefined); } : undefined} />
      <Section title="Needs your attention"
        description={`Priority order · verified ${props.asOf ? formatDateTime(props.asOf) : "from the server"}`}
        surface="card">
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="You’re all caught up"
          emptyDescription="No expiring approvals, blocked runs, open incidents, or decisions need your attention."
          emptyAction={<RefreshButton onClick={props.onRefresh} label="Check again" />}
          onRetry={props.onRefresh}>
          <div class="divide-y divide-outline-gray-1 brain-row-list">
            <For each={visible()}>{(item) => (
              <article class="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                <span class={`hidden size-10 place-items-center rounded-control sm:grid ${item.priority >= 2 ? "bg-surface-red-2 text-ink-red-7" : item.priority === 1 ? "bg-surface-amber-2 text-ink-amber-8" : "bg-surface-blue-2 text-ink-blue-8"}`}>
                  <span class={`${TYPE_ICON[item.type] ?? "lucide-circle"} size-5`} aria-hidden="true" />
                </span>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <StatusBadge kind="priority" status={String(item.priority)} label={PRIORITY_LABEL[item.priority] ?? `P${item.priority}`} />
                    <Badge variant="outline" theme="blue" label={TYPE_LABEL[item.type] ?? item.type} />
                    <Show when={item.stale}><Badge theme="amber" label="Unverified" /></Show>
                  </div>
                  <h3 class="mt-2 text-base-medium text-ink-gray-9">{item.title}</h3>
                  <p class="mt-1 max-w-3xl text-interface text-ink-gray-7">{item.detail}</p>
                  <p class="mt-2 text-caption text-ink-gray-6">{ACTION_LABEL[item.nextAction] ?? "Inspect record"} · updated <DateText value={item.updatedAt} asOf={props.asOf} /></p>
                </div>
                <Button size="lg" variant="outline" iconRight="lucide-arrow-right" class="sm:self-center" onClick={() => props.onOpen(item)}>
                  {ACTION_LABEL[item.nextAction] ?? "Open"}
                </Button>
              </article>
            )}</For>
          </div>
        </ScreenRegion>
      </Section>
    </PageStack>
  </BrainPage>;
}

export function BridgeScreen(props: {
  workspaces: WorkspaceSummary[];
  state: ScreenState<WorkspaceSummary[]>;
  onRefresh: () => void;
  onOpen: (workspaceId: string) => void;
}): JSX.Element {
  const total = () => props.workspaces.reduce((sum, ws) => sum + ws.pendingApprovals + ws.blockedJobs, 0);
  return <BrainPage title="Bridge" description="Choose a workspace by the work and operational attention waiting inside it."
    actions={<RefreshButton onClick={props.onRefresh} label="Refresh" />}>
    <PageStack>
      <StatGrid compact columns={2} stats={[
        { label: "Readable workspaces", value: String(props.workspaces.length), hint: "Available to your account", icon: "lucide-building-2" },
        { label: "Items needing attention", value: String(total()), hint: "Pending approvals and blocked runs", icon: "lucide-inbox" },
      ]} />
      <Section title="Workspace attention" description="Open a workspace to inspect its current work." surface="card">
        <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No workspaces assigned"
          emptyDescription="Ask an organization administrator to grant you workspace access."
          emptyAction={<Button size="lg" onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
          <div class="grid gap-3 md:grid-cols-2">
            <For each={props.workspaces}>{(ws) => (
              <CardTile class="flex min-w-0 flex-col gap-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-3">
                    <IconTile icon="lucide-building-2" />
                    <div class="min-w-0"><h3 class="truncate text-base-medium text-ink-gray-9">{ws.displayName}</h3><p class="text-caption text-ink-gray-6">{ws.workspaceId}</p></div>
                  </div>
                  <StatusBadge kind="health" status={ws.health} />
                </div>
                <dl class="grid grid-cols-2 gap-3 text-interface sm:grid-cols-4">
                  <div><dt class="text-caption text-ink-gray-6">Active</dt><dd class="mt-1 font-medium tabular-nums">{ws.activeJobs}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Approvals</dt><dd class="mt-1 font-medium tabular-nums">{ws.pendingApprovals}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Blocked</dt><dd class="mt-1 font-medium tabular-nums">{ws.blockedJobs}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Today</dt><dd class="mt-1 font-medium tabular-nums">{formatMicroUsd(ws.dailyMicroUsd)}</dd></div>
                </dl>
                <Button size="lg" variant="outline" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpen(ws.workspaceId)}>Open workspace</Button>
              </CardTile>
            )}</For>
          </div>
        </ScreenRegion>
      </Section>
    </PageStack>
  </BrainPage>;
}
