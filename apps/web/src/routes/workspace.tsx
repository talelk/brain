import type { JSX } from "solid-js";
import { formatDateTime } from "../ui/format";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, KeyValue, Progress } from "@talelk/newui-atoms";
import { Alert, EmptyState } from "@talelk/newui-molecules";
import { DetailHeader, StatGrid } from "@talelk/newui-organisms";
import type { IncidentDetail, RunnerSnapshot, TicketDetail } from "@brain/contracts";
import { DateText, isFreshFromServer, ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { ArtifactView } from "../ui/outputs/ArtifactView";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { StatusBadge, statusHeaderTheme, statusLabel } from "../ui/components/StatusBadge";
import { ReasonDialog } from "../ui/components/ReasonDialog";
import { DetailAside, Freshness, WorkspaceSection } from "../ui/components/Domain";

export function RunnerDetailScreen(props: {
  runner?: RunnerSnapshot;
  state: ScreenState<RunnerSnapshot>;
  onRefresh: () => void;
  onBack: () => void;
  onDrain: (reason: string) => Promise<void>;
  onQuarantine: (reason: string) => Promise<void>;
  onControl: (action: "enable" | "disable" | "rotate" | "deregister", reason: string) => Promise<void>;
  canOperate: boolean;
}): JSX.Element {
  const [reason, setReason] = createSignal("");
  const [operation, setOperation] = createSignal<"drain" | "quarantine" | "enable" | "disable" | "rotate" | "deregister">();
  const runner = () => props.runner;
  const operationTitle = () =>
    ({
      drain: "Drain this runner",
      quarantine: "Quarantine this runner",
      enable: "Enable this runner",
      disable: "Disable this runner",
      rotate: "Rotate runner enrollment",
      deregister: "Deregister this runner",
    })[operation() ?? "drain"];
  const operationDescription = () =>
    ({
      drain: `Prevent new assignments while ${runner()?.activeAttemptIds.length ?? 0} active attempts continue.`,
      quarantine: "Request stop and credential revocation in addition to refusing new assignments. Completion waits for supervisor acknowledgement.",
      enable: "Brain rechecks the current heartbeat, health and a fresh verified capability before permitting new assignments.",
      disable: "Stop future scheduling without deleting runner history. Current attempt outcomes remain explicit.",
      rotate: "Revoke the current identity and sessions, then issue a one-use replacement enrollment token. Active attempts must be finished first.",
      deregister: "Retire this identity from the active fleet after all attempts and unresolved effects are handled. History remains available by deep link.",
    })[operation() ?? "drain"];
  return (
    <BrainPage
      title="Runner detail"
      description="Diagnose verified capacity, active reservations and probe freshness before changing fleet state."
      breadcrumbs={[{ label: "Activity" }, { label: "Runners" }]}
      actions={
        <Button variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>
          Back to runners
        </Button>
      }
    >
      <ScreenRegion
        state={props.state}
        skeleton="rows"
        emptyTitle="Runner not found"
        emptyDescription="It may belong to another organization or no longer be visible to your account."
        emptyAction={
          <Button variant="outline" onClick={props.onBack}>
            Back to runners
          </Button>
        }
        onRetry={props.onRefresh}
      >
        <PageStack>
          <DetailHeader
            title={runner()?.runnerId ?? "Runner"}
            headingLevel={2}
            subtitle={`Group ${runner()?.group ?? "—"} · ${runner()?.connectivity ?? "unknown"}`}
            status={{
              label: runner()?.deregisteredAt ? "deregistered" : (runner()?.displayStatus ?? "unknown"),
              theme: statusHeaderTheme("runner", runner()?.displayStatus ?? ""),
            }}
          />
          <p class="-mt-2 text-caption text-ink-gray-6 break-all">heartbeat {runner()?.lastSeenAt ?? "unknown"}</p>
          <Show when={runner()?.deregisteredAt}>
            <Alert
              theme="gray"
              variant="outline"
              title="Runner deregistered"
              description="This identity is retired from the active fleet. Its attempts and operational history are preserved; credentials cannot be re-enabled."
            />
          </Show>
          <Show when={runner()?.adminState === "quarantined"}>
            <Alert
              theme="red"
              variant="outline"
              title="Quarantine is pending acknowledgement"
              description="New assignments are refused. Stop and credential revocation complete only when the supervisor acknowledges."
            />
          </Show>
          <Show when={runner()?.adminState === "draining"}>
            <Alert
              theme="amber"
              variant="outline"
              title="Draining"
              description="No new jobs are assigned; current attempts keep their leases until they finish."
            />
          </Show>
          <StatGrid compact
            stats={[
              {
                label: "Attempt slots",
                value: `${runner()?.reserved.slots ?? 0} / ${runner()?.capacity.slots ?? 0}`,
                hint: "Reserved / capacity",
                icon: "lucide-layout-grid",
              },
              {
                label: "CPU",
                value: `${runner()?.reserved.cpuMillicores ?? 0}m / ${runner()?.capacity.cpuMillicores ?? 0}m`,
                hint: `${runner()?.observedFree.cpuMillicores ?? 0}m observed free`,
                icon: "lucide-cpu",
              },
              {
                label: "Memory",
                value: `${runner()?.reserved.memoryMb ?? 0} / ${runner()?.capacity.memoryMb ?? 0} MB`,
                hint: `${runner()?.observedFree.memoryMb ?? 0} MB observed free`,
                icon: "lucide-memory-stick",
              },
              { label: "Active attempts", value: String(runner()?.activeAttemptIds.length ?? 0), hint: "Current allocated slots", icon: "lucide-activity" },
            ]}
          />
          <div class="brain-run-layout">
            <div class="brain-detail-stack">
              <WorkspaceSection title="Capacity versus reservations" description="Reserved authority and observed free resources are separate measurements.">
                <div class="grid gap-4 sm:grid-cols-2">
                  <KeyValue label="Disk capacity" value={`${runner()?.capacity.diskMb ?? 0} MB`} />
                  <KeyValue label="Observed free slots" value={`${runner()?.observedFree.slots ?? 0}`} />
                </div>
                <Progress
                  label="Slots in use"
                  value={(((runner()?.capacity.slots ?? 0) - (runner()?.observedFree.slots ?? 0)) / Math.max(1, runner()?.capacity.slots ?? 1)) * 100}
                  hint
                />
              </WorkspaceSection>
              <WorkspaceSection
                title="Verified capability inventory"
                description="Every capability retains its own verification and expiry; a stale probe is not permission."
              >
                <Show
                  when={runner()?.capabilities.length}
                  fallback={
                    <EmptyState size="sm"
                      icon="lucide-shield-question"
                      title="No verified capabilities"
                      description="This runner cannot satisfy capability-dependent placement until fresh probes arrive."
                    />
                  }
                >
                  <div class="brain-queue">
                    <For each={runner()?.capabilities ?? []}>
                      {(capability) => (
                        <div class="grid gap-2 border-b border-outline-gray-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                          <div>
                            <p class="break-words text-base-medium">{capability.capability}</p>
                            <p class="mt-1 text-caption text-ink-gray-6">
                              Observed <DateText value={capability.observedAt} /> · expires <DateText value={capability.expiresAt} />
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            theme={capability.verified ? "green" : "gray"}
                            label={capability.verified ? "Verified probe" : "Unverified"}
                          />
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </WorkspaceSection>
              <WorkspaceSection title="Active attempt slots" description="Attempts currently holding runner reservations.">
                <Show
                  when={runner()?.activeAttemptIds.length}
                  fallback={<p class="text-interface text-ink-gray-7">No active attempts are allocated to this runner.</p>}
                >
                  <ul class="flex flex-col gap-2">
                    <For each={runner()?.activeAttemptIds ?? []}>
                      {(attemptId) => <li class="break-all border-b border-outline-gray-1 py-2 text-interface">{attemptId}</li>}
                    </For>
                  </ul>
                </Show>
              </WorkspaceSection>
            </div>
            <DetailAside
              title="Runner operations"
              description="Scheduling restrictions, credential rotation and retirement have different consequences."
              sticky
            >
              <KeyValue label="Connectivity" value={<StatusBadge kind="connection" status={runner()?.connectivity ?? "offline"} />} orientation="vertical" />
              <KeyValue label="Administrative state" value={<StatusBadge kind="runner" status={runner()?.adminState ?? "disabled"} />} orientation="vertical" />
              <Show
                when={props.canOperate && !runner()?.deregisteredAt}
                fallback={<p class="text-interface text-ink-gray-6">Your current role can inspect this runner but cannot change its administrative state.</p>}
              >
                <div class="flex flex-col gap-3 border-t border-outline-gray-1 pt-4">
                  <p class="text-caption text-ink-gray-6">Scheduling</p>
                  <div class="flex flex-wrap gap-2">
                    <Show when={runner()?.adminState !== "enabled"}>
                      <Button variant="outline" onClick={() => setOperation("enable")}>
                        Enable / re-enable
                      </Button>
                    </Show>
                    <Show when={runner()?.adminState === "enabled" || runner()?.adminState === "draining"}>
                      <Button variant="outline" onClick={() => setOperation("disable")}>
                        Disable
                      </Button>
                    </Show>
                    <Button variant="outline" disabled={runner()?.adminState === "draining"} onClick={() => setOperation("drain")}>
                      Drain runner
                    </Button>
                  </div>
                  <p class="text-caption text-ink-gray-6">Trust and identity</p>
                  <div class="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={(runner()?.activeAttemptIds.length ?? 0) > 0} onClick={() => setOperation("rotate")}>
                      Rotate / re-enroll
                    </Button>
                    <Button
                      variant="outline"
                      theme="red"
                      disabled={runner()?.adminState === "quarantined"}
                      onClick={() => setOperation("quarantine")}
                    >
                      Quarantine runner
                    </Button>
                    <Button
                      variant="outline"
                      theme="red"
                      disabled={(runner()?.activeAttemptIds.length ?? 0) > 0}
                      onClick={() => setOperation("deregister")}
                    >
                      Deregister
                    </Button>
                  </div>
                  <p class="text-caption text-ink-gray-6">
                    Every action requires an audit reason. Rotation and deregistration are blocked while attempts are active or unresolved.
                  </p>
                </div>
              </Show>
            </DetailAside>
          </div>
        </PageStack>
        <ReasonDialog
          open={Boolean(operation())}
          onClose={() => {
            setOperation(undefined);
            setReason("");
          }}
          title={operationTitle()}
          description={operationDescription()}
          reason={reason()}
          onReason={setReason}
          reasonLabel="Operations reason"
          multiline={false}
          confirmLabel={operationTitle()}
          tone={operation() === "quarantine" || operation() === "deregister" ? "red" : "blue"}
          onConfirm={(value) => {
            const action = operation();
            if (action === "drain") void props.onDrain(value);
            else if (action === "quarantine") void props.onQuarantine(value);
            else if (action) void props.onControl(action, value);
            setOperation(undefined);
            setReason("");
          }}
        />
      </ScreenRegion>
    </BrainPage>
  );
}

export function TicketDetailScreen(props: {
  ticket?: TicketDetail;
  state: ScreenState<TicketDetail>;
  onRefresh: () => void;
  onBack: () => void;
  onOpenApproval?: (approvalId: string) => void;
}): JSX.Element {
  const ticket = () => props.ticket;
  return (
    <BrainPage
      title="Ticket casework"
      description="Read the customer issue, investigation and draft as separate stages before exact publication approval."
      breadcrumbs={[{ label: "Work" }, { label: "Support" }]}
      actions={
        <Button variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>
          Back to tickets
        </Button>
      }
    >
      <ScreenRegion
        state={props.state}
        skeleton="rows"
        emptyTitle="Ticket not found"
        emptyDescription="It may have been closed at the source."
        emptyAction={
          <Button variant="outline" onClick={props.onBack}>
            Back to tickets
          </Button>
        }
        onRetry={props.onRefresh}
      >
        <PageStack>
          <DetailHeader
            title={ticket()?.title ?? "Ticket"}
            headingLevel={2}
            subtitle={`Ticket ${ticket()?.id ?? "—"} · updated ${ticket()?.updatedAt ? formatDateTime(ticket()!.updatedAt) : "—"}`}
            status={{ label: statusLabel("ticket", ticket()?.state ?? "open"), theme: statusHeaderTheme("ticket", ticket()?.state ?? "open") }}
          />
          <div class="brain-run-layout">
            <div class="brain-detail-stack">
              <WorkspaceSection title="1 · Customer request" description="Immutable source content; this is not Brain's proposed response.">
                <ArtifactView artifact={ticket()?.body} title="Ticket body" />
              </WorkspaceSection>
              <WorkspaceSection title="2 · Investigation and draft" description="A draft is reviewable text, not a published response.">
                <Show
                  when={ticket()?.draft}
                  fallback={
                    <Alert
                      theme="gray"
                      variant="outline"
                      title="No draft prepared"
                      description="Start a linked support task to investigate and prepare a reviewable response. Nothing can be published until a draft exists."
                    />
                  }
                >
                  <ArtifactView artifact={ticket()?.draft} title="Proposed response" />
                </Show>
              </WorkspaceSection>
              <WorkspaceSection title="3 · Verification and publication" description="Drafted, approved and published remain different states.">
                <div class="flex flex-wrap items-center gap-3">
                  <Badge
                    variant="outline"
                    theme={ticket()?.evidenceReady ? "green" : "amber"}
                    label={ticket()?.evidenceReady ? "Draft evidence ready" : "Evidence not ready"}
                  />
                  <Show when={ticket()?.approvalId}>
                    <Button variant="solid" theme="blue" iconRight="lucide-arrow-right" onClick={() => props.onOpenApproval?.(ticket()!.approvalId!)}>
                      Review exact publication approval
                    </Button>
                  </Show>
                </div>
                <Show when={!ticket()?.approvalId}>
                  <p class="text-interface text-ink-gray-7">
                    No exact publication approval is linked. A draft and independent evidence alone do not authorize publication.
                  </p>
                </Show>
              </WorkspaceSection>
            </div>
            <DetailAside title="Case context" description="Source and current review facts." sticky>
              <KeyValue label="Priority" value={<StatusBadge kind="severity" status={ticket()?.priority ?? "normal"} />} orientation="vertical" />
              <KeyValue label="Ticket state" value={<StatusBadge kind="ticket" status={ticket()?.state ?? "open"} />} orientation="vertical" />
              <KeyValue label="Source version" value={ticket()?.sourceVersion ?? "—"} orientation="vertical" />
              <KeyValue label="Record version" value={String(ticket()?.version ?? "—")} orientation="vertical" />
              <KeyValue label="Created" value={<DateText value={ticket()?.createdAt} />} orientation="vertical" />
            </DetailAside>
          </div>
        </PageStack>
      </ScreenRegion>
    </BrainPage>
  );
}

export function IncidentDetailScreen(props: {
  incident?: IncidentDetail;
  state: ScreenState<IncidentDetail>;
  onRefresh: () => void;
  onBack: () => void;
}): JSX.Element {
  const incident = () => props.incident;
  const fresh = () => isFreshFromServer(incident()?.expiresAt, props.state.asOf);
  return (
    <BrainPage
      title="Incident investigation"
      description="Correlate actual observations and freshness before separating read-only diagnosis from governed remediation."
      breadcrumbs={[{ label: "Work" }, { label: "Incidents" }]}
      actions={
        <Button variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>
          Back to incidents
        </Button>
      }
    >
      <ScreenRegion
        state={props.state}
        skeleton="rows"
        emptyTitle="Incident not found"
        emptyDescription="It may have been resolved and archived."
        emptyAction={
          <Button variant="outline" onClick={props.onBack}>
            Back to incidents
          </Button>
        }
        onRetry={props.onRefresh}
      >
        <PageStack>
          <DetailHeader
            title={incident()?.title ?? "Incident"}
            headingLevel={2}
            subtitle={`${incident()?.targetKey ?? "—"} · observed ${incident()?.observedAt ? formatDateTime(incident()!.observedAt) : "—"}`}
            status={{ label: statusLabel("incident", incident()?.state ?? "open"), theme: statusHeaderTheme("incident", incident()?.state ?? "open") }}
          />
          <Show when={!fresh()}>
            <Alert
              theme="amber"
              variant="outline"
              title="Observation is stale or cannot be revalidated"
              description="Do not treat the last observation as current health or authorize remediation from stale telemetry."
            />
          </Show>
          <div class="brain-run-layout">
            <div class="brain-detail-stack">
              <WorkspaceSection title="Investigation timeline" description="Pinned observations show what was seen, where and when.">
                <Show
                  when={(incident()?.observations.length ?? 0) > 0}
                  fallback={
                    <EmptyState size="sm"
                      icon="lucide-scan-search"
                      title="No observation artifacts"
                      description="There is no evidence timeline yet. Start a linked investigation task to gather current, scoped observations."
                    />
                  }
                >
                  <For each={incident()?.observations ?? []}>
                    {(artifact, index) => (
                      <article class="relative border-s-2 border-outline-blue-3 ps-4">
                        <div class="mb-2 flex flex-wrap items-center gap-2">
                          <Badge variant="outline" theme="blue" label={`Observation ${index() + 1}`} />
                          <span class="text-caption text-ink-gray-6">
                            Observed <DateText value={incident()?.observedAt} />
                          </span>
                        </div>
                        <ArtifactView artifact={artifact} compact />
                      </article>
                    )}
                  </For>
                </Show>
              </WorkspaceSection>
              <WorkspaceSection title="Diagnosis versus remediation" description="A proposed action is inert until its exact effect is authorized.">
                <Show
                  when={incident()?.proposedAction}
                  fallback={<p class="text-interface text-ink-gray-7">No remediation has been proposed. Read-only investigation does not change the target.</p>}
                >
                  {(action) => (
                    <div>
                      <Alert
                        theme="amber"
                        variant="outline"
                        title="Governed remediation proposal"
                        description={`${action().operation} on ${action().target.targetId}. This proposal does not prove execution or resolution.`}
                      />
                      <TechnicalDetails label="Exact proposed subject">
                        <pre class="overflow-x-auto whitespace-pre-wrap break-all text-caption">{JSON.stringify(action(), null, 2)}</pre>
                      </TechnicalDetails>
                    </div>
                  )}
                </Show>
              </WorkspaceSection>
            </div>
            <DetailAside title="Observation context" description="Freshness is part of the incident state." sticky>
              <KeyValue label="Severity" value={<StatusBadge kind="severity" status={incident()?.severity ?? "info"} />} orientation="vertical" />
              <KeyValue label="Target" value={incident()?.targetKey ?? "—"} orientation="vertical" />
              <KeyValue label="Observed" value={<DateText value={incident()?.observedAt} />} orientation="vertical" />
              <KeyValue label="Valid until" value={<DateText value={incident()?.expiresAt} />} orientation="vertical" />
              <Freshness value={incident()?.observedAt} stale={!fresh()} label="Telemetry" />
            </DetailAside>
          </div>
        </PageStack>
      </ScreenRegion>
    </BrainPage>
  );
}
