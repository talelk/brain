import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, KeyValue, Progress } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { DetailHeader, Section, StatGrid } from "@talelk/newui-organisms";
import type { IncidentDetail, RunnerSnapshot, TicketDetail, WorkspaceContext } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { ArtifactContent } from "../ui/components/ArtifactContent";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { StatusBadge, statusHeaderTheme, statusLabel } from "../ui/components/StatusBadge";
import { formatMicroUsd } from "../ui/format";
import { ReasonDialog } from "../ui/components/ReasonDialog";
import { RefreshButton } from "../ui/components/primitives";
import { IconTile } from "../ui/components/primitives";

export function WorkspaceOverview(props: {
  workspaceId: string;
  context?: WorkspaceContext;
  canDispatch: boolean;
  onBrowseWorkflows: () => void;
  state: ScreenState<unknown>;
  onRefresh: () => void;
  blockedReason?: string;
}): JSX.Element {
  const ctx = () => props.context;
  return <BrainPage title="Overview" description="See what is running, what needs a human, and the safest way to start new work."
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={props.canDispatch}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onBrowseWorkflows}>Start work</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="cards" emptyTitle="Workspace unavailable"
      emptyDescription={props.state.error ?? "This workspace could not be read. It may not have an active release yet."}
      emptyAction={<Button size="md" variant="outline" onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <StatGrid compact columns={4} loading={!ctx()} stats={[
          { label: "Active jobs", value: String(ctx()?.workspace.activeJobs ?? 0), hint: "Currently in execution", icon: "lucide-activity" },
          { label: "Awaiting approval", value: String(ctx()?.workspace.pendingApprovals ?? 0), hint: "Human decisions required", icon: "lucide-shield-check" },
          { label: "Blocked", value: String(ctx()?.workspace.blockedJobs ?? 0), hint: "Work needing attention", icon: "lucide-circle-pause" },
          { label: "Spend today", value: formatMicroUsd(ctx()?.workspace.dailyMicroUsd), hint: "Authorized usage today", icon: "lucide-wallet-cards" },
        ]} />
        <Section title="Ready to work" description="Choose a declared outcome, review its inputs, and follow the independently checked result." surface="card"
          actions={props.canDispatch ? <Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onBrowseWorkflows}>Browse tasks</Button> : undefined}>
          <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-3"><IconTile icon="lucide-sparkles" size="lg" /><div><p class="text-base-medium">Start from the active release</p><p class="text-caption text-ink-gray-6">{ctx()?.release.assets.length ?? 0} declared assets · workspace {ctx()?.workspace.health ?? "unknown"}</p></div></div>
            <StatusBadge kind="health" status={ctx()?.workspace.health ?? "unknown"} />
          </div>
          <Show when={props.blockedReason}><Alert theme="amber" variant="outline" title="Dispatch is unavailable" description={props.blockedReason} /></Show>
        </Section>
        <TechnicalDetails label="Active configuration">
          <div class="grid gap-field-gap sm:grid-cols-2">
            <KeyValue label="Source revision" value={<code class="break-all">{ctx()?.release.sourceRevision ?? "—"}</code>} orientation="vertical" />
            <KeyValue label="Config digest" value={<code class="break-all">{ctx()?.release.configDigest ?? "—"}</code>} orientation="vertical" />
            <KeyValue label="Assets" value={`${ctx()?.release.assets.length ?? 0} declared`} />
            <KeyValue label="Health" value={<StatusBadge kind="health" status={ctx()?.workspace.health ?? "unknown"} />} />
          </div>
        </TechnicalDetails>
      </PageStack>
    </ScreenRegion>
  </BrainPage>;
}

export function RunnerDetailScreen(props: {
  runner?: RunnerSnapshot;
  state: ScreenState<RunnerSnapshot>;
  onRefresh: () => void;
  onBack: () => void;
  onDrain: (reason: string) => Promise<void>;
  onQuarantine: (reason: string) => Promise<void>;
  canOperate: boolean;
}): JSX.Element {
  const [reason, setReason] = createSignal("");
  const [operation, setOperation] = createSignal<"drain" | "quarantine">();
  const runner = () => props.runner;
  return <BrainPage title="Runner detail" description="Inspect verified capacity and operate this runner with an explicit reason."
    breadcrumbs={[{ label: "Activity" }, { label: "Runners" }]}
    actions={<Button size="lg" variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Back to runners</Button>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Runner not found"
      emptyDescription="It may have been deregistered, or it belongs to another organization."
      emptyAction={<Button size="md" variant="outline" onClick={props.onBack}>Back to runners</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <DetailHeader title={runner()?.runnerId ?? "Runner"} headingLevel={2}
          subtitle={`Group ${runner()?.group ?? "—"} · ${runner()?.connectivity ?? "unknown"}`}
          status={{ label: runner()?.displayStatus ?? "unknown", theme: statusHeaderTheme("runner", runner()?.displayStatus ?? "") }} />
        <Show when={runner()?.adminState === "quarantined"}><Alert theme="red" variant="outline" title="Quarantine is pending acknowledgement" description="New assignments are refused. Stop and credential revocation complete only when the supervisor acknowledges." /></Show>
        <Show when={runner()?.adminState === "draining"}><Alert theme="amber" variant="outline" title="Draining" description="No new jobs are assigned; the current attempt keeps its lease until it finishes." /></Show>
        <div class="grid gap-section-gap xl:grid-cols-2">
          <Section title="Capacity and reservations" surface="card"><div class="flex flex-col gap-field-gap">
            <KeyValue label="Capacity" value={`${runner()?.capacity.cpuMillicores ?? 0}m CPU · ${runner()?.capacity.memoryMb ?? 0} MB memory · ${runner()?.capacity.diskMb ?? 0} MB disk · ${runner()?.capacity.slots ?? 0} slots`} />
            <KeyValue label="Reserved" value={`${runner()?.reserved.cpuMillicores ?? 0}m CPU · ${runner()?.reserved.memoryMb ?? 0} MB memory · ${runner()?.reserved.slots ?? 0} slots`} />
            <KeyValue label="Observed free" value={`${runner()?.observedFree.cpuMillicores ?? 0}m CPU · ${runner()?.observedFree.memoryMb ?? 0} MB memory · ${runner()?.observedFree.slots ?? 0} slots`} />
            <Progress label="Slots in use" value={((runner()?.capacity.slots ?? 0) - (runner()?.observedFree.slots ?? 0)) / Math.max(1, runner()?.capacity.slots ?? 1) * 100} hint />
          </div></Section>
          <Section title="Verified capabilities" description="Only unexpired, verified probes can satisfy demand." surface="card"><div class="divide-y divide-outline-gray-1 brain-row-list">
            <For each={runner()?.capabilities ?? []}>{(capability) => <div class="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"><span class="text-interface text-ink-gray-9">{capability.capability}</span><div class="flex items-center gap-2"><Badge theme={capability.verified ? "green" : "gray"} label={capability.verified ? "Verified" : "Unverified"} /><span class="text-caption text-ink-gray-6">expires <DateText value={capability.expiresAt} /></span></div></div>}</For>
          </div></Section>
        </div>
        <Show when={props.canOperate}><Section title="Runner operations" description="Drain pauses new assignments. Quarantine also begins stop and credential revocation." surface="card">
          <div class="flex flex-wrap gap-control-gap"><Button size="lg" variant="outline" disabled={runner()?.adminState === "draining"} onClick={() => setOperation("drain")}>Drain runner</Button><Button size="lg" variant="outline" theme="red" disabled={runner()?.adminState === "quarantined"} onClick={() => setOperation("quarantine")}>Quarantine runner</Button></div>
        </Section></Show>
      </PageStack>
      <ReasonDialog open={Boolean(operation())} onClose={() => { setOperation(undefined); setReason(""); }}
        title={operation() === "drain" ? "Drain this runner" : "Quarantine this runner"}
        description="A named operational reason is required and recorded with the command."
        reason={reason()} onReason={setReason} reasonLabel="Operations reason" multiline={false}
        confirmLabel={operation() === "drain" ? "Drain runner" : "Quarantine runner"}
        tone={operation() === "quarantine" ? "red" : "blue"}
        onConfirm={(value) => { const action = operation(); if (action === "drain") void props.onDrain(value); if (action === "quarantine") void props.onQuarantine(value); setOperation(undefined); setReason(""); }} />
    </ScreenRegion>
  </BrainPage>;
}

export function TicketDetailScreen(props: {
  ticket?: TicketDetail;
  state: ScreenState<TicketDetail>;
  onRefresh: () => void;
  onBack: () => void;
  onOpenApproval?: (approvalId: string) => void;
}): JSX.Element {
  const ticket = () => props.ticket;
  return <BrainPage title="Ticket detail" description="Review the immutable customer request, proposed response, and its approval state."
    breadcrumbs={[{ label: "Work" }, { label: "Support" }]}
    actions={<Button size="lg" variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Back to tickets</Button>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Ticket not found" emptyDescription="It may have been closed at the source."
      emptyAction={<Button size="md" variant="outline" onClick={props.onBack}>Back to tickets</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <DetailHeader title={ticket()?.title ?? "Ticket"} headingLevel={2}
          subtitle={`${ticket()?.id ?? "—"} · source v${ticket()?.sourceVersion ?? "—"} · record v${ticket()?.version ?? "—"}`}
          status={{ label: statusLabel("ticket", ticket()?.state ?? "open"), theme: statusHeaderTheme("ticket", ticket()?.state ?? "open") }} />
        <Section title="Customer request" description="Authorized content from the immutable source artifact." surface="card"><ArtifactContent artifact={ticket()?.body} title="Ticket body" /></Section>
        <Section title="Draft and approval" surface="card"><div class="flex flex-col gap-4">
          <Show when={ticket()?.draft} fallback={<Alert theme="gray" variant="outline" title="No reviewed draft yet" description="A visible publication requires a draft plus an approval; nothing is sent from this screen." />}><ArtifactContent artifact={ticket()?.draft} title="Proposed response" /></Show>
          <Show when={ticket()?.approvalId}><div class="flex flex-wrap items-center gap-3 border-t border-outline-gray-1 pt-4"><Badge theme="amber" label="Awaiting approval" /><Button size="lg" variant="solid" theme="blue" iconRight="lucide-arrow-right" onClick={() => props.onOpenApproval?.(ticket()!.approvalId!)}>Review exact approval</Button></div></Show>
        </div></Section>
      </PageStack>
    </ScreenRegion>
  </BrainPage>;
}

export function IncidentDetailScreen(props: {
  incident?: IncidentDetail;
  state: ScreenState<IncidentDetail>;
  onRefresh: () => void;
  onBack: () => void;
}): JSX.Element {
  const incident = () => props.incident;
  return <BrainPage title="Incident detail" description="Inspect the pinned observations and their validity before proposing remediation."
    breadcrumbs={[{ label: "Work" }, { label: "Incidents" }]}
    actions={<Button size="lg" variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Back to incidents</Button>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Incident not found" emptyDescription="It may have been resolved and archived."
      emptyAction={<Button size="md" variant="outline" onClick={props.onBack}>Back to incidents</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <DetailHeader title={incident()?.title ?? "Incident"} headingLevel={2}
          subtitle={`${incident()?.id ?? "—"} · ${incident()?.targetKey}`}
          status={{ label: statusLabel("incident", incident()?.state ?? "open"), theme: statusHeaderTheme("incident", incident()?.state ?? "open") }} />
        <Section title="Observation window" description="A remediation proposal needs a fresh, unexpired observation." surface="card"><div class="grid gap-field-gap sm:grid-cols-3">
          <KeyValue label="Severity" value={<Badge theme="red" label={incident()?.severity ?? "—"} />} />
          <KeyValue label="Observed" value={<DateText value={incident()?.observedAt} />} />
          <KeyValue label="Observation expires" value={<DateText value={incident()?.expiresAt} />} />
        </div></Section>
        <Section title="Observation artifacts" description="The pinned observations a remediation would act on." surface="card"><div class="flex flex-col gap-3">
          <Show when={(incident()?.observations.length ?? 0) > 0} fallback={<p class="text-interface text-ink-gray-7">No observation artifacts are bound to this incident yet.</p>}>
            <For each={incident()?.observations ?? []}>{(artifact) => <ArtifactContent artifact={artifact} compact />}</For>
          </Show>
        </div></Section>
      </PageStack>
    </ScreenRegion>
  </BrainPage>;
}
