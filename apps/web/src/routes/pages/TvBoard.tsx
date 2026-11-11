import { For, Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "@talelk/newui-atoms";
import type { IncidentSummary, SLASummary, TicketSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import type { ScreenState } from "../../data/screens";
import { GovernorError } from "../../data/client";
import { incidentsQuery, slaQuery, ticketsQuery } from "../../data/governor";
import { isFreshFromServer, ScreenRegion } from "../../ui/screen-region";
import { ThemeToggle } from "../../ui/components/ThemeToggle";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { StatusIcon } from "../../ui/viz/StatusIcon";
import { formatDateTime, formatRelative, formatSlaMinutes } from "../../ui/format";
import { monthPeriod } from "./helpers";

type Tone = "red" | "amber" | "blue" | "green" | "gray";
const FILL: Record<Tone, string> = { red: "var(--surface-red-7)", amber: "var(--surface-amber-6)", blue: "var(--surface-blue-9)", green: "var(--surface-green-7)", gray: "var(--surface-gray-5)" };
const EDGE: Record<Tone, string> = { red: "border-s-outline-red-5", amber: "border-s-outline-amber-5", blue: "border-s-outline-blue-5", green: "border-s-outline-green-5", gray: "border-s-outline-gray-3" };
const TONE_ICON: Record<Tone, string> = { red: "lucide-octagon-alert", amber: "lucide-triangle-alert", blue: "lucide-info", green: "lucide-circle-check", gray: "lucide-circle" };

interface Slice { label: string; value: number; tone: Tone }

/** Re-reads the clock so "x min ago" keeps moving between 20 s data refreshes. */
function useTick(ms = 15_000): () => number {
  const [now, setNow] = createSignal(Date.now());
  const id = setInterval(() => setNow(Date.now()), ms);
  onCleanup(() => clearInterval(id));
  return now;
}

function connectionLabel(state: ScreenState<unknown>): { label: string; theme: "green" | "amber" | "red" | "gray" } {
  if (state.status === "ready" || state.status === "empty-authorized") return { label: "Live authorized data", theme: "green" };
  if (state.status === "loading") return { label: "Connecting", theme: "gray" };
  if (state.status === "partial-failure" || state.status === "stale") return { label: "Partial or stale data", theme: "amber" };
  return { label: "Connection unavailable", theme: "red" };
}

function KioskHeader(props: { area: "support" | "sre"; state: ScreenState<unknown>; asOf?: string }): JSX.Element {
  const now = useTick();
  const connection = () => connectionLabel(props.state);
  const ago = () => { now(); return formatRelative(props.asOf); };
  return <header class="flex flex-wrap items-center justify-between gap-5 border-b-2 border-outline-gray-2 pb-5">
    <div class="flex items-center gap-4">
      <span class="grid size-14 place-items-center rounded-card bg-surface-blue-9 text-heading font-semibold text-white" aria-hidden="true">B</span>
      <div><h1 class="text-[clamp(1.75rem,2.2vw,2.75rem)] font-semibold leading-tight tracking-tight">Keyrus Brain <span class="text-ink-gray-6">/ {props.area === "support" ? "Support" : "SRE"}</span></h1>
        <p class="mt-1 text-base text-ink-gray-6 md:text-lg">Read-only redacted operations wallboard</p></div>
    </div>
    <div class="flex flex-wrap items-center gap-4">
      <div class="text-end"><Badge size="lg" theme={connection().theme} label={connection().label} />
        <p class="mt-2 text-sm text-ink-gray-6 md:text-base">Last authorized update <strong class="tabular-nums text-ink-gray-9" title={props.asOf ? `Absolute time: ${props.asOf}` : undefined}>{ago()}</strong></p></div>
      <ThemeToggle />
    </div>
  </header>;
}

/** One big reading. The icon and the hint carry the severity so colour is never the only signal. */
function Tile(props: { label: string; value: string; hint: string; tone: Tone }): JSX.Element {
  return <div class={`rounded-card border-s-8 bg-surface-elevation-1 p-5 2xl:p-6 ${EDGE[props.tone]}`}>
    <p class="flex items-center gap-2 text-base text-ink-gray-7 2xl:text-xl"><span class={`${TONE_ICON[props.tone]} size-5`} aria-hidden="true" />{props.label}</p>
    <p class="mt-1 text-[clamp(3rem,5vw,5.5rem)] font-semibold leading-none tabular-nums tracking-tight">{props.value}</p>
    <p class="mt-2 text-sm text-ink-gray-6 2xl:text-lg">{props.hint}</p>
  </div>;
}

function Panel(props: { title: string; hint?: string; children: JSX.Element }): JSX.Element {
  return <section aria-label={props.title} class="rounded-card border border-outline-gray-2 bg-surface-elevation-1 p-5 2xl:p-6">
    <h2 class="text-xl font-semibold 2xl:text-2xl">{props.title}</h2>
    <Show when={props.hint}><p class="mt-1 text-sm text-ink-gray-6 2xl:text-base">{props.hint}</p></Show>
    <div class="mt-4">{props.children}</div>
  </section>;
}

/** Inline-SVG donut with a text legend (icon, label, count); role="img" repeats the counts. */
function Donut(props: { slices: Slice[]; centre: string; caption: string; label: string }): JSX.Element {
  const total = () => props.slices.reduce((sum, slice) => sum + slice.value, 0);
  const R = 52, C = 2 * Math.PI * R;
  const arcs = () => { let offset = 0; return props.slices.filter((s) => s.value > 0).map((s) => { const len = (s.value / total()) * C; const arc = { ...s, len, offset }; offset += len; return arc; }); };
  const summary = () => `${props.label}: ${props.slices.map((s) => `${s.value} ${s.label.toLowerCase()}`).join(", ")}`;
  return <div class="flex flex-wrap items-center gap-6">
    <div class="relative size-40 shrink-0 2xl:size-48">
      <svg viewBox="0 0 120 120" role="img" aria-label={summary()} class="size-full -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" stroke="var(--surface-gray-3)" stroke-width="14" />
        <For each={arcs()}>{(arc) => <circle cx="60" cy="60" r={R} fill="none" stroke={FILL[arc.tone]} stroke-width="14" stroke-dasharray={`${arc.len} ${C - arc.len}`} stroke-dashoffset={-arc.offset} />}</For>
      </svg>
      <div class="absolute inset-0 grid place-content-center text-center" aria-hidden="true"><p class="text-5xl font-semibold tabular-nums leading-none">{props.centre}</p><p class="mt-1 text-sm text-ink-gray-6">{props.caption}</p></div>
    </div>
    <ul class="flex min-w-0 flex-1 flex-col gap-2 text-lg 2xl:text-xl" aria-hidden="true">
      <For each={props.slices}>{(slice) => <li class="flex items-center gap-2"><span class={`${TONE_ICON[slice.tone]} size-5`} style={{ color: FILL[slice.tone] }} />{slice.label}<span class="ms-auto font-semibold tabular-nums">{slice.value}</span></li>}</For>
    </ul>
  </div>;
}

/** Horizontal bars for the age of open items; the oldest buckets take the warmer tones. */
function AgeBars(props: { buckets: Slice[]; label: string }): JSX.Element {
  const max = () => Math.max(1, ...props.buckets.map((b) => b.value));
  const summary = () => `${props.label}: ${props.buckets.map((b) => `${b.value} ${b.label}`).join(", ")}`;
  return <ul role="img" aria-label={summary()} class="flex flex-col gap-3">
    <For each={props.buckets}>{(bucket) => <li class="grid grid-cols-[8rem_1fr_3rem] items-center gap-3 text-lg 2xl:text-xl" aria-hidden="true">
      <span class="text-ink-gray-7">{bucket.label}</span>
      <span class="h-5 rounded-full bg-surface-gray-3"><span class="block h-full rounded-full" style={{ width: `${(bucket.value / max()) * 100}%`, "min-width": bucket.value ? "0.25rem" : "0", background: FILL[bucket.tone] }} /></span>
      <span class="text-end font-semibold tabular-nums">{bucket.value}</span>
    </li>}</For>
  </ul>;
}

function bucketize(stamps: number[], now: number, edges: { label: string; maxMs: number; tone: Tone }[]): Slice[] {
  const counts = edges.map(() => 0);
  for (const stamp of stamps) { const age = Math.max(0, now - stamp); const index = edges.findIndex((edge) => age < edge.maxMs); counts[index < 0 ? edges.length - 1 : index]! += 1; }
  return edges.map((edge, i) => ({ label: edge.label, value: counts[i]!, tone: edge.tone }));
}
const HOUR = 3_600_000, DAY = 24 * HOUR;

const PRIORITY: Record<TicketSummary["priority"], { tone: Tone; label: string }> = { urgent: { tone: "red", label: "Urgent" }, high: { tone: "amber", label: "High" }, normal: { tone: "blue", label: "Normal" }, low: { tone: "gray", label: "Low" } };

function SupportBoard(props: { tickets: TicketSummary[]; sla?: SLASummary; asOf?: string; state: ScreenState<unknown>; onRetry: () => void }): JSX.Element {
  const urgent = () => props.tickets.filter((t) => t.priority === "urgent" || t.priority === "high").length;
  const pending = () => props.tickets.filter((t) => !t.evidenceReady).length;
  const slaPct = () => { const sla = props.sla; return sla && sla.sampleCount > 0 ? Math.round(((sla.responseMet + sla.resolutionMet) / (2 * sla.sampleCount)) * 100) : undefined; };
  const now = () => Date.parse(props.asOf ?? "") || Date.now();
  const mix = (): Slice[] => (["urgent", "high", "normal", "low"] as const).map((p) => ({ label: PRIORITY[p].label, value: props.tickets.filter((t) => t.priority === p).length, tone: PRIORITY[p].tone }));
  const age = () => bucketize(props.tickets.map((t) => Date.parse(t.createdAt)), now(), [
    { label: "Under 1 day", maxMs: DAY, tone: "green" }, { label: "1 to 3 days", maxMs: 3 * DAY, tone: "blue" }, { label: "3 to 7 days", maxMs: 7 * DAY, tone: "amber" }, { label: "Over 7 days", maxMs: Infinity, tone: "red" }]);
  const rows = () => props.tickets.slice(0, 8);
  return <>
    <div class="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
      <Tile label="Urgent or high priority" value={String(urgent())} hint="Open exceptions in the authorized queue" tone={props.tickets.some((t) => t.priority === "urgent") ? "red" : urgent() ? "amber" : "green"} />
      <Tile label="Awaiting review evidence" value={String(pending())} hint="Drafts not ready for publication review" tone={pending() ? "blue" : "green"} />
      <Tile label="SLA met" value={slaPct() === undefined ? "n/a" : `${slaPct()}%`} hint={props.sla && props.sla.sampleCount > 0 ? `${props.sla.sampleCount} measured this month, response ${formatSlaMinutes(props.sla.keyrusMs)}` : props.sla ? "No measured samples this month" : "SLA summary unavailable"} tone={slaPct() === undefined ? "gray" : slaPct()! >= 90 ? "green" : slaPct()! >= 70 ? "amber" : "red"} />
      <Tile label="Open exceptions" value={String(props.tickets.length)} hint="Tickets in the authorized queue" tone="gray" />
    </div>
    <div class="grid items-start gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div class="grid gap-4">
        <Panel title="Priority mix" hint="Open tickets by priority"><Donut slices={mix()} centre={String(props.tickets.length)} caption="open" label="Priority mix" /></Panel>
        <Panel title="Age of open tickets" hint="Time since each ticket was created"><AgeBars buckets={age()} label="Age of open tickets" /></Panel>
      </div>
      <section aria-label="Support exception queue" class="min-w-0">
        <h2 class="text-2xl font-semibold 2xl:text-3xl">Support exceptions</h2>
        <p class="mb-4 mt-1 text-base text-ink-gray-6 2xl:text-lg">Priority, state and draft evidence. Customer bodies never appear on the wallboard.</p>
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No support tickets returned" emptyDescription="The authorized queue returned no records. Connection state and last update remain visible above." onRetry={props.onRetry}>
          <ul class="flex flex-col gap-3">
            <For each={rows()}>{(ticket) => <li class={`rounded-card border-s-8 bg-surface-elevation-1 p-4 2xl:p-5 ${EDGE[PRIORITY[ticket.priority].tone]}`}>
              <div class="flex items-start gap-3"><StatusIcon state={ticket.priority} theme={PRIORITY[ticket.priority].tone} class="mt-1 size-6" />
                <div class="min-w-0 flex-1"><h3 class="text-xl font-medium leading-snug 2xl:text-2xl">{ticket.title}</h3>
                  <div class="mt-2 flex flex-wrap items-center gap-2"><StatusBadge kind="ticket" status={ticket.state} /><StatusBadge kind="severity" status={ticket.priority} />
                    <Badge size="lg" variant="outline" theme={ticket.evidenceReady ? "green" : "amber"} label={ticket.evidenceReady ? "Evidence ready" : "Evidence pending"} />
                    <span class="text-sm text-ink-gray-6 2xl:text-base">Updated {formatRelative(ticket.updatedAt)}</span></div></div></div>
            </li>}</For>
          </ul>
          <Show when={props.tickets.length > rows().length}><p class="mt-3 text-lg text-ink-gray-6">and {props.tickets.length - rows().length} more in the queue</p></Show>
        </ScreenRegion>
      </section>
    </div>
  </>;
}

const SEVERITY: Record<IncidentSummary["severity"], { tone: Tone; label: string }> = { critical: { tone: "red", label: "Critical" }, warning: { tone: "amber", label: "Warning" }, info: { tone: "blue", label: "Info" } };

function SreBoard(props: { incidents: IncidentSummary[]; asOf?: string; state: ScreenState<unknown>; onRetry: () => void }): JSX.Element {
  const count = (severity: IncidentSummary["severity"]) => props.incidents.filter((i) => i.severity === severity).length;
  const now = () => Date.parse(props.asOf ?? "") || Date.now();
  const stale = () => props.incidents.filter((i) => !isFreshFromServer(i.expiresAt, props.asOf)).length;
  const mix = (): Slice[] => (["critical", "warning", "info"] as const).map((s) => ({ label: SEVERITY[s].label, value: count(s), tone: SEVERITY[s].tone }));
  const age = () => bucketize(props.incidents.map((i) => Date.parse(i.observedAt)), now(), [
    { label: "Under 1 hour", maxMs: HOUR, tone: "green" }, { label: "1 to 6 hours", maxMs: 6 * HOUR, tone: "blue" }, { label: "6 to 24 hours", maxMs: DAY, tone: "amber" }, { label: "Over 1 day", maxMs: Infinity, tone: "red" }]);
  return <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No open incidents returned" emptyDescription="The authorized incident query returned no open records. This is not proof that every target is healthy." onRetry={props.onRetry}>
    <div class="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
      <Tile label="Critical incidents" value={String(count("critical"))} hint="Observed and still open" tone={count("critical") ? "red" : "green"} />
      <Tile label="Warnings" value={String(count("warning"))} hint="Observed and still open" tone={count("warning") ? "amber" : "green"} />
      <Tile label="Stale observations" value={String(stale())} hint="Past their valid-until time" tone={stale() ? "amber" : "green"} />
      <Tile label="Open incidents" value={String(props.incidents.length)} hint="Authorized incident queue" tone="gray" />
    </div>
    <div class="grid items-start gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div class="grid gap-4">
        <Panel title="Severity mix" hint="Open incidents by severity"><Donut slices={mix()} centre={String(props.incidents.length)} caption="open" label="Severity mix" /></Panel>
        <Panel title="Time since observed" hint="How long ago each incident was last observed"><AgeBars buckets={age()} label="Time since observed" /></Panel>
      </div>
      <div class="grid min-w-0 gap-4">
        <Show when={props.incidents[0]} keyed>{(incident) => <section aria-label="Highest severity incident" class={`rounded-card border-s-8 p-6 2xl:p-8 ${incident.severity === "critical" ? "border-s-outline-red-6 bg-surface-red-1" : "border-s-outline-amber-5 bg-surface-amber-1"}`}>
          <div class="flex flex-wrap items-center gap-3"><StatusBadge kind="severity" status={incident.severity} /><StatusBadge kind="incident" status={incident.state} /><Show when={!isFreshFromServer(incident.expiresAt, props.asOf)}><Badge size="lg" theme="amber" label="Stale observation" /></Show></div>
          <h2 class="mt-3 text-3xl font-semibold tracking-tight 2xl:text-4xl">{incident.title}</h2><p class="mt-2 text-xl text-ink-gray-8 2xl:text-2xl">{incident.targetKey}</p>
          <p class="mt-4 text-base text-ink-gray-7 2xl:text-lg">Observed {formatRelative(incident.observedAt)}, valid until {formatDateTime(incident.expiresAt)}</p>
        </section>}</Show>
        <section aria-label="Other observed incidents"><h2 class="mb-3 text-xl font-semibold 2xl:text-2xl">Observed incident queue</h2>
          <Show when={props.incidents.length > 1} fallback={<p class="rounded-card border border-outline-gray-2 bg-surface-elevation-1 p-5 text-lg text-ink-gray-7">No other incidents are open.</p>}>
            <ul class="flex flex-col gap-3"><For each={props.incidents.slice(1, 9)}>{(incident) => <li class={`rounded-card border-s-8 bg-surface-elevation-1 p-4 2xl:p-5 ${EDGE[SEVERITY[incident.severity].tone]}`}>
              <div class="flex items-start gap-3"><StatusIcon state={incident.severity} theme={SEVERITY[incident.severity].tone} class="mt-1 size-6" />
                <div class="min-w-0 flex-1"><h3 class="text-xl font-medium 2xl:text-2xl">{incident.title}</h3><p class="mt-1 text-base text-ink-gray-7 2xl:text-lg">{incident.targetKey}</p>
                  <div class="mt-2 flex flex-wrap items-center gap-2"><StatusBadge kind="severity" status={incident.severity} /><Show when={!isFreshFromServer(incident.expiresAt, props.asOf)}><Badge theme="amber" label="Stale" /></Show><span class="text-sm text-ink-gray-6 2xl:text-base">Observed {formatRelative(incident.observedAt)}</span></div></div></div>
            </li>}</For></ul>
            <Show when={props.incidents.length > 9}><p class="mt-3 text-lg text-ink-gray-6">and {props.incidents.length - 9} more observed</p></Show>
          </Show>
        </section>
      </div>
    </div>
  </ScreenRegion>;
}

/** The redacted, read-only kiosk dashboard behind `/tv/support` and `/tv/sre`; refreshes itself every 20 s. */
export function TvBoard(props: { area: "support" | "sre" }): JSX.Element {
  const app = useApp();
  const support = createScopedRead<{ tickets: TicketSummary[]; sla?: SLASummary }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const period = monthPeriod();
      const [tickets, sla] = await Promise.all([
        ticketsQuery(scope.workspaceId, signal),
        slaQuery(scope.workspaceId, period.periodStart, period.periodEnd, signal).catch((error: unknown) => { if (error instanceof GovernorError && (error.status === 401 || error.status === 403)) throw error; return undefined; }),
      ]);
      return { asOf: tickets.asOf, sourceWatermark: tickets.sourceWatermark, partialFailures: sla ? [] : ["SLA summary is unavailable"], snapshot: { tickets: [...tickets.snapshot.items], sla: sla?.snapshot } };
    },
    isEmpty: (data) => data.tickets.length === 0, refreshMs: 20_000,
  });
  const incidents = createScopedRead<IncidentSummary[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await incidentsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0, refreshMs: 20_000,
  });
  const tickets = () => [...(support.state().data?.tickets ?? [])].sort((a, b) => {
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    return rank[a.priority] - rank[b.priority] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  const incidentRows = () => [...(incidents.state().data ?? [])].sort((a, b) => Number(a.severity !== "critical") - Number(b.severity !== "critical") || Date.parse(b.observedAt) - Date.parse(a.observedAt));
  return <main data-testid="tv-kiosk" class="brain-wallboard p-5 md:p-8 2xl:p-10">
    <div class="mx-auto flex max-w-[1800px] flex-col gap-5 2xl:gap-6">
      <KioskHeader area={props.area} state={props.area === "support" ? support.state() : incidents.state()} asOf={props.area === "support" ? support.state().asOf : incidents.state().asOf} />
      <Show when={props.area === "support"} fallback={<SreBoard incidents={incidentRows()} asOf={incidents.state().asOf} state={incidents.state()} onRetry={() => void incidents.refresh({ force: true })} />}>
        <SupportBoard tickets={tickets()} sla={support.state().data?.sla} asOf={support.state().asOf} state={support.state()} onRetry={() => void support.refresh({ force: true })} />
      </Show>
    </div>
  </main>;
}
