import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import type { WorkspaceSummary } from "@brain/contracts";
import { ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { BrainPage, PageStack } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { formatUsd } from "../ui/format";
import { IconTile } from "../ui/components/primitives";
import { Card } from "@talelk/newui-molecules";import { Freshness, WorkspaceSection } from "../ui/components/Domain";import { WorkspaceManagementDialog } from "../ui/components/WorkspaceManagementDialog";
import { useApp } from "../ui/app-context";
import { StatGrid } from "@talelk/newui-organisms";

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
    actions={<><Button variant="outline" iconLeft="lucide-refresh-cw" onClick={props.onRefresh}>Refresh</Button><Show when={app.identity()?.actor.scopes.includes("config:activate")}><Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setCreateOpen(true)}>Create workspace</Button></Show></>}>
    <PageStack>
      <StatGrid compact stats={[
        { label: "Readable workspaces", value: String(props.workspaces.length), hint: "Authorized to your account", icon: "lucide-building-2" },
        { label: "Actionable exceptions", value: String(total()), hint: "Pending approvals and blocked runs", icon: "lucide-inbox" },
      ]} />
      <WorkspaceSection title="Workspace control" description="Actionable workspaces are first. Quiet workspaces remain available without implying systemwide health.">
        <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No workspaces assigned"
          emptyDescription="Ask an organization administrator to grant you workspace access."
          emptyAction={<Button onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
          <div class={`grid gap-3 ${ordered().length === 1 ? "max-w-3xl" : "md:grid-cols-2 xl:grid-cols-3"}`}>
            <For each={ordered()}>{(ws) => {
              const attention = ws.pendingApprovals + ws.blockedJobs;
              return <Card padding="lg" class="bg-surface-gray-1 flex min-w-0 flex-col gap-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-3"><IconTile icon="lucide-building-2" tone={attention ? "amber" : "gray"} size="md" /><div class="min-w-0"><h3 class="break-words text-section text-ink-gray-9">{ws.displayName}</h3><p class="mt-1 text-caption text-ink-gray-6">{attention ? `${attention} items need attention` : "No approval or blocked-run exceptions"}</p></div></div>
                  <StatusBadge kind="health" status={ws.health} />
                </div>
                <dl class="grid grid-cols-2 gap-3 border-y border-outline-gray-1 py-3 text-interface sm:grid-cols-4">
                  <div><dt class="text-caption text-ink-gray-6">Active runs</dt><dd class="mt-1 text-base-medium tabular-nums">{ws.activeJobs}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Approvals</dt><dd class="mt-1 text-base-medium tabular-nums">{ws.pendingApprovals}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Blocked</dt><dd class="mt-1 text-base-medium tabular-nums">{ws.blockedJobs}</dd></div>
                  <div><dt class="text-caption text-ink-gray-6">Spend today</dt><dd class="mt-1 text-base-medium tabular-nums">{formatUsd(ws.dailyMicroUsd)}</dd></div>
                </dl>
                <div class="flex flex-wrap items-center justify-between gap-3"><Freshness value={ws.observedAt} stale={ws.health === "unknown"} /><div class="flex flex-wrap gap-2"><Show when={app.canAdminister()}><Button variant="ghost" onClick={() => setManaging(ws)}>Manage</Button></Show><Button variant={attention ? "solid" : "outline"} theme="blue" iconRight="lucide-arrow-right" onClick={() => props.onOpen(ws.workspaceId)}>Open workspace</Button></div></div>
              </Card>;
            }}</For>
          </div>
        </ScreenRegion>
      </WorkspaceSection>
      <WorkspaceManagementDialog open={createOpen()} onClose={() => setCreateOpen(false)} onChanged={async () => { props.onRefresh(); }} />
      <Show when={managing()}>{(workspace) => <WorkspaceManagementDialog open workspace={workspace()} onClose={() => setManaging(undefined)} onChanged={async () => { setManaging(undefined); props.onRefresh(); }} />}</Show>
    </PageStack>
  </BrainPage>;
}
