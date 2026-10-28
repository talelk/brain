import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, KeyValue, Progress, TextInput } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { DetailHeader, Section, StatGrid } from "@talelk/newui-organisms";
import type { IncidentDetail, RunnerSnapshot, TicketDetail, WorkspaceContext } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";

/**
 * The workspace overview: what is running, what is waiting on a human, and the
 * dispatch path into the active release's declared workflows.
 */
export function WorkspaceOverview(props: {
  workspaceId: string;
  context?: WorkspaceContext;
  workflows: readonly string[];
  canDispatch: boolean;
  onBrowseWorkflows: () => void;
  state: ScreenState<unknown>;
  onRefresh: () => void;
  onDispatch: (workflowId: string, input: Record<string, unknown>) => Promise<void>;
  blockedReason?: string;
}): JSX.Element {
  const ctx = () => props.context;

  return (
    <ScreenRegion state={props.state} skeleton="cards" emptyTitle="Workspace unavailable"
      emptyDescription={props.state.error ?? "This workspace could not be read. It may not have an active release yet."}
      emptyAction={<Button onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <div class="flex flex-col gap-field-gap">
        <StatGrid columns={4} loading={!ctx()} stats={[
          { label: "Active jobs", value: String(ctx()?.workspace.activeJobs ?? 0) },
          { label: "Awaiting approval", value: String(ctx()?.workspace.pendingApprovals ?? 0) },
          { label: "Blocked", value: String(ctx()?.workspace.blockedJobs ?? 0) },
          { label: "Spend today", value: `${(ctx()?.workspace.dailyMicroUsd ?? 0) / 1_000_000} USD` },
        ]} />
        <Section title="Active release" surface="card"
          actions={props.canDispatch ? <Button onClick={props.onBrowseWorkflows} class="min-h-11">Dispatch workflow</Button> : undefined}>
          <div class="grid gap-field-gap sm:grid-cols-2">
            <KeyValue label="Source revision" value={<code class="break-all">{ctx()?.release.sourceRevision ?? "—"}</code>} orientation="vertical" />
            <KeyValue label="Config digest" value={<code class="break-all">{ctx()?.release.configDigest ?? "—"}</code>} orientation="vertical" />
            <KeyValue label="Assets" value={`${ctx()?.release.assets.length ?? 0} declared`} />
            <KeyValue label="Health" value={<Badge theme={ctx()?.workspace.health === "healthy" ? "green" : "amber"} label={ctx()?.workspace.health ?? "unknown"} />} />
          </div>
          <Show when={props.blockedReason}>
            <Alert theme="amber" variant="outline" title="Dispatch is unavailable" description={props.blockedReason} />
          </Show>
        </Section>


      </div>
    </ScreenRegion>
  );
}

/** Runner detail: capabilities, reservations and the pending stop acknowledgement. */
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
  const runner = () => props.runner;
  return (
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Runner not found"
      emptyDescription="It may have been deregistered, or it belongs to another organization."
      emptyAction={<Button onClick={props.onBack}>Back to runners</Button>} onRetry={props.onRefresh}>
      <DetailHeader title={runner()?.runnerId ?? "Runner"} headingLevel={2} breadcrumbs={[{ label: "Runs" }]}
        subtitle={`group ${runner()?.group ?? "—"} · ${runner()?.connectivity ?? "unknown"}`}
        status={{ label: runner()?.displayStatus ?? "unknown", theme: runner()?.displayStatus === "idle" ? "green" : runner()?.displayStatus === "offline" ? "red" : "blue" }}
        actions={[{ label: "Back to runners", onClick: props.onBack }]} />

      <Show when={runner()?.adminState === "quarantined"}>
        <Alert theme="red" variant="outline" title="Quarantine is pending acknowledgement"
          description="New assignments are refused, but stop and credential revocation complete only when the supervisor acknowledges. Cleanup is not immediate." />
      </Show>
      <Show when={runner()?.adminState === "draining"}>
        <Alert theme="amber" variant="outline" title="Draining" description="No new jobs are assigned; the current attempt keeps its lease until it finishes." />
      </Show>

      <Section title="Capacity and reservations" surface="card">
        <div class="flex flex-col gap-field-gap">
          <KeyValue label="Capacity" value={`${runner()?.capacity.cpuMillicores ?? 0}m cpu · ${runner()?.capacity.memoryMb ?? 0} MB memory · ${runner()?.capacity.diskMb ?? 0} MB disk · ${runner()?.capacity.slots ?? 0} slots`} />
          <KeyValue label="Reserved" value={`${runner()?.reserved.cpuMillicores ?? 0}m cpu · ${runner()?.reserved.memoryMb ?? 0} MB memory · ${runner()?.reserved.slots ?? 0} slots`} />
          <KeyValue label="Observed free" value={`${runner()?.observedFree.cpuMillicores ?? 0}m cpu · ${runner()?.observedFree.memoryMb ?? 0} MB memory · ${runner()?.observedFree.slots ?? 0} slots`} />
          <Progress label="Slots in use" value={((runner()?.capacity.slots ?? 0) - (runner()?.observedFree.slots ?? 0)) / Math.max(1, runner()?.capacity.slots ?? 1) * 100} hint />
        </div>
      </Section>

      <Section title="Capabilities" description="Verified probes only; unverified capabilities cannot satisfy demand." surface="card">
        <For each={runner()?.capabilities ?? []}>{(capability) => (
          <div class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-2 last:border-b-0">
            <span class="text-base text-ink-gray-9">{capability.capability}</span>
            <div class="flex items-center gap-control-gap">
              <Badge theme={capability.verified ? "green" : "gray"} label={capability.verified ? "verified" : "unverified"} />
              <span class="text-caption text-ink-gray-7">expires <DateText value={capability.expiresAt} /></span>
            </div>
          </div>
        )}</For>
      </Section>

      <Show when={props.canOperate}>
        <Section title="Operations" surface="card">
          <div class="flex flex-wrap items-end gap-control-gap">
            <div class="min-w-64 flex-1"><TextInput label="Operations reason" value={reason()} onInput={(e) => setReason(e.currentTarget.value)} description="Required for both drain and quarantine." /></div>
            <Button disabled={reason().trim().length === 0 || runner()?.adminState === "draining"} class="min-h-11"
              onClick={() => void props.onDrain(reason().trim())}>
              Drain
            </Button>
            <Button variant="outline" theme="red" disabled={reason().trim().length === 0 || runner()?.adminState === "quarantined"} class="min-h-11"
              onClick={() => void props.onQuarantine(reason().trim())}>
              Quarantine
            </Button>
          </div>
        </Section>
      </Show>
    </ScreenRegion>
  );
}

/** Ticket detail: exact body, the reviewed draft, and the approval it needs. */
export function TicketDetailScreen(props: {
  ticket?: TicketDetail;
  state: ScreenState<TicketDetail>;
  onRefresh: () => void;
  onBack: () => void;
  onOpenApproval?: (approvalId: string) => void;
}): JSX.Element {
  const ticket = () => props.ticket;
  return (
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Ticket not found" emptyDescription="It may have been closed at the source."
      emptyAction={<Button onClick={props.onBack}>Back to tickets</Button>} onRetry={props.onRefresh}>
      <DetailHeader title={ticket()?.title ?? "Ticket"} headingLevel={2} breadcrumbs={[{ label: "Support" }, { label: "Tickets" }]}
        subtitle={`${ticket()?.id ?? "—"} · source v${ticket()?.sourceVersion ?? "—"} · record v${ticket()?.version ?? "—"}`}
        status={{ label: ticket()?.state ?? "open", theme: ticket()?.state === "resolved" ? "green" : "blue" }}
        actions={[{ label: "Back to tickets", onClick: props.onBack }]} />
      <Section title="Body" surface="card">
        <KeyValue label="Content" value={<code class="break-all">{ticket()?.body.digest ?? "—"}</code>} orientation="vertical" />
        <KeyValue label="Classification" value={ticket()?.body.classification ?? "internal"} />
        <KeyValue label="Bytes" value={String(ticket()?.body.bytes ?? 0)} />
      </Section>
      <Section title="Draft and approval" surface="card">
        <Show when={ticket()?.draft} fallback={<Alert theme="gray" variant="outline" title="No reviewed draft yet" description="A visible publication requires a draft plus an approval; nothing is sent from this screen." />}>
          <KeyValue label="Draft digest" value={<code class="break-all">{ticket()?.draft?.digest}</code>} orientation="vertical" />
        </Show>
        <Show when={ticket()?.approvalId}>
          <div class="flex items-center gap-control-gap pt-field">
            <Badge theme="amber" label="awaiting approval" />
            <Button variant="outline" class="min-h-11" onClick={() => props.onOpenApproval?.(ticket()!.approvalId!)}>Review the approval</Button>
          </div>
        </Show>
      </Section>
    </ScreenRegion>
  );
}

/** Incident detail: observations with their expiry plus the inert remediation. */
export function IncidentDetailScreen(props: {
  incident?: IncidentDetail;
  state: ScreenState<IncidentDetail>;
  onRefresh: () => void;
  onBack: () => void;
}): JSX.Element {
  const incident = () => props.incident;
  return (
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Incident not found" emptyDescription="It may have been resolved and archived."
      emptyAction={<Button onClick={props.onBack}>Back to incidents</Button>} onRetry={props.onRefresh}>
      <DetailHeader title={incident()?.title ?? "Incident"} headingLevel={2} breadcrumbs={[{ label: "SRE" }]}
        subtitle={`${incident()?.id ?? "—"} · ${incident()?.targetKey}`}
        status={{ label: incident()?.state ?? "open", theme: incident()?.state === "resolved" ? "green" : "blue" }}
        actions={[{ label: "Back to incidents", onClick: props.onBack }]} />
      <Section title="Observations" description="A remediation proposal needs a fresh, unexpired observation." surface="card">
        <KeyValue label="Severity" value={<Badge theme="red" label={incident()?.severity ?? "—"} />} />
        <KeyValue label="Observed" value={<DateText value={incident()?.observedAt} />} />
        <KeyValue label="Observation expires" value={<DateText value={incident()?.expiresAt} />} />
      </Section>
      <Section title="Observation artifacts" description="The pinned observations a remediation would act on." surface="card">
        <Show when={(incident()?.observations.length ?? 0) > 0}
          fallback={<p class="text-base text-ink-gray-7">No observation artifacts are bound to this incident yet.</p>}>
          <For each={incident()?.observations ?? []}>{(artifact) => (
            <div class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-2 last:border-b-0">
              <div class="min-w-0">
                <p class="truncate text-base-medium text-ink-gray-9">{artifact.artifactId}</p>
                <p class="break-all text-caption text-ink-gray-7">{artifact.digest} · {artifact.mediaType} · {artifact.bytes} bytes</p>
              </div>
              <Button size="sm" onClick={() => { window.location.href = `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/content`; }}>
                Open artifact
              </Button>
            </div>
          )}</For>
        </Show>
      </Section>
    </ScreenRegion>
  );
}
