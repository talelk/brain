import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Pagination, EmptyState } from "@talelk/newui-molecules";
import { FilterBar, StatGrid } from "@talelk/newui-organisms";
import type { Automation, RunnerSnapshot } from "@brain/contracts";
import { query } from "../../data/client";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { runnersQuery } from "../../data/governor";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { IconTile } from "../../ui/components/primitives";
import { Freshness, WorkspaceSection } from "../../ui/components/Domain";import { RunnerEnrollmentDialog } from "../../ui/components/RunnerEnrollmentDialog";
import { t } from "../../i18n";

function placementNote(runner: RunnerSnapshot): string {
  if (runner.connectivity === "offline") return "Cannot accept new work while offline. Last heartbeat is not current capacity proof.";
  if (runner.adminState === "quarantined") return "New assignments are refused; stop and revocation wait for acknowledgement.";
  if (runner.adminState === "draining") return "No new assignments; existing attempts continue with their leases.";
  if (runner.adminState === "disabled") return "Disabled by administration; no new assignments.";
  return "Placement remains capability- and lease-aware. Only fresh verified capabilities can satisfy demand.";
}

const PAGE_SIZE = 25;

const pct = (used: number, total: number) => total > 0 ? Math.round(Math.min(100, Math.max(0, used / total * 100))) : 0;

/** One plain verdict per runner: can it take new work now, and if not, why. */
function verdict(runner: RunnerSnapshot): { label: string; tone: "good" | "warn" | "bad" } {
  if (runner.deregisteredAt) return { label: t("adm.deregistered.daba"), tone: "bad" };
  if (runner.connectivity === "offline") return { label: t("adm.offline-no-new-work.0b62"), tone: "bad" };
  if (runner.adminState !== "enabled") return { label: `${runner.adminState[0]?.toUpperCase()}${runner.adminState.slice(1)}: no new work`, tone: "warn" };
  if (runner.health !== "healthy") return { label: `${runner.health}: may refuse work`, tone: "warn" };
  if (runner.observedFree.slots <= 0) return { label: t("adm.full-waiting-for-a-free-slot.5d05"), tone: "warn" };
  return { label: t("adm.ready-for-work.8e6f"), tone: "good" };
}

const FLEET_STATES = [
  { status: "idle", label: "Idle", fill: "bg-surface-green-7", icon: "lucide-circle-check" },
  { status: "busy", label: "Busy", fill: "bg-surface-blue-7", icon: "lucide-loader-circle" },
  { status: "draining", label: "Draining", fill: "bg-surface-amber-6", icon: "lucide-circle-pause" },
  { status: "quarantined", label: "Quarantined", fill: "bg-surface-red-7", icon: "lucide-shield-alert" },
  { status: "disabled", label: "Disabled", fill: "bg-surface-gray-5", icon: "lucide-circle-slash" },
  { status: "offline", label: "Offline", fill: "bg-surface-gray-7", icon: "lucide-wifi-off" },
] as const;

/** Fleet at a glance: one segmented bar by display status, with an icon + count legend so colour is never the only cue. */
function FleetBar(props: { runners: RunnerSnapshot[] }): JSX.Element {
  const rows = () => FLEET_STATES.map((state) => ({ ...state, count: props.runners.filter((runner) => runner.displayStatus === state.status).length })).filter((row) => row.count > 0);
  const summary = () => `Runner fleet: ${rows().map((row) => `${row.count} ${row.label.toLowerCase()}`).join(", ")}`;
  return <Show when={props.runners.length > 0}>
    <div class="flex min-w-0 flex-col gap-2">
      <Show when={rows().length > 1}><div role="img" aria-label={summary()} class="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-gray-3"><For each={rows()}>{(row) => <span class={`h-full ${row.fill}`} style={{ width: `${row.count / props.runners.length * 100}%` }} />}</For></div></Show>
      <ul class="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-7" aria-hidden={rows().length > 1}><For each={rows()}>{(row) => <li class="inline-flex items-center gap-1"><span class={`${row.icon} size-3`} />{row.label} {row.count}</li>}</For></ul>
    </div>
  </Show>;
}

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
  });
  const automations = createScopedRead<Automation[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: Automation[] }; asOf: string; sourceWatermark: number }>({ queryType: "automations.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const pinnedCount = (runnerId: string) => (automations.state().data ?? []).filter((automation) => automation.state !== "retired" && automation.execution.mode === "personal-host" && automation.execution.runnerId === runnerId).length;
  const all = () => runners.state().data ?? [];
  /** No runner has ever enrolled: explain what a runner is and the one next step, instead of zeroed stats and empty filters. */
  const firstUse = () => runners.state().status === "empty-authorized";
  const canEnroll = () => Boolean(app.identity()?.actor.scopes.includes("runner:admin"));
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
  return <BrainPage title={t("adm.runners.ccf7")} description={t("adm.the-machines-that-execute-work-e.f398")}
    actions={<><Show when={app.identity()?.actor.scopes.includes("config:activate")}><Button variant="outline" iconLeft="lucide-file-cog" onClick={() => void navigate("/studio/RunnerGroup")}>{t("adm.runner-group-drafts.6a19")}</Button></Show><Show when={app.identity()?.actor.scopes.includes("runner:admin")}><Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setEnrollOpen(true)}>{t("adm.enroll-runner.11df")}</Button></Show></>}>
    <PageStack>
      <Show when={firstUse()}><div class="flex flex-col items-center gap-3 rounded-card border border-outline-gray-1 bg-surface-elevation-1 px-4 py-10 text-center">
        <IconTile icon="lucide-server" tone="gray" />
        <h2 class="text-base-medium">{t("adm.no-runner-is-connected-yet.00ff")}</h2>
        <p class="brain-readable max-w-xl text-interface text-ink-gray-7">{t("adm.a-runner-is-the-machine-that-act.fa78")}</p>
        <Show when={canEnroll()} fallback={<p class="max-w-xl text-interface text-ink-gray-7">{t("adm.ask-an-administrator-to-enroll-a.e210")}</p>}>
          <ol class="max-w-xl list-decimal ps-5 text-start text-interface text-ink-gray-7"><li>Choose Enroll runner to get a one-use credential (valid ten minutes).</li><li>{t("adm.start-the-runner-on-the-machine.a903")}</li><li>{t("adm.come-back-here-it-appears-with-a.00cc")}</li></ol>
          <Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setEnrollOpen(true)}>{t("adm.enroll-your-first-runner.ca8e")}</Button>
        </Show>
      </div></Show>
      <Show when={!firstUse()}><FleetBar runners={all()} /></Show>
      <Show when={!firstUse()}><StatGrid compact stats={[
        { label: t("adm.online-offline.e571"), value: `${all().filter((runner) => runner.connectivity === "online").length} / ${all().filter((runner) => runner.connectivity === "offline").length}`, hint: t("adm.connectivity-independent-of-admi.6261"), icon: "lucide-radio" },
        { label: t("adm.idle-busy.8511"), value: `${all().filter((runner) => runner.displayStatus === "idle").length} / ${all().filter((runner) => runner.displayStatus === "busy").length}`, hint: t("adm.current-allocation.da79"), icon: "lucide-activity" },
        { label: t("adm.draining-quarantined.7ea6"), value: `${all().filter((runner) => runner.adminState === "draining").length} / ${all().filter((runner) => runner.adminState === "quarantined").length}`, hint: t("adm.administrative-restrictions.7e13"), icon: "lucide-shield-alert" },
        { label: t("adm.reserved-slots.ca7b"), value: `${all().reduce((sum, runner) => sum + runner.reserved.slots, 0)} / ${all().reduce((sum, runner) => sum + runner.capacity.slots, 0)}`, hint: t("adm.across-this-authorized-fleet.a221"), icon: "lucide-layout-grid" },
      ]} /></Show>
      <Show when={!firstUse()}><FilterBar resultCount={visible().length} query={{ value: value("capability"), placeholder: t("adm.filter-verified-capability.5208"), onInput: (capability) => setParams({ capability: capability || undefined }) }} selects={[
        { label: t("adm.group.171a"), value: value("group") || undefined, options: groups().map((group) => ({ value: group, label: group })), onValueChange: (group) => setParams({ group: group || undefined }) },
        { label: t("adm.health.3703"), value: value("health") || undefined, options: [{ value: "healthy", label: t("adm.healthy.80ea") }, { value: "degraded", label: t("adm.degraded.13c2") }, { value: "unhealthy", label: t("adm.unhealthy.718e") }], onValueChange: (health) => setParams({ health: health || undefined }) },
        { label: t("adm.admin-state.3c86"), value: value("admin") || undefined, options: [{ value: "enabled", label: t("adm.enabled.df17") }, { value: "draining", label: t("adm.draining.a5f8") }, { value: "quarantined", label: t("adm.quarantined.15f4") }, { value: "disabled", label: t("adm.disabled.f4f4") }], onValueChange: (admin) => setParams({ admin: admin || undefined }) },
      ]} onClearAll={value("group") || value("capability") || value("health") || value("admin") ? () => setParams({ group: undefined, capability: undefined, health: undefined, admin: undefined }) : undefined} /></Show>
      <Show when={!firstUse()}><WorkspaceSection title={t("adm.all-runners.1809")} description={t("adm.reserved-capacity-is-what-brain.934a")}>
        <ScreenRegion state={runners.state()} skeleton="cards" emptyTitle={t("adm.no-runners-enrolled.d94a")} emptyDescription={t("adm.enroll-an-outbound-runner-superv.0daa")} onRetry={() => void runners.refresh({ force: true })}>
          <Show when={visible().length} fallback={<EmptyState size="sm" icon="lucide-server-off" title={t("adm.no-runners-match.8810")} description={t("adm.clear-the-group-capability-healt.b8a4")} action={<Button size="sm" variant="outline" onClick={() => setParams({ group: undefined, capability: undefined, health: undefined, admin: undefined })}>{t("adm.clear-filters.4122")}</Button>} />}>
            <div class="relative w-full max-w-full min-w-0 overflow-x-auto"><table class="w-full min-w-[56rem] text-start text-interface">
              <caption class="sr-only">{t("adm.runner-fleet.6a1c")}</caption>
              <thead class="text-caption text-ink-gray-6"><tr class="border-b border-outline-gray-2"><th scope="col" class="py-2 pe-3 font-medium">{t("adm.runner.ae2e")}</th><th scope="col" class="py-2 pe-3 font-medium">{t("adm.can-it-take-work.363f")}</th><th scope="col" class="py-2 pe-3 font-medium">{t("adm.slots.0c1a")}</th><th scope="col" class="py-2 pe-3 font-medium">CPU</th><th scope="col" class="py-2 pe-3 font-medium">{t("adm.memory.89c8")}</th><th scope="col" class="py-2 pe-3 font-medium">{t("adm.capabilities.ca09")}</th><th scope="col" class="py-2 pe-3 font-medium">{t("adm.schedules.26d9")}</th><th scope="col" class="py-2 pe-3 font-medium">{t("adm.heartbeat.eb4d")}</th><th scope="col" class="py-2"><span class="sr-only">{t("adm.actions.c3cd")}</span></th></tr></thead>
              <tbody><For each={pageRows()}>{(runner) => { const v = verdict(runner); const pinned = () => pinnedCount(runner.runnerId); return <tr class="border-b border-outline-gray-1 align-top">
                <th scope="row" class="min-w-[11rem] py-3 pe-3 font-normal"><div class="flex min-w-0 items-center gap-2"><IconTile icon="lucide-server" tone={runner.connectivity === "online" ? "blue" : "gray"} /><div class="min-w-0"><div class="break-words text-base-medium">{runner.runnerId}</div><div class="text-caption text-ink-gray-6">Group {runner.group}</div><div class="mt-1 flex flex-wrap gap-1"><StatusBadge kind="connection" status={runner.connectivity} /><Show when={runner.adminState !== "enabled"}><StatusBadge kind="runner" status={runner.adminState} /></Show></div></div></div></th>
                <td class="py-3 pe-3"><div class="flex flex-col gap-1"><span class="inline-flex items-center gap-1.5"><span aria-hidden="true" class={`${v.tone === "good" ? "lucide-circle-check text-ink-green-3" : v.tone === "warn" ? "lucide-circle-alert text-ink-amber-3" : "lucide-circle-x text-ink-red-4"} size-4`} />{v.label}</span><span class="text-caption text-ink-gray-6">{placementNote(runner)}</span></div></td>
                <td class="py-3 pe-3 tabular-nums">{runner.reserved.slots} of {runner.capacity.slots} slots in use<div class="text-caption text-ink-gray-6">{runner.activeAttemptIds.length} running</div></td>
                <td class="py-3 pe-3 tabular-nums">{pct(runner.reserved.cpuMillicores, runner.capacity.cpuMillicores)}%<div class="text-caption text-ink-gray-6">{runner.reserved.cpuMillicores}m of {runner.capacity.cpuMillicores}m</div></td>
                <td class="py-3 pe-3 tabular-nums">{pct(runner.reserved.memoryMb, runner.capacity.memoryMb)}%<div class="text-caption text-ink-gray-6">{runner.reserved.memoryMb} of {runner.capacity.memoryMb} MB</div></td>
                <td class="py-3 pe-3 tabular-nums">{runner.capabilities.filter((capability) => capability.verified).length} / {runner.capabilities.length} verified</td>
                <td class="py-3 pe-3"><Show when={pinned() > 0} fallback={<span class="text-ink-gray-6">{t("adm.none-pinned.80ba")}</span>}><Button size="sm" variant="ghost" iconRight="lucide-calendar-clock" onClick={() => void navigate(`/w/${app.workspaceId()}/schedules`)}>{pinned()} pinned</Button></Show></td>
                <td class="py-3 pe-3"><Freshness value={runner.lastSeenAt} stale={runner.connectivity === "offline"} label={t("adm.heartbeat.eb4d")} /></td>
                <td class="py-3 text-end"><Button size="sm" variant="outline" iconRight="lucide-arrow-right" onClick={() => void navigate(`/runners/${runner.runnerId}`)}>{t("adm.details.dc3d")}</Button></td>
              </tr>; }}</For></tbody>
            </table></div>
            <Show when={visible().length > PAGE_SIZE}>
              <Pagination.Root aria-label={t("adm.runner-fleet-pages.37a8")} count={visible().length} pageSize={PAGE_SIZE} page={currentPage()} onPageChange={setPage} class="mt-4 flex-wrap items-center gap-3">
                <Pagination.Range class="me-auto" />
                <Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger />
              </Pagination.Root>
            </Show>
          </Show>
        </ScreenRegion>
      </WorkspaceSection></Show>
      <RunnerEnrollmentDialog open={enrollOpen()} onClose={() => { setEnrollOpen(false); void runners.refresh({ force: true }); }} defaultGroup={groups()[0]} />
    </PageStack>
  </BrainPage>;
}
