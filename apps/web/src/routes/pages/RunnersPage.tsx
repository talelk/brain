import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button, Progress } from "@talelk/newui-atoms";
import { Pagination, EmptyState } from "@talelk/newui-molecules";
import { FilterBar, StatGrid } from "@talelk/newui-organisms";
import type { RunnerSnapshot } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { runnersQuery } from "../../data/governor";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { IconTile } from "../../ui/components/primitives";
import { Card } from "@talelk/newui-molecules";import { Freshness, WorkspaceSection } from "../../ui/components/Domain";import { RunnerEnrollmentDialog } from "../../ui/components/RunnerEnrollmentDialog";

function placementNote(runner: RunnerSnapshot): string {
  if (runner.connectivity === "offline") return "Cannot accept new work while offline. Last heartbeat is not current capacity proof.";
  if (runner.adminState === "quarantined") return "New assignments are refused; stop and revocation wait for acknowledgement.";
  if (runner.adminState === "draining") return "No new assignments; existing attempts continue with their leases.";
  if (runner.adminState === "disabled") return "Disabled by administration; no new assignments.";
  return "Placement remains capability- and lease-aware. Only fresh verified capabilities can satisfy demand.";
}

const PAGE_SIZE = 25;

export default function RunnersPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [enrollOpen, setEnrollOpen] = createSignal(false);
  const [page, setPage] = createSignal(1);
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const runners = createScopedRead<RunnerSnapshot[]>({
    scope: app.scope,
    load: async (_scope, signal) => {
      const loaded = await runnersQuery({}, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 10_000,
  });
  const all = () => runners.state().data ?? [];
  const groups = () => [...new Set(all().map((runner) => runner.group))].sort();
  const visible = () => all().filter((runner) =>
    (!value("group") || runner.group === value("group")) &&
    (!value("capability") || runner.capabilities.some((capability) => capability.verified && capability.capability.includes(value("capability")))) &&
    (!value("health") || runner.health === value("health")) &&
    (!value("admin") || runner.adminState === value("admin")),
  );
  // Client-side page slice; the page clamps itself when filters shrink the list.
  const pageCount = () => Math.max(1, Math.ceil(visible().length / PAGE_SIZE));
  const currentPage = () => Math.min(Math.max(1, page()), pageCount());
  const pageRows = () => visible().slice((currentPage() - 1) * PAGE_SIZE, currentPage() * PAGE_SIZE);
  return <BrainPage title="Execution fleet" description="Inspect who can execute, which capabilities are verified, and why work can or cannot be assigned."
    actions={<><Button variant="outline" iconLeft="lucide-refresh-cw" onClick={() => void runners.refresh({ force: true })}>Refresh</Button><Show when={app.identity()?.actor.scopes.includes("config:activate")}><Button variant="outline" iconLeft="lucide-file-cog" onClick={() => void navigate("/studio/RunnerGroup")}>Runner group drafts</Button></Show><Show when={app.identity()?.actor.scopes.includes("runner:admin")}><Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setEnrollOpen(true)}>Enroll runner</Button></Show></>}>
    <PageStack>
      <StatGrid compact stats={[
        { label: "Online / offline", value: `${all().filter((runner) => runner.connectivity === "online").length} / ${all().filter((runner) => runner.connectivity === "offline").length}`, hint: "Connectivity, independent of admin state", icon: "lucide-radio" },
        { label: "Idle / busy", value: `${all().filter((runner) => runner.displayStatus === "idle").length} / ${all().filter((runner) => runner.displayStatus === "busy").length}`, hint: "Current allocation", icon: "lucide-activity" },
        { label: "Draining / quarantined", value: `${all().filter((runner) => runner.adminState === "draining").length} / ${all().filter((runner) => runner.adminState === "quarantined").length}`, hint: "Administrative restrictions", icon: "lucide-shield-alert" },
        { label: "Reserved slots", value: `${all().reduce((sum, runner) => sum + runner.reserved.slots, 0)} / ${all().reduce((sum, runner) => sum + runner.capacity.slots, 0)}`, hint: "Across this authorized fleet", icon: "lucide-layout-grid" },
      ]} />
      <FilterBar resultCount={visible().length} query={{ value: value("capability"), placeholder: "Filter verified capability…", onInput: (capability) => setParams({ capability: capability || undefined }) }} selects={[
        { label: "Group", value: value("group") || undefined, options: groups().map((group) => ({ value: group, label: group })), onValueChange: (group) => setParams({ group: group || undefined }) },
        { label: "Health", value: value("health") || undefined, options: [{ value: "healthy", label: "Healthy" }, { value: "degraded", label: "Degraded" }, { value: "unhealthy", label: "Unhealthy" }], onValueChange: (health) => setParams({ health: health || undefined }) },
        { label: "Admin state", value: value("admin") || undefined, options: [{ value: "enabled", label: "Enabled" }, { value: "draining", label: "Draining" }, { value: "quarantined", label: "Quarantined" }, { value: "disabled", label: "Disabled" }], onValueChange: (admin) => setParams({ admin: admin || undefined }) },
      ]} onClearAll={value("group") || value("capability") || value("health") || value("admin") ? () => setParams({ group: undefined, capability: undefined, health: undefined, admin: undefined }) : undefined} />
      <WorkspaceSection title="Runner fleet" description="Connectivity, health, allocation and administrative state are deliberately separate.">
        <ScreenRegion state={runners.state()} skeleton="cards" emptyTitle="No runners enrolled" emptyDescription="Enroll an outbound runner supervisor to accept work for this organization." onRetry={() => void runners.refresh({ force: true })}>
          <Show when={visible().length} fallback={<EmptyState size="sm" icon="lucide-server-off" title="No runners match" description="Clear the group, capability, health or admin-state filters to see other enrolled runners." action={<Button size="sm" variant="outline" onClick={() => setParams({ group: undefined, capability: undefined, health: undefined, admin: undefined })}>Clear filters</Button>} />}>
            <div class="grid gap-3 md:grid-cols-2 2xl:grid-cols-3"><For each={pageRows()}>{(runner) => <Card padding="lg" class="flex flex-col gap-3 p-3">
              <div class="flex flex-wrap items-start justify-between gap-2"><div class="flex min-w-0 items-center gap-2.5"><IconTile icon="lucide-server" tone={runner.connectivity === "online" ? "blue" : "gray"} /><div class="min-w-0"><h3 class="break-all text-base-medium">{runner.runnerId}</h3><p class="mt-0.5 break-words text-caption text-ink-gray-6">Group {runner.group}</p></div></div><StatusBadge kind="runner" status={runner.displayStatus} /></div>
              <div class="flex flex-wrap gap-1.5"><StatusBadge kind="connection" status={runner.connectivity} /><StatusBadge kind="health" status={runner.health} /><Show when={runner.adminState !== "enabled"}><StatusBadge kind="runner" status={runner.adminState} /></Show></div>
              <div><div class="mb-1.5 flex justify-between gap-2 text-caption text-ink-gray-7"><span>Attempt slots reserved</span><span class="tabular-nums">{runner.reserved.slots}/{runner.capacity.slots}</span></div><Progress label="Slots reserved" value={runner.reserved.slots / Math.max(1, runner.capacity.slots) * 100} /></div>
              <dl class="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-3 gap-y-2 text-caption"><div class="min-w-0"><dt class="text-ink-gray-6">CPU reserved</dt><dd class="mt-0.5 break-words text-interface tabular-nums">{runner.reserved.cpuMillicores}m / {runner.capacity.cpuMillicores}m</dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Memory reserved</dt><dd class="mt-0.5 break-words text-interface tabular-nums">{runner.reserved.memoryMb} / {runner.capacity.memoryMb} MB</dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Verified capabilities</dt><dd class="mt-0.5 text-interface tabular-nums">{runner.capabilities.filter((capability) => capability.verified).length} / {runner.capabilities.length}</dd></div><div class="min-w-0"><dt class="text-ink-gray-6">Active attempts</dt><dd class="mt-0.5 text-interface tabular-nums">{runner.activeAttemptIds.length}</dd></div></dl>
              <p class="break-words text-interface text-ink-gray-7">{placementNote(runner)}</p>
              <div class="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-outline-gray-1 pt-2.5"><Freshness value={runner.lastSeenAt} stale={runner.connectivity === "offline"} label="Heartbeat" /><Button size="sm" variant="outline" iconRight="lucide-arrow-right" onClick={() => void navigate(`/runners/${runner.runnerId}`)}>Diagnostics</Button></div>
            </Card>}</For></div>
            <Show when={visible().length > PAGE_SIZE}>
              <Pagination.Root aria-label="Runner fleet pages" count={visible().length} pageSize={PAGE_SIZE} page={currentPage()} onPageChange={setPage} class="mt-4 flex-wrap items-center gap-3">
                <Pagination.Range class="me-auto" />
                <Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger />
              </Pagination.Root>
            </Show>
          </Show>
        </ScreenRegion>
      </WorkspaceSection>
      <RunnerEnrollmentDialog open={enrollOpen()} onClose={() => { setEnrollOpen(false); void runners.refresh({ force: true }); }} defaultGroup={groups()[0]} />
    </PageStack>
  </BrainPage>;
}
