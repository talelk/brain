import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, KeyValue, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Pagination, TabButtons } from "@talelk/newui-molecules";
import { FilterBar } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import type { DecisionHistoryEntry, DeliveryDossier, IncidentSummary, SLASummary, TicketSummary } from "@brain/contracts";
import { DateText, isFreshFromServer, ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { formatSlaMinutes } from "../ui/format";
import { EmptyPreview, FactStrip, Freshness, QueueRow, WorkspaceSection } from "../ui/components/Domain";

type Decision = "go" | "no" | "not-now" | "need-more-data";

/** Client-side lists page at 25 rows once they outgrow a single page. */
const PAGE_SIZE = 25;

function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, page), Math.max(1, Math.ceil(count / PAGE_SIZE)));
}

/**
 * Master-detail selection: follow the first row of the current page until a row
 * is picked, and let the compact-viewport back control actually return to the
 * list instead of falling straight back into the detail pane. The compact pane
 * only follows an explicitly picked row; the default selection must never hide
 * the list on a narrow viewport.
 */
function useMasterDetail<T extends { id: string }>(selectable: () => T[], firstVisible: () => T | undefined) {
  const [selectedId, setSelectedId] = createSignal("");
  const [dismissed, setDismissed] = createSignal(false);
  const selected = () => dismissed() ? undefined : selectable().find((row) => row.id === selectedId()) ?? firstVisible();
  return {
    selected,
    picked: () => selectedId() !== "",
    pick: (id: string) => { setSelectedId(id); setDismissed(false); },
    dismiss: () => { setSelectedId(""); setDismissed(true); },
    reset: () => { setSelectedId(""); setDismissed(false); },
  };
}

/** The one client-list pager footer: range on the left, page buttons on the right; hidden until a list outgrows one page. */
function ListPager(props: { count: number; page: number; onPageChange: (page: number) => void; label: string }): JSX.Element {
  return <Show when={props.count > PAGE_SIZE}>
    <Pagination.Root class="mt-3 w-full flex-wrap items-center justify-between gap-3 border-t border-outline-gray-1 pt-3"
      aria-label={props.label} count={props.count} pageSize={PAGE_SIZE} page={clampPage(props.page, props.count)}
      onPageChange={props.onPageChange}>
      <Pagination.Range />
      <span class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></span>
    </Pagination.Root>
  </Show>;
}

export function DecisionsScreen(props: {
  decisions: DecisionHistoryEntry[];
  state: ScreenState<DecisionHistoryEntry[]>;
  onRefresh: () => void;
  onRecord: (cardId: string, decision: Decision, note: string) => Promise<void>;
  cardIds: string[];
  viewerId?: string;
  viewerName?: string;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [cardId, setCardId] = createSignal("");
  const [decision, setDecision] = createSignal<Decision | "">("");
  const [note, setNote] = createSignal("");
  const [error, setError] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [outcome, setOutcome] = createSignal("all");
  const [page, setPage] = createSignal(1);
  const actorName = (actorId: string) => actorId === props.viewerId ? props.viewerName ?? actorId : actorId;
  const visible = () => props.decisions.filter((entry) => (outcome() === "all" || entry.decision === outcome()) && `${entry.note} ${entry.cardId} ${actorName(entry.actorId)}`.toLowerCase().includes(query().toLowerCase()));
  const paged = () => {
    const current = clampPage(page(), visible().length);
    return visible().slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  };
  const selection = useMasterDetail(visible, () => paged()[0]);
  const selected = selection.selected;
  async function record() {
    if (!cardId().trim() || !note().trim() || !decision()) return;
    setError("");
    try {
      await props.onRecord(cardId().trim(), decision() as Decision, note().trim());
      setCardId(""); setDecision(""); setNote(""); setOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The decision was refused."); }
  }
  return <BrainPage title="Decisions" description="Read the business decision, rationale and provenance without confusing it with production-effect approval."
    actions={<Button size="lg" variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setOpen(true)}>Record decision</Button>}>
    <PageStack>
      <FilterBar query={{ value: query(), placeholder: "Search rationale, work, or decision maker…", onInput: (value) => { setQuery(value); setPage(1); } }} resultCount={visible().length} selects={[{ label: "Outcome", value: outcome(), options: [{ value: "all", label: "All outcomes" }, { value: "go", label: "Go" }, { value: "no", label: "No" }, { value: "not-now", label: "Not now" }, { value: "need-more-data", label: "Need more data" }], onValueChange: (value) => { setOutcome(value ?? "all"); setPage(1); } }]} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No recorded decisions yet" emptyDescription="Record the go/no-go decision for a card when you make it." onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={43} minStartSize={32} maxStartSize={60} active={selection.picked() ? "end" : "start"} start={<WorkspaceSection title="Decision register" description="Append-only business history; rationale stays readable before identifiers.">
          <Show when={visible().length} fallback={<EmptyPreview icon="lucide-scale" title="No decisions match" description="Clear the search or outcome filter to inspect other recorded decisions." />}>
            <div class="brain-queue"><For each={paged()}>{(entry) => <QueueRow title={entry.note} description={`${actorName(entry.actorId)} · ${entry.cardId}`} icon="lucide-scale" tone={entry.decision === "go" ? "green" : entry.decision === "no" ? "red" : "amber"} meta={<DateText value={entry.createdAt} />} trailing={<StatusBadge kind="decision" status={entry.decision} />} selected={selected()?.id === entry.id} onClick={() => selection.pick(entry.id)} />}</For></div>
            <ListPager count={visible().length} page={page()} onPageChange={setPage} label="Decision register pagination" />
          </Show>
        </WorkspaceSection>} end={<Show when={selected()} keyed fallback={<EmptyPreview icon="lucide-scale" title="Select a decision" description="Its complete rationale, context, actor and linked work will appear here." />}>{(entry) => <PageStack>
          <Button size="lg" variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={selection.dismiss}>Back to register</Button>
          <div><StatusBadge kind="decision" status={entry.decision} /><h2 class="brain-prose mt-3 text-section text-ink-gray-9">{entry.note}</h2></div>
          <dl class="grid gap-4 border-y border-outline-gray-1 py-4 sm:grid-cols-2"><KeyValue label="Decision maker" value={actorName(entry.actorId)} orientation="vertical" /><KeyValue label="Recorded" value={<DateText value={entry.createdAt} />} orientation="vertical" /><KeyValue label="Linked work" value={entry.cardId} orientation="vertical" /><KeyValue label="Decision type" value="Business outcome, not an exact production-effect approval" orientation="vertical" /></dl>
          <TechnicalDetails label="Decision reference"><p class="break-all">{entry.id} · actor {entry.actorId}</p></TechnicalDetails>
        </PageStack>}</Show>} />
      </ScreenRegion>
      <Dialog.Root open={open()} onOpenChange={setOpen}><Dialog.Content size="md">
        <Dialog.Header><Dialog.Title>Record a decision</Dialog.Title><Dialog.Description>Append the exact rationale. Historical decisions are not overwritten, and this does not approve a production effect.</Dialog.Description></Dialog.Header>
        <div class="my-4 flex flex-col gap-4"><div class="brain-field-grid"><TextInput label="Card id" value={cardId()} onInput={(event) => setCardId(event.currentTarget.value)} description={props.cardIds.length ? `Known cards: ${props.cardIds.slice(0, 4).join(", ")}` : undefined} /><TabButtons label="Decision" options={[{ value: "go", label: "Go" }, { value: "no", label: "No" }, { value: "not-now", label: "Not now" }, { value: "need-more-data", label: "Need more data" }]} value={decision()} onValueChange={(value) => setDecision(value as Decision | "")} /></div><Textarea label="Note" value={note()} onInput={(event) => setNote(event.currentTarget.value)} /><Show when={error()}><Alert theme="red" variant="outline" title="Decision refused" description={error()} /></Show></div>
        <Dialog.Footer class="justify-end"><Button size="md" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button size="md" variant="solid" theme="blue" iconLeft="lucide-check" disabled={!cardId().trim() || !note().trim() || !decision()} onClick={() => void record()}>Record decision</Button></Dialog.Footer>
      </Dialog.Content></Dialog.Root>
    </PageStack>
  </BrainPage>;
}

export function SupportScreen(props: {
  tickets: TicketSummary[];
  sla?: SLASummary;
  state: ScreenState<{ tickets: TicketSummary[]; sla?: SLASummary }>;
  onRefresh: () => void;
  onOpenTicket: (ticketId: string) => void;
  onDispatch: () => void;
  canDispatch: boolean;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [view, setView] = createSignal("open");
  const [page, setPage] = createSignal(1);
  const rows = () => props.tickets.filter((ticket) => (view() === "all" || ticket.state === view()) && `${ticket.id} ${ticket.title} ${ticket.priority}`.toLowerCase().includes(query().toLowerCase())).sort((a, b) => {
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    return rank[a.priority] - rank[b.priority] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  const paged = () => {
    const current = clampPage(page(), rows().length);
    return rows().slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  };
  const selection = useMasterDetail(rows, () => paged()[0]);
  const selected = selection.selected;
  return <BrainPage title="Support" description="Triage customer requests by urgency and review readiness; drafts never publish themselves."
    actions={<Show when={props.canDispatch}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Run support workflow</Button></Show>}>
    <PageStack>
      <Show when={props.sla} keyed>{(sla) => <FactStrip label="Measured support service levels" items={[
        { label: "Keyrus response time", value: formatSlaMinutes(sla.keyrusMs), hint: `${sla.responseMet} responses met of ${sla.sampleCount} samples`, icon: "lucide-timer" },
        { label: "Client wait", value: formatSlaMinutes(sla.clientWaitMs), hint: `${sla.resolutionMet} resolutions met`, icon: "lucide-clock" },
        { label: "Incomplete records", value: String(sla.incompleteRecords), hint: "Excluded from any breach inference", icon: "lucide-circle-help" },
      ]} />}</Show>
      <FilterBar query={{ value: query(), placeholder: "Search customer issue, priority, or ticket…", onInput: (value) => { setQuery(value); setPage(1); } }} resultCount={rows().length} tabs={{ label: "Ticket state", value: view(), options: [{ value: "open", label: "Open" }, { value: "pending", label: "Awaiting" }, { value: "resolved", label: "Resolved" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }], onValueChange: (value) => { setView(value); selection.reset(); setPage(1); } }} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No support tickets" emptyDescription="Connect the ticket connector and sync to see the queue." onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={48} minStartSize={34} maxStartSize={64} active={selection.picked() ? "end" : "start"} start={<WorkspaceSection title="Support triage" description="Priority and evidence readiness are visible before opening the casework page.">
          <Show when={rows().length} fallback={<EmptyPreview icon="lucide-headset" title="No tickets in this view" description="Choose another state or clear the search to see other customer requests." />}>
            <div class="brain-queue"><For each={paged()}>{(ticket) => <QueueRow title={ticket.title} description={`${ticket.priority} priority · ${ticket.evidenceReady ? "Draft evidence ready" : "Investigation or evidence pending"}`} icon="lucide-headset" tone={ticket.priority === "urgent" ? "red" : ticket.priority === "high" ? "amber" : "blue"} eyebrow={ticket.state} meta={<><span>Created <DateText value={ticket.createdAt} /></span><Freshness value={ticket.updatedAt} /></>} trailing={<StatusBadge kind="ticket" status={ticket.state} />} selected={selected()?.id === ticket.id} onClick={() => { if (window.matchMedia("(min-width: 1024px)").matches) selection.pick(ticket.id); else props.onOpenTicket(ticket.id); }} />}</For></div>
            <ListPager count={rows().length} page={page()} onPageChange={setPage} label="Support triage pagination" />
          </Show>
        </WorkspaceSection>} end={<Show when={selected()} keyed fallback={<EmptyPreview icon="lucide-headset" title="Select a customer request" description="Review its current state, evidence readiness and next valid action without losing the queue." />}>{(ticket) => <PageStack>
          <Button size="lg" variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={selection.dismiss}>Back to tickets</Button>
          <div><StatusBadge kind="ticket" status={ticket.state} /><h2 class="mt-3 text-section">{ticket.title}</h2><p class="mt-2 text-interface text-ink-gray-7">Open the complete customer request, investigation artifacts, reviewable draft and exact publication approval.</p></div>
          <dl class="grid gap-4 border-y border-outline-gray-1 py-4 sm:grid-cols-2"><KeyValue label="Priority" value={<StatusBadge kind="severity" status={ticket.priority} />} orientation="vertical" /><KeyValue label="Evidence" value={ticket.evidenceReady ? "Draft evidence ready" : "Not ready"} orientation="vertical" /><KeyValue label="Created" value={<DateText value={ticket.createdAt} />} orientation="vertical" /><KeyValue label="Source version" value={ticket.sourceVersion} orientation="vertical" /></dl>
          <Alert theme="blue" variant="outline" title="Workflow does not publish" description="Running support analysis can prepare a draft. Customer publication still requires its exact approved effect and independent evidence." />
          <Button size="md" variant="solid" theme="blue" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpenTicket(ticket.id)}>Open casework</Button>
        </PageStack>}</Show>} />
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}

export function SreScreen(props: {
  incidents: IncidentSummary[];
  state: ScreenState<IncidentSummary[]>;
  onRefresh: () => void;
  onOpenIncident: (incidentId: string) => void;
  onDispatch: () => void;
  canDispatch: boolean;
}): JSX.Element {
  const [severity, setSeverity] = createSignal("all");
  const [page, setPage] = createSignal(1);
  const incidents = () => props.incidents.filter((incident) => severity() === "all" || incident.severity === severity()).sort((a, b) => {
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity] || Date.parse(b.observedAt) - Date.parse(a.observedAt);
  });
  const paged = () => {
    const current = clampPage(page(), incidents().length);
    return incidents().slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  };
  const selection = useMasterDetail(incidents, () => paged()[0]);
  const selected = selection.selected;
  return <BrainPage title="Incidents" description="Prioritize observed operational issues by severity and telemetry freshness; missing evidence never looks healthy."
    actions={<Show when={props.canDispatch}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Run SRE workflow</Button></Show>}>
    <PageStack>
      <FactStrip label="Incident queue summary" items={[
        { label: "Critical", value: String(props.incidents.filter((incident) => incident.severity === "critical").length), hint: "Critical observed incidents in this queue", icon: "lucide-siren" },
        { label: "Investigating", value: String(props.incidents.filter((incident) => incident.state === "investigating").length), hint: "Active investigation state", icon: "lucide-scan-search" },
        { label: "Stale observations", value: String(props.incidents.filter((incident) => !isFreshFromServer(incident.expiresAt, props.state.asOf)).length), hint: "Not current health evidence", icon: "lucide-clock-alert" },
      ]} />
      <FilterBar resultCount={incidents().length} selects={[{ label: "Severity", value: severity(), options: [{ value: "all", label: "All severities" }, { value: "critical", label: "Critical" }, { value: "warning", label: "Warning" }, { value: "info", label: "Info" }], onValueChange: (value) => { setSeverity(value ?? "all"); selection.reset(); setPage(1); } }]} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No incidents" emptyDescription="Open incidents appear when a monitored target breaches a declared threshold. This is not a claim of universal health." onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={48} minStartSize={34} maxStartSize={64} active={selection.picked() ? "end" : "start"} start={<WorkspaceSection title="Incident operations" description="Severity, target and observation validity stay together.">
          <Show when={incidents().length} fallback={<EmptyPreview icon="lucide-siren" title="No incidents in this view" description="Clear the severity filter to see every observed incident in the queue." />}>
            <div class="brain-queue"><For each={paged()}>{(incident) => {
              const fresh = isFreshFromServer(incident.expiresAt, props.state.asOf);
              return <QueueRow title={incident.title} description={`${incident.targetKey} · ${incident.state}`} icon="lucide-siren" tone={incident.severity === "critical" ? "red" : "amber"} eyebrow={`${incident.severity} · ${fresh ? "observed" : "stale observation"}`} meta={<><span>Observed <DateText value={incident.observedAt} /></span><span>Valid until <DateText value={incident.expiresAt} /></span></>} trailing={<StatusBadge kind="severity" status={incident.severity} />} selected={selected()?.id === incident.id} onClick={() => { if (window.matchMedia("(min-width: 1024px)").matches) selection.pick(incident.id); else props.onOpenIncident(incident.id); }} />;
            }}</For></div>
            <ListPager count={incidents().length} page={page()} onPageChange={setPage} label="Incident queue pagination" />
          </Show>
        </WorkspaceSection>} end={<Show when={selected()} keyed fallback={<EmptyPreview icon="lucide-siren" title="Select an incident" description="Review the observation, freshness and next safe action before opening the investigation." />}>{(incident) => <PageStack>
          <Button size="lg" variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={selection.dismiss}>Back to incidents</Button>
          <div><StatusBadge kind="severity" status={incident.severity} /><h2 class="mt-3 text-section">{incident.title}</h2><p class="mt-2 text-interface text-ink-gray-7">{incident.targetKey}</p></div>
          <Alert theme={isFreshFromServer(incident.expiresAt, props.state.asOf) ? "blue" : "amber"} variant="outline" title={isFreshFromServer(incident.expiresAt, props.state.asOf) ? "Observation window is valid" : "Telemetry is stale"} description={isFreshFromServer(incident.expiresAt, props.state.asOf) ? "Investigate the pinned evidence before proposing remediation." : "Do not render this target as healthy or remediate from an expired observation."} />
          <dl class="grid gap-4 border-y border-outline-gray-1 py-4 sm:grid-cols-2"><KeyValue label="First recorded" value={<DateText value={incident.createdAt} />} orientation="vertical" /><KeyValue label="Latest observation" value={<DateText value={incident.observedAt} />} orientation="vertical" /><KeyValue label="Current state" value={<StatusBadge kind="incident" status={incident.state} />} orientation="vertical" /><KeyValue label="Next safe action" value="Inspect the observation timeline" orientation="vertical" /></dl>
          <Button size="md" variant="solid" theme="blue" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpenIncident(incident.id)}>Open investigation</Button>
        </PageStack>}</Show>} />
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}

export function DeliveryScreen(props: {
  dossiers: DeliveryDossier[];
  state: ScreenState<DeliveryDossier[]>;
  onRefresh: () => void;
  onOpen: (dossierId: string) => void;
  onDecide: (cardId: string, note: string) => Promise<void>;
}): JSX.Element {
  const [page, setPage] = createSignal(1);
  const paged = () => {
    const current = clampPage(page(), props.dossiers.length);
    return props.dossiers.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  };
  const selection = useMasterDetail(() => props.dossiers, () => paged()[0]);
  const selected = selection.selected;
  return <BrainPage title="Delivery" description="Review release criteria, missing evidence and the business delivery decision without conflating effect approval.">
    <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No delivery dossiers" emptyDescription="Dossiers are created when a delivery release declares its rubric." onRetry={props.onRefresh}>
      <PaneLayout class="brain-list-detail" startSize={38} minStartSize={30} maxStartSize={55} active={selection.picked() ? "end" : "start"} start={<WorkspaceSection title="Release dossiers" description="Select a dossier to inspect its real readiness criteria.">
        <Show when={props.dossiers.length} fallback={<EmptyPreview icon="lucide-package-check" title="No release dossiers" description="Dossiers appear here when a delivery release declares its rubric." />}>
          <div class="brain-queue"><For each={paged()}>{(dossier) => {
            const passed = dossier.criteria.filter((criterion) => criterion.status === "passed").length;
            return <QueueRow title={dossier.id} description={`${passed} of ${dossier.criteria.length} criteria passed · ${dossier.evidence.length} evidence artifacts`} icon="lucide-package-check" tone={dossier.state === "verified" ? "green" : dossier.state === "rejected" ? "red" : "amber"} meta={<DateText value={dossier.updatedAt} />} trailing={<StatusBadge kind="evidence" status={dossier.state} />} selected={selected()?.id === dossier.id} onClick={() => selection.pick(dossier.id)} />;
          }}</For></div>
          <ListPager count={props.dossiers.length} page={page()} onPageChange={setPage} label="Release dossier pagination" />
        </Show>
      </WorkspaceSection>} end={<Show when={selected()} keyed fallback={<EmptyPreview icon="lucide-package-check" title="Select a release dossier" description="Its readiness criteria, evidence and business decision will appear here." />}>{(dossier) => <WorkspaceSection title="Readiness cockpit" description="Required checks and evidence for one substantial dossier.">
        <Button size="lg" variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={selection.dismiss}>Back to dossiers</Button>
        <div class="flex flex-wrap items-center gap-2"><StatusBadge kind="evidence" status={dossier.state} /><Badge variant="outline" theme="blue" label={`${dossier.criteria.filter((criterion) => criterion.status === "passed").length}/${dossier.criteria.length} criteria passed`} /></div>
        <div class="brain-queue"><For each={dossier.criteria}>{(criterion) => <div class="border-b border-outline-gray-1 py-3"><div class="flex flex-wrap items-center gap-2"><StatusBadge kind="check" status={criterion.status === "inconclusive" ? "missing" : criterion.status} /><strong class="break-words">{criterion.criterionId}</strong></div><p class="mt-1 break-words text-interface text-ink-gray-7">{criterion.detail}</p></div>}</For></div>
        <TechnicalDetails label="Source and rubric"><p class="break-all">Source {dossier.sourceRevision} · rubric {dossier.rubric.id} · {dossier.rubric.digest}</p></TechnicalDetails>
        <div class="flex flex-wrap gap-2"><Button size="lg" variant="outline" iconRight="lucide-arrow-right" onClick={() => props.onOpen(dossier.id)}>Inspect evidence dossier</Button><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-scale" onClick={() => void props.onDecide(dossier.id, `Accepted against delivery dossier ${dossier.id}`)}>Record Go decision</Button></div>
        <p class="text-caption text-ink-gray-6">A business Go decision does not approve any production effect. Deferred or NO-GO outcomes can be recorded from the decision register.</p>
      </WorkspaceSection>}</Show>} />
    </ScreenRegion>
  </BrainPage>;
}
