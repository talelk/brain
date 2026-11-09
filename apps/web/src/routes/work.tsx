import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button, KeyValue } from "@talelk/newui-atoms";
import { Alert, Pagination, EmptyState } from "@talelk/newui-molecules";
import { FilterBar } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import type { IncidentSummary, SLASummary, TicketSummary } from "@brain/contracts";
import { DateText, isFreshFromServer, ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { BrainPage, PageStack } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { formatSlaMinutes } from "../ui/format";
import { Freshness, QueueRow, WorkspaceSection } from "../ui/components/Domain";
import { PlainSummary } from "../ui/viz/PlainSummary";

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


type Slice = { label: string; count: number; tone: "red" | "amber" | "blue" | "gray" };
const TONE_TEXT = { red: "text-ink-red-8", amber: "text-ink-amber-8", blue: "text-ink-blue-8", gray: "text-ink-gray-5" } as const;
const TONE_BG = { red: "bg-surface-red-7", amber: "bg-surface-amber-6", blue: "bg-surface-blue-7", gray: "bg-surface-gray-5" } as const;

/** A donut of counts with a text legend, so nothing depends on colour; the img label carries the same figures. */
function Donut(props: { label: string; slices: Slice[] }): JSX.Element {
  const total = () => props.slices.reduce((sum, slice) => sum + slice.count, 0);
  const R = 15.9155;
  const arcs = () => { let offset = 0; return props.slices.filter((slice) => slice.count > 0).map((slice) => { const length = (slice.count / total()) * 100; const arc = { slice, length, offset }; offset += length; return arc; }); };
  return <div class="flex items-center gap-4">
    <svg viewBox="0 0 36 36" class="size-24 shrink-0 -rotate-90" role="img" aria-label={`${props.label}: ${props.slices.map((slice) => `${slice.count} ${slice.label.toLowerCase()}`).join(", ")}`}>
      <circle cx="18" cy="18" r={R} fill="none" stroke="currentColor" stroke-width="4" class="text-surface-gray-3" />
      <For each={arcs()}>{(arc) => <circle cx="18" cy="18" r={R} fill="none" stroke="currentColor" stroke-width="4" class={TONE_TEXT[arc.slice.tone]} stroke-dasharray={`${arc.length} ${100 - arc.length}`} stroke-dashoffset={-arc.offset} />}</For>
    </svg>
    <ul class="flex flex-col gap-1 text-caption text-ink-gray-7" aria-hidden="true"><For each={props.slices}>{(slice) => <li class="inline-flex items-center gap-2"><span class={`size-2 rounded-full ${TONE_BG[slice.tone]}`} />{slice.label} {slice.count}</li>}</For></ul>
  </div>;
}

/** Horizontal bars: one labelled row per bucket with its count printed. */
function Bars(props: { label: string; rows: Slice[] }): JSX.Element {
  const max = () => Math.max(1, ...props.rows.map((row) => row.count));
  return <ul class="flex flex-col gap-1.5" aria-label={props.label}><For each={props.rows}>{(row) => <li class="grid grid-cols-[6rem_1fr_2rem] items-center gap-2 text-caption text-ink-gray-7">
    <span>{row.label}</span><span class="h-2 overflow-hidden rounded-full bg-surface-gray-3"><span class={`block h-full ${TONE_BG[row.tone]}`} style={{ width: `${(row.count / max()) * 100}%` }} /></span><span class="text-right tabular-nums">{row.count}</span></li>}</For></ul>;
}

const DAY = 86_400_000;
/** Age of open items in four buckets, measured to the server's as-of time. */
function ageBuckets(created: string[], asOf: string | undefined): Slice[] {
  const now = asOf ? Date.parse(asOf) : Date.now();
  const days = created.map((value) => (now - Date.parse(value)) / DAY);
  return [
    { label: "Under 1 day", count: days.filter((d) => d < 1).length, tone: "blue" },
    { label: "1 to 3 days", count: days.filter((d) => d >= 1 && d < 3).length, tone: "blue" },
    { label: "3 to 7 days", count: days.filter((d) => d >= 3 && d < 7).length, tone: "amber" },
    { label: "Over 7 days", count: days.filter((d) => d >= 7).length, tone: "red" },
  ];
}

function Rate(props: { label: string; met: number; total: number }): JSX.Element {
  const pct = () => props.total > 0 ? Math.round((props.met / props.total) * 100) : 0;
  return <div class="flex flex-col gap-1">
    <div class="flex items-baseline justify-between text-interface"><span class="text-ink-gray-8">{props.label}</span><span class="text-base-medium text-ink-gray-9">{props.total > 0 ? `${pct()}%` : "No samples"}</span></div>
    <div role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct()} aria-valuetext={`${props.met} of ${props.total} met`} class="h-2.5 overflow-hidden rounded-full bg-surface-gray-3"><span class={`block h-full ${pct() >= 90 ? "bg-surface-green-7" : pct() >= 70 ? "bg-surface-amber-6" : "bg-surface-red-7"}`} style={{ width: `${pct()}%` }} /></div>
    <span class="text-caption text-ink-gray-6">{props.met} of {props.total} met</span>
  </div>;
}

/** SLA gauge for the month: how often response and resolution targets were met and how long each side waited. */
function SlaGauge(props: { sla: SLASummary }): JSX.Element {
  return <WorkspaceSection title="Service levels this month" description="Targets met out of the tickets measured. Incomplete records are left out rather than guessed.">
    <div class="grid gap-4 md:grid-cols-2"><Rate label="First response on time" met={props.sla.responseMet} total={props.sla.sampleCount} /><Rate label="Resolved on time" met={props.sla.resolutionMet} total={props.sla.sampleCount} /></div>
    <dl class="mt-3 grid gap-3 border-t border-outline-gray-1 pt-3 sm:grid-cols-4">
      <KeyValue label="Keyrus wait" value={formatSlaMinutes(props.sla.keyrusMs)} orientation="vertical" />
      <KeyValue label="Client wait" value={formatSlaMinutes(props.sla.clientWaitMs)} orientation="vertical" />
      <KeyValue label="Hub wait" value={formatSlaMinutes(props.sla.hubWaitMs)} orientation="vertical" />
      <KeyValue label="Incomplete records" value={String(props.sla.incompleteRecords)} orientation="vertical" />
    </dl>
  </WorkspaceSection>;
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
  const openTickets = () => props.tickets.filter((ticket) => ticket.state === "open");
  const urgentCount = () => openTickets().filter((t) => t.priority === "urgent" || t.priority === "high").length;
  const selection = useMasterDetail(rows, () => paged()[0]);
  const selected = selection.selected;
  return <BrainPage title="Support" description="Triage customer requests by urgency and review readiness; drafts never publish themselves."
    actions={<div class="flex flex-wrap gap-2"><Button variant="outline" iconLeft="lucide-monitor" href="/tv/support">Open on a wall display</Button><Show when={props.canDispatch}><Button variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Start a support task</Button></Show></div>}>
    <PageStack>
      <Show when={props.tickets.length}><PlainSummary icon="lucide-headset">{openTickets().length ? `${openTickets().length} open ${openTickets().length === 1 ? "request" : "requests"}, ${urgentCount()} urgent or high. Drafts never publish themselves.` : "No open customer requests."}</PlainSummary></Show>
      <Show when={openTickets().length}><div class="grid gap-4 md:grid-cols-2">
        <WorkspaceSection title="Open by priority"><Donut label="Open tickets by priority" slices={[
          { label: "Urgent", count: openTickets().filter((t) => t.priority === "urgent").length, tone: "red" }, { label: "High", count: openTickets().filter((t) => t.priority === "high").length, tone: "amber" },
          { label: "Normal", count: openTickets().filter((t) => t.priority === "normal").length, tone: "blue" }, { label: "Low", count: openTickets().filter((t) => t.priority === "low").length, tone: "gray" }]} /></WorkspaceSection>
        <WorkspaceSection title="How long they have waited"><Bars label="Open tickets by age" rows={ageBuckets(openTickets().map((t) => t.createdAt), props.state.asOf)} /></WorkspaceSection>
      </div></Show>
      <Show when={props.sla} keyed>{(sla) => <SlaGauge sla={sla} />}</Show>
      <FilterBar query={{ value: query(), placeholder: "Search customer issue, priority, or ticket…", onInput: (value) => { setQuery(value); setPage(1); } }} resultCount={rows().length} tabs={{ label: "Ticket state", value: view(), options: [{ value: "open", label: "Open" }, { value: "pending", label: "Awaiting" }, { value: "resolved", label: "Resolved" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }], onValueChange: (value) => { setView(value); selection.reset(); setPage(1); } }} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No support tickets" emptyDescription="Connect the ticket connector and sync to see the queue." onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={48} minStartSize={34} maxStartSize={64} active={selection.picked() ? "end" : "start"} start={<WorkspaceSection title="Support triage" description="Priority and evidence readiness are visible before opening the casework page.">
          <Show when={rows().length} fallback={<EmptyState size="sm" icon="lucide-headset" title="No tickets in this view" description="Choose another state or clear the search to see other customer requests." />}>
            <div class="brain-queue"><For each={paged()}>{(ticket) => <QueueRow title={ticket.title} description={`${ticket.priority} priority · ${ticket.evidenceReady ? "Draft evidence ready" : "Investigation or evidence pending"}`} icon="lucide-headset" tone={ticket.priority === "urgent" ? "red" : ticket.priority === "high" ? "amber" : "blue"} eyebrow={ticket.state} meta={<><span>Created <DateText value={ticket.createdAt} /></span><Freshness value={ticket.updatedAt} /></>} trailing={<StatusBadge kind="ticket" status={ticket.state} />} selected={selected()?.id === ticket.id} onClick={() => { if (window.matchMedia("(min-width: 1024px)").matches) selection.pick(ticket.id); else props.onOpenTicket(ticket.id); }} />}</For></div>
            <ListPager count={rows().length} page={page()} onPageChange={setPage} label="Support triage pagination" />
          </Show>
        </WorkspaceSection>} end={<Show when={selected()} keyed fallback={<EmptyState size="sm" icon="lucide-headset" title="Select a customer request" description="Review its current state, evidence readiness and next valid action without losing the queue." />}>{(ticket) => <PageStack>
          <Button variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={selection.dismiss}>Back to tickets</Button>
          <div><StatusBadge kind="ticket" status={ticket.state} /><h2 class="mt-3 text-section">{ticket.title}</h2><p class="mt-2 text-interface text-ink-gray-7">Open the complete customer request, investigation artifacts, reviewable draft and exact publication approval.</p></div>
          <dl class="grid gap-3 border-y border-outline-gray-1 py-3 sm:grid-cols-2"><KeyValue label="Priority" value={<StatusBadge kind="severity" status={ticket.priority} />} orientation="vertical" /><KeyValue label="Evidence" value={ticket.evidenceReady ? "Draft evidence ready" : "Not ready"} orientation="vertical" /><KeyValue label="Created" value={<DateText value={ticket.createdAt} />} orientation="vertical" /><KeyValue label="Source version" value={ticket.sourceVersion} orientation="vertical" /></dl>
          <Alert theme="blue" variant="outline" title="Workflow does not publish" description="Running support analysis can prepare a draft. Customer publication still requires its exact approved effect and independent evidence." />
          <Button variant="solid" theme="blue" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpenTicket(ticket.id)}>Open casework</Button>
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
  const criticalCount = () => props.incidents.filter((incident) => incident.severity === "critical").length;
  const staleCount = () => props.incidents.filter((incident) => !isFreshFromServer(incident.expiresAt, props.state.asOf)).length;
  const selection = useMasterDetail(incidents, () => paged()[0]);
  const selected = selection.selected;
  return <BrainPage title="Incidents" description="Prioritize observed operational issues by severity and telemetry freshness; missing evidence never looks healthy."
    actions={<div class="flex flex-wrap gap-2"><Button variant="outline" iconLeft="lucide-monitor" href="/tv/sre">Open on a wall display</Button><Show when={props.canDispatch}><Button variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Start an incident task</Button></Show></div>}>
    <PageStack>
      <Show when={props.incidents.length}><PlainSummary icon="lucide-siren">{`${criticalCount()} critical of ${props.incidents.length} ${props.incidents.length === 1 ? "incident" : "incidents"}; ${staleCount()} ${staleCount() === 1 ? "observation is" : "observations are"} stale and not current health evidence.`}</PlainSummary></Show>
      <Show when={props.incidents.length}><div class="grid gap-4 md:grid-cols-2">
        <WorkspaceSection title="By severity"><Donut label="Incidents by severity" slices={[
          { label: "Critical", count: criticalCount(), tone: "red" }, { label: "Warning", count: props.incidents.filter((i) => i.severity === "warning").length, tone: "amber" }, { label: "Info", count: props.incidents.filter((i) => i.severity === "info").length, tone: "blue" }]} /></WorkspaceSection>
        <WorkspaceSection title="How long they have been open"><Bars label="Incidents by age" rows={ageBuckets(props.incidents.map((i) => i.createdAt), props.state.asOf)} /></WorkspaceSection>
      </div></Show>
      <FilterBar resultCount={incidents().length} selects={[{ label: "Severity", value: severity(), options: [{ value: "all", label: "All severities" }, { value: "critical", label: "Critical" }, { value: "warning", label: "Warning" }, { value: "info", label: "Info" }], onValueChange: (value) => { setSeverity(value ?? "all"); selection.reset(); setPage(1); } }]} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No incidents" emptyDescription="Open incidents appear when a monitored target breaches a declared threshold. This is not a claim of universal health." onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={48} minStartSize={34} maxStartSize={64} active={selection.picked() ? "end" : "start"} start={<WorkspaceSection title="Incident operations" description="Severity, target and observation validity stay together.">
          <Show when={incidents().length} fallback={<EmptyState size="sm" icon="lucide-siren" title="No incidents in this view" description="Clear the severity filter to see every observed incident in the queue." />}>
            <div class="brain-queue"><For each={paged()}>{(incident) => {
              const fresh = isFreshFromServer(incident.expiresAt, props.state.asOf);
              return <QueueRow title={incident.title} description={`${incident.targetKey} · ${incident.state}`} icon="lucide-siren" tone={incident.severity === "critical" ? "red" : "amber"} eyebrow={`${incident.severity} · ${fresh ? "observed" : "stale observation"}`} meta={<><span>Observed <DateText value={incident.observedAt} /></span><span>Valid until <DateText value={incident.expiresAt} /></span></>} trailing={<StatusBadge kind="severity" status={incident.severity} />} selected={selected()?.id === incident.id} onClick={() => { if (window.matchMedia("(min-width: 1024px)").matches) selection.pick(incident.id); else props.onOpenIncident(incident.id); }} />;
            }}</For></div>
            <ListPager count={incidents().length} page={page()} onPageChange={setPage} label="Incident queue pagination" />
          </Show>
        </WorkspaceSection>} end={<Show when={selected()} keyed fallback={<EmptyState size="sm" icon="lucide-siren" title="Select an incident" description="Review the observation, freshness and next safe action before opening the investigation." />}>{(incident) => <PageStack>
          <Button variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={selection.dismiss}>Back to incidents</Button>
          <div><StatusBadge kind="severity" status={incident.severity} /><h2 class="mt-3 text-section">{incident.title}</h2><p class="mt-2 text-interface text-ink-gray-7">{incident.targetKey}</p></div>
          <Alert theme={isFreshFromServer(incident.expiresAt, props.state.asOf) ? "blue" : "amber"} variant="outline" title={isFreshFromServer(incident.expiresAt, props.state.asOf) ? "Observation window is valid" : "Telemetry is stale"} description={isFreshFromServer(incident.expiresAt, props.state.asOf) ? "Investigate the pinned evidence before proposing remediation." : "Do not render this target as healthy or remediate from an expired observation."} />
          <dl class="grid gap-3 border-y border-outline-gray-1 py-3 sm:grid-cols-2"><KeyValue label="First recorded" value={<DateText value={incident.createdAt} />} orientation="vertical" /><KeyValue label="Latest observation" value={<DateText value={incident.observedAt} />} orientation="vertical" /><KeyValue label="Current state" value={<StatusBadge kind="incident" status={incident.state} />} orientation="vertical" /><KeyValue label="Next safe action" value="Inspect the observation timeline" orientation="vertical" /></dl>
          <Button variant="solid" theme="blue" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpenIncident(incident.id)}>Open investigation</Button>
        </PageStack>}</Show>} />
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
