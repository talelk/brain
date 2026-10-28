import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { FilterBar, Section, StatGrid } from "@talelk/newui-organisms";
import type { TodayItem, WorkspaceSummary } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";

const PRIORITY_LABEL: Record<number, string> = { 0: "Routine", 1: "Immediate", 2: "Today", 3: "Now" };
const ACTION_LABEL: Record<string, string> = {
  review: "Review the exact proposal", investigate: "Investigate the blocker",
  reconcile: "Reconcile the unknown outcome", decide: "Record the decision", inspect: "Inspect the record",
};

/**
 * Today is triage, not a count board (document 21).
 *
 * Each row states its priority and why it is here, and the action returns to the
 * originating list with the same filters, so Back is meaningful. No invented
 * global totals are shown.
 */
export function TodayScreen(props: {
  items: TodayItem[];
  state: ScreenState<TodayItem[]>;
  onRefresh: () => void;
  onOpen: (item: TodayItem) => void;
  asOf?: string;
}): JSX.Element {
  const [filter, setFilter] = createSignal("");
  const [type, setType] = createSignal<string | undefined>();
  const visible = () => props.items.filter((item) =>
    (!type() || item.type === type()) &&
    (!filter() || `${item.title} ${item.detail}`.toLowerCase().includes(filter().toLowerCase())),
  );
  const staleCount = () => props.items.filter((item) => item.stale).length;

  return (
    <div class="flex flex-col gap-field-gap">
      <Show when={staleCount() > 0}>
        <Alert theme="amber" variant="outline" title="Some items are older than their last verified state"
          description={`${staleCount()} of ${props.items.length} rows were not re-verified since they were raised. Open them before acting.`} />
      </Show>
      <Section
        title="Needs your attention"
        description={`Ordered by priority · scoped to the workspaces you can read · as of ${props.asOf ? new Date(props.asOf).toLocaleString() : "server time"}`}
        surface="card"
        toolbar={<FilterBar surface="bare" resultCount={visible().length}
          query={{ value: filter(), placeholder: "Filter by title or resource", onInput: setFilter }}
          tabs={{ label: "Item type", value: type() ?? "all", options: [
            { label: "All", value: "all" }, { label: "Approvals", value: "approval" }, { label: "Runs", value: "job" },
            { label: "Incidents", value: "incident" }, { label: "SLA", value: "sla" }, { label: "Decisions", value: "decision" },
          ], onValueChange: (value) => setType(value === "all" ? undefined : value) }}
          onClearAll={() => { setFilter(""); setType(undefined); }} />}
      >
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Nothing needs your attention"
          emptyDescription="No expiring approvals, blocked runs or open incidents are assigned to you right now."
          emptyAction={<Button onClick={props.onRefresh}>Check again</Button>}
          onRetry={props.onRefresh}>
          <For each={visible()}>{(item) => (
            <article class="flex flex-col gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
              <div class="flex flex-wrap items-center gap-control-gap">
                <Badge theme={item.priority >= 2 ? "red" : item.priority === 1 ? "amber" : "gray"} label={PRIORITY_LABEL[item.priority] ?? `P${item.priority}`} />
                <Badge theme="blue" label={item.type} />
                <Show when={item.stale}><Badge theme="amber" label="unverified" /></Show>
                <span class="text-caption text-ink-gray-7">updated <DateText value={item.updatedAt} asOf={props.asOf} /></span>
              </div>
              <div class="min-w-0">
                <h3 class="text-base-medium text-ink-gray-9">{item.title}</h3>
                <p class="text-base text-ink-gray-7">Why: {ACTION_LABEL[item.nextAction] ?? item.nextAction} · {item.detail}</p>
              </div>
              <div>
                <Button onClick={() => props.onOpen(item)} class="min-h-11">
                  {ACTION_LABEL[item.nextAction] ?? "Open"}
                </Button>
              </div>
            </article>
          )}</For>
        </ScreenRegion>
      </Section>
    </div>
  );
}

/**
 * Bridge is the cross-workspace attention aggregate: which workspace has work,
 * and nothing more. Selecting a row scopes the rest of the app.
 */
export function BridgeScreen(props: {
  workspaces: WorkspaceSummary[];
  state: ScreenState<WorkspaceSummary[]>;
  onRefresh: () => void;
  onOpen: (workspaceId: string) => void;
}): JSX.Element {
  const total = () => props.workspaces.reduce((sum, ws) => sum + ws.pendingApprovals + ws.blockedJobs, 0);
  return (
    <div class="flex flex-col gap-field-gap">
      <StatGrid columns={2} stats={[
        { label: "Workspaces you can read", value: String(props.workspaces.length) },
        { label: "Items needing attention", value: String(total()) },
      ]} />
      <Section title="Workspace attention" surface="card">
        <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No workspaces assigned"
          emptyDescription="Ask an organization administrator to grant you workspace access."
          emptyAction={<Button onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
          <For each={props.workspaces}>{(ws) => (
            <article class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
              <div class="min-w-0">
                <h3 class="text-base-medium text-ink-gray-9">{ws.displayName}</h3>
                <p class="text-caption text-ink-gray-7">
                  {ws.activeJobs} active · {ws.pendingApprovals} approvals · {ws.blockedJobs} blocked · {ws.dailyMicroUsd / 1_000_000} USD today
                </p>
              </div>
              <div class="flex items-center gap-control-gap">
                <Badge theme={ws.health === "healthy" ? "green" : "amber"} label={ws.health} />
                <Button onClick={() => props.onOpen(ws.workspaceId)} class="min-h-11">Open workspace</Button>
              </div>
            </article>
          )}</For>
        </ScreenRegion>
      </Section>
    </div>
  );
}
