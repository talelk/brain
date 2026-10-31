import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, Progress, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, TabButtons } from "@talelk/newui-molecules";
import { DataTable, FilterBar, Section, StatGrid } from "@talelk/newui-organisms";
import type { DataTableColumn } from "@talelk/newui-organisms";
import type { DecisionHistoryEntry, DeliveryDossier, IncidentSummary, SLASummary, TicketSummary,
} from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";

import { BrainPage, PageStack } from "../ui/components/PageLayout";
import { StatusBadge, statusTheme } from "../ui/components/StatusBadge";
import { count, formatDateTime, formatSlaMinutes } from "../ui/format";
import { CardTile } from "../ui/components/primitives";


type Decision = "go" | "no" | "not-now" | "need-more-data";

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
  const actorName = (actorId: string) => actorId === props.viewerId ? props.viewerName ?? actorId : actorId;
  async function record() {
    if (!cardId().trim() || !note().trim() || !decision()) return;
    setError("");
    try {
      await props.onRecord(cardId().trim(), decision() as Decision, note().trim());
      setCardId(""); setDecision(""); setNote(""); setOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The decision was refused."); }
  }
  return <BrainPage title="Decisions" description="Keep the exact decision, its author, and the reasoning that moved the work forward."
    actions={<Button size="lg" variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setOpen(true)}>Record decision</Button>}>
    <Section title="Decision history" description={count(props.decisions.length, "decision")} surface="card">
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No recorded decisions yet"
        emptyDescription="Record the go/no-go decision for a card when you make it." onRetry={props.onRefresh}>
        <DataTable title="Decisions" selectable={false} hideSearch cardBreakpoint="lg" rows={props.decisions.map((entry) => ({
          id: entry.id, actor: actorName(entry.actorId), decision: entry.decision, note: entry.note, at: formatDateTime(entry.createdAt), card: entry.cardId,
        }))} columns={[
          { id: "card", header: "Card", accessorKey: "card", meta: { mobile: "subtitle" } },
          { id: "actor", header: "Decided by", accessorKey: "actor", meta: { mobile: "meta" } },
          { id: "decision", header: "Decision", accessorKey: "decision", meta: { mobile: "status" }, cell: (context) => <StatusBadge kind="decision" status={context.row.original.decision} /> },
          { id: "note", header: "Note", accessorKey: "note", meta: { mobile: "title" } },
          { id: "at", header: "At", accessorKey: "at", meta: { mobile: "meta" } },
        ]} />
      </ScreenRegion>
      <Dialog.Root open={open()} onOpenChange={setOpen}><Dialog.Content size="md">
        <Dialog.Header><Dialog.Title>Record a decision</Dialog.Title><Dialog.Description>The note is stored verbatim and cannot be treated as a paraphrase.</Dialog.Description></Dialog.Header>
        <div class="my-4 flex flex-col gap-4">
          <TextInput label="Card id" value={cardId()} onInput={(event) => setCardId(event.currentTarget.value)} description={props.cardIds.length ? `Known cards: ${props.cardIds.slice(0, 4).join(", ")}` : undefined} />
          <TabButtons label="Decision" options={[{ value: "go", label: "Go" }, { value: "no", label: "No" }, { value: "not-now", label: "Not now" }, { value: "need-more-data", label: "Need more data" }]} value={decision()} onValueChange={(value) => setDecision(value as Decision | "")} />
          <Textarea label="Note" value={note()} onInput={(event) => setNote(event.currentTarget.value)} />
          <Show when={error()}><Alert theme="red" variant="outline" title="Decision refused" description={error()} /></Show>
        </div>
        <Dialog.Footer class="justify-end"><Button size="lg" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button size="lg" variant="solid" theme="blue" disabled={!cardId().trim() || !note().trim() || !decision()} onClick={() => void record()}>Record decision</Button></Dialog.Footer>
      </Dialog.Content></Dialog.Root>
    </Section>
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
  const rows = () => props.tickets.filter((ticket) => `${ticket.id} ${ticket.title}`.toLowerCase().includes(query().toLowerCase()));
  const columns: DataTableColumn<TicketSummary>[] = [
    { id: "title", header: "Ticket", accessorKey: "title", meta: { mobile: "title" }, cell: (context) => <button type="button" class="rounded-control text-start font-medium text-ink-blue-link focus-visible:focus-ring" onClick={() => props.onOpenTicket(context.row.original.id)}>{context.row.original.title}<span class="mt-1 block text-caption font-normal text-ink-gray-6">{context.row.original.id}</span></button> },
    { id: "state", header: "State", accessorKey: "state", meta: { mobile: "status" }, cell: (context) => <StatusBadge kind="ticket" status={context.row.original.state} /> },
    { id: "priority", header: "Priority", accessorKey: "priority", meta: { mobile: "meta" } },
    { id: "evidence", header: "Draft evidence", accessorFn: (row) => row.evidenceReady ? "Ready" : "Not yet", meta: { mobile: "meta" }, cell: (context) => <Badge variant="outline" theme={statusTheme("check", context.row.original.evidenceReady ? "passed" : "missing")} label={context.row.original.evidenceReady ? "Ready" : "Not yet"} /> },
    { id: "updatedAt", header: "Updated", accessorFn: (row) => formatDateTime(row.updatedAt), meta: { mobile: "subtitle" } },
    { id: "open", header: "", enableSorting: false, meta: { mobile: "meta" }, cell: (context) => <Button variant="outline" size="sm" onClick={() => props.onOpenTicket(context.row.original.id)}>Details</Button> },
  ];
  return <BrainPage title="Support" description="Prioritize customer requests and review drafts; nothing reaches a customer without exact approval."
    actions={<Show when={props.canDispatch}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Run support workflow</Button></Show>}>
    <PageStack>
      <Show when={props.sla} keyed>{(sla) => <StatGrid compact columns={3} stats={[
        { label: "Keyrus response time", value: formatSlaMinutes(sla.keyrusMs), hint: "Measured response window", icon: "lucide-timer" },
        { label: "Client wait", value: formatSlaMinutes(sla.clientWaitMs), hint: "Time waiting on the client", icon: "lucide-clock" },
        { label: "Samples", value: String(sla.sampleCount), hint: "Requests in this summary", icon: "lucide-chart-no-axes-column" },
      ]} />}</Show>
      <FilterBar query={{ value: query(), placeholder: "Find a ticket…", onInput: setQuery }} resultCount={rows().length}
        chips={query() ? [{ label: `Search: ${query()}`, onRemove: () => setQuery("") }] : []} onClearAll={query() ? () => setQuery("") : undefined} />
      <Section title="Support queue" description="Draft evidence is visible before review; publication remains approval-gated." surface="card">
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No support tickets" emptyDescription="Connect the ticket connector and sync to see the queue." onRetry={props.onRefresh}>
          <DataTable title="Tickets" selectable={false} hideSearch cardBreakpoint="lg" rows={rows()} columns={columns} emptyTitle="No tickets match" emptyHint="Clear the search to see the complete queue." onClearFilters={() => setQuery("")} />
        </ScreenRegion>
      </Section>
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
  const now = Date.now();
  return <BrainPage title="Incidents" description="Review current observations and their expiry before considering any approval-gated remediation."
    actions={<Show when={props.canDispatch}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Run SRE workflow</Button></Show>}>
    <Section title="Incident queue" description="A remediation proposal stays inert until its exact tool path is approved." surface="card">
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No incidents" emptyDescription="Open incidents appear when a monitored target breaches a declared threshold." onRetry={props.onRefresh}>
        <div class="divide-y divide-outline-gray-1 brain-row-list">
          <For each={props.incidents}>{(incident) => <article class="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
            <div class="min-w-0"><h3 class="text-base-medium text-ink-gray-9">{incident.title}</h3><p class="mt-1 text-caption text-ink-gray-6">{incident.targetKey} · observed <DateText value={incident.observedAt} /> · expires <DateText value={incident.expiresAt} /></p></div>
            <div class="flex flex-wrap gap-2"><StatusBadge kind="severity" status={incident.severity} /><Show when={incident.expiresAt && Date.parse(incident.expiresAt) < now}><Badge theme="amber" label="Observation stale" /></Show></div>
            <Button size="lg" variant="outline" iconRight="lucide-arrow-right" onClick={() => props.onOpenIncident(incident.id)}>Open incident</Button>
          </article>}</For>
        </div>
      </ScreenRegion>
    </Section>
  </BrainPage>;
}

export function DeliveryScreen(props: {
  dossiers: DeliveryDossier[];
  state: ScreenState<DeliveryDossier[]>;
  onRefresh: () => void;
  onOpen: (dossierId: string) => void;
  onDecide: (cardId: string, note: string) => Promise<void>;
}): JSX.Element {
  return <BrainPage title="Delivery" description="Inspect release dossiers where every criterion is backed by accepted evidence.">
    <Section title="Delivery dossiers" description="Inconclusive evidence stays inconclusive; it never becomes a pass." surface="card">
      <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No delivery dossiers" emptyDescription="Dossiers are created when a delivery release declares its rubric." onRetry={props.onRefresh}>
        <div class="brain-field-grid">
          <For each={props.dossiers}>{(dossier) => {
            const passed = () => dossier.criteria.filter((criterion) => criterion.status === "passed").length;
            return <CardTile class="flex flex-col gap-4">
              <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 class="break-all text-base-medium text-ink-gray-9">{dossier.id}</h3><p class="mt-1 text-caption text-ink-gray-6">Source {dossier.sourceRevision} · updated <DateText value={dossier.updatedAt} /></p></div><StatusBadge kind="evidence" status={dossier.state} /></div>
              <div><div class="mb-2 flex justify-between text-caption text-ink-gray-7"><span>Accepted criteria</span><span class="tabular-nums">{passed()}/{dossier.criteria.length}</span></div><Progress label="Accepted criteria" value={dossier.criteria.length ? passed() / dossier.criteria.length * 100 : 0} /></div>
              <div class="flex flex-wrap gap-1"><For each={dossier.criteria}>{(criterion) => <Badge variant="outline" theme={statusTheme("check", criterion.status === "inconclusive" ? "missing" : criterion.status)} label={criterion.criterionId} />}</For></div>
              <Button size="lg" variant="outline" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpen(dossier.id)}>Inspect dossier</Button>
            </CardTile>;
          }}</For>
        </div>
      </ScreenRegion>
    </Section>
  </BrainPage>;
}
