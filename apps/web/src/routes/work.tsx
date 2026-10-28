import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, TabButtons } from "@talelk/newui-molecules";
import { DataTable, KanbanBoard, Section, StatGrid } from "@talelk/newui-organisms";
import type { KanbanColumn } from "@talelk/newui-organisms";
import type {
  BoardView, CardView, DecisionHistoryEntry, DeliveryDossier, IncidentSummary, SLASummary, TicketSummary,
} from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { EvidenceList } from "../ui/components/EvidenceList";

const BOARD_STATES = [
  { id: "to-decide", name: "To decide", theme: "gray" }, { id: "todo", name: "Todo", theme: "gray" },
  { id: "in-progress", name: "In progress", theme: "blue" }, { id: "verifying", name: "Verifying", theme: "amber" },
  { id: "done", name: "Done", theme: "green" }, { id: "blocked", name: "Blocked", theme: "red" },
] as const;

/**
 * The work board. Moves are versioned commands, Done requires bound verified
 * evidence, and a lost race shows the newer version instead of overwriting.
 */
export function BoardScreen(props: {
  board?: BoardView;
  state: ScreenState<BoardView>;
  onRefresh: () => void;
  onCreate: (title: string, criteria: string[]) => Promise<void>;
  onMove: (cardId: string, status: string, version: number, evidenceDigest?: string) => Promise<void>;
  onComment: (cardId: string, text: string) => Promise<void>;
  /** Populated after a rejected move so the reader sees the newer state. */
  conflict?: string;
}): JSX.Element {
  const [createOpen, setCreateOpen] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [criteria, setCriteria] = createSignal("");
  const [commentByCard, setCommentByCard] = createSignal<Record<string, string>>({});
  const [evidenceByCard, setEvidenceByCard] = createSignal<Record<string, string>>({});
  /** KanbanBoard items are keyed by `id`; Brain cards are keyed by `cardId`. */
  type BoardCard = CardView & { id: string };
  const cards = (): BoardCard[] => (props.board?.cards ?? []).map((card) => ({ ...card, id: card.cardId }));

  const columns = (): KanbanColumn<BoardCard>[] =>
    BOARD_STATES.map((state) => ({
      id: state.id, name: state.name, theme: state.theme,
      items: cards().filter((card) => card.state === state.id),
    }));

  return (
    <div class="flex flex-col gap-field-gap">
      <Show when={props.conflict}>
        <Alert theme="amber" variant="outline" title="That card changed while you were reviewing it"
          description={props.conflict} />
      </Show>
      <Section title="Board" description="Done is only accepted when verified evidence covers every criterion." surface="card"
        actions={<Button onClick={() => setCreateOpen(true)} class="min-h-11">New card</Button>}>
        <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No cards yet"
          emptyDescription="Cards appear here when work is planned for this workspace."
          emptyAction={<Button onClick={() => setCreateOpen(true)}>New card</Button>} onRetry={props.onRefresh}>
          <Show when={cards().length}>
            <KanbanBoard columns={columns()} label="Workspace board"
              onMove={(move) => {
                if (move.to.column !== move.item.state) void props.onMove(move.item.cardId, move.to.column, move.item.version, evidenceByCard()[move.item.cardId]?.trim());
              }}>
              {(card) => (
                <div class="flex flex-col gap-control-gap">
                  <p class="text-base-medium text-ink-gray-9">{card.title}</p>
                  <div class="flex flex-wrap gap-1">
                    <For each={card.criteria}>{(criterion) => (
                      <Badge theme={criterion.status === "passed" ? "green" : criterion.status === "failed" ? "red" : "gray"} label={`${criterion.id}: ${criterion.status}`} />
                    )}</For>
                  </div>
                  <Show when={card.evidenceDigest}>
                    <p class="text-caption text-ink-green-8">evidence attached</p>
                    <EvidenceList bundleDigest={card.evidenceDigest} />
                  </Show>
                  <TextInput label={`Evidence digest for ${card.title}`} value={evidenceByCard()[card.cardId] ?? ""}
                    onInput={(e) => setEvidenceByCard({ ...evidenceByCard(), [card.cardId]: e.currentTarget.value })} />
                  <TextInput label={`Comment on ${card.title}`} value={commentByCard()[card.cardId] ?? ""}
                    onInput={(e) => setCommentByCard({ ...commentByCard(), [card.cardId]: e.currentTarget.value })} />
                  <div class="flex flex-wrap gap-control-gap">
                    <For each={BOARD_STATES.filter((state) => state.id !== card.state)}>{(state) => (
                      <Button aria-label={`Move ${card.title} to ${state.name}`} class="min-h-11"
                        onClick={() => void props.onMove(card.cardId, state.id, card.version, evidenceByCard()[card.cardId]?.trim())}>
                        Move to {state.name}
                      </Button>
                    )}</For>
                    <Button variant="outline" class="min-h-11" disabled={!(commentByCard()[card.cardId] ?? "").trim()}
                      onClick={() => void props.onComment(card.cardId, commentByCard()[card.cardId]!.trim())}>
                      Add comment
                    </Button>
                  </div>
                </div>
              )}
            </KanbanBoard>
          </Show>
        </ScreenRegion>
      </Section>

      <Dialog.Root open={createOpen()} onOpenChange={setCreateOpen}>
        <Dialog.Content size="md">
          <Dialog.Header>
            <Dialog.Title>New card</Dialog.Title>
            <Dialog.Description>A card records the intended outcome and the criteria that make it Done.</Dialog.Description>
          </Dialog.Header>
          <TextInput label="Title" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} required />
          <Textarea label="Criteria" value={criteria()} description="One criterion per line; each becomes an oracle the evidence must cover."
            onInput={(e) => setCriteria(e.currentTarget.value)} />
          <Dialog.Footer class="justify-end">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Back</Button>
            <Button disabled={!title().trim() || criteria().trim().length === 0}
              onClick={() => { void props.onCreate(title().trim(), criteria().split("\n").map((c) => c.trim()).filter(Boolean)); setCreateOpen(false); }}>
              Create card
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}

/** Decisions are verbatim records: the note is what was decided, not a paraphrase. */
type Decision = "go" | "no" | "not-now" | "need-more-data";
export function DecisionsScreen(props: {
  decisions: DecisionHistoryEntry[];
  state: ScreenState<DecisionHistoryEntry[]>;
  onRefresh: () => void;
  onRecord: (cardId: string, decision: Decision, note: string) => Promise<void>;
  cardIds: string[];
}): JSX.Element {
  const [cardId, setCardId] = createSignal("");
  const [decision, setDecision] = createSignal<Decision>("go");
  const [note, setNote] = createSignal("");
  return (
    <Section title="Recorded decisions" surface="card">
      <div class="flex flex-wrap items-end gap-control-gap pb-field">
        <div class="min-w-64"><TextInput label="Card id" value={cardId()} onInput={(e) => setCardId(e.currentTarget.value)} description={props.cardIds.length ? `Known cards: ${props.cardIds.slice(0, 4).join(", ")}` : undefined} /></div>
        <div class="min-w-40"><TabButtons label="Decision" options={[{ value: "go", label: "Go" }, { value: "no", label: "No" }, { value: "not-now", label: "Not now" }, { value: "need-more-data", label: "Need more data" }]} value={decision()} onValueChange={(v) => setDecision(v as Decision)} /></div>
        <div class="min-w-64 flex-1"><Textarea label="Note" value={note()} onInput={(e) => setNote(e.currentTarget.value)} /></div>
        <Button disabled={!cardId().trim() || !note().trim()} onClick={() => void props.onRecord(cardId().trim(), decision(), note().trim())} class="min-h-11">Record decision</Button>
      </div>
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No recorded decisions yet"
        emptyDescription="Record the go/no-go decision for a card when you make it." onRetry={props.onRefresh}>
        <DataTable title="Decisions" selectable={false} hideSearch rows={props.decisions.map((d) => ({
          id: d.id, actor: d.actorId, decision: d.decision, note: d.note, at: new Date(d.createdAt).toLocaleString(), card: d.cardId,
        }))} columns={[
          { id: "card", header: "Card", accessorKey: "card" },
          { id: "actor", header: "Decided by", accessorKey: "actor" },
          { id: "decision", header: "Decision", accessorKey: "decision" },
          { id: "note", header: "Note", accessorKey: "note" },
          { id: "at", header: "At", accessorKey: "at" },
        ]} caption={`${props.decisions.length} decisions`} />
      </ScreenRegion>
    </Section>
  );
}

/** Support: tickets and the measured SLA period, with the publish gate visible. */
export function SupportScreen(props: {
  tickets: TicketSummary[];
  sla?: SLASummary;
  state: ScreenState<{ tickets: TicketSummary[]; sla?: SLASummary }>;
  onRefresh: () => void;
  onOpenTicket: (ticketId: string) => void;
  onDispatch: () => void;
  canDispatch: boolean;
}): JSX.Element {
  const ms = (n: number) => `${Math.round(n / 60000)} min`;
  return (
    <div class="flex flex-col gap-field-gap">
      <Show when={props.sla}>
        <StatGrid columns={3} stats={[
          { label: "Keyrus response time", value: ms(props.sla!.keyrusMs) },
          { label: "Client wait", value: ms(props.sla!.clientWaitMs) },
          { label: "Samples", value: String(props.sla!.sampleCount) },
        ]} />
      </Show>
      <Section title="Support tickets" description="A visible publication needs a reviewed draft plus an approval; nothing is sent from here directly." surface="card"
        actions={props.canDispatch ? <Button onClick={props.onDispatch} class="min-h-11">Run support workflow</Button> : undefined}>
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No support tickets."
          emptyDescription="Connect the ticket connector and sync to see the queue." onRetry={props.onRefresh}>
        <DataTable title="Tickets" selectable hideSearch rows={props.tickets.map((t) => ({
          id: t.id, title: t.title, state: t.state, priority: t.priority, evidence: t.evidenceReady ? "ready" : "not yet", at: new Date(t.updatedAt).toLocaleString(),
        }))} columns={[
          { id: "title", header: "Ticket", accessorKey: "title" },
          { id: "state", header: "State", accessorKey: "state" },
          { id: "priority", header: "Priority", accessorKey: "priority" },
          { id: "evidence", header: "Draft evidence", accessorKey: "evidence" },
          { id: "at", header: "Updated", accessorKey: "at" },
        ]} caption={`${props.tickets.length} tickets`} actionLabel="Details" onRowsAction={(ids) => props.onOpenTicket(ids[0] ?? "")} />
        </ScreenRegion>
      </Section>
    </div>
  );
}

/** SRE: incidents with their observation freshness and the inert remediation. */
export function SreScreen(props: {
  incidents: IncidentSummary[];
  state: ScreenState<IncidentSummary[]>;
  onRefresh: () => void;
  onOpenIncident: (incidentId: string) => void;
  onDispatch: () => void;
  canDispatch: boolean;
}): JSX.Element {
  const now = Date.now();
  return (
    <Section title="Incidents" description="A remediation proposal stays inert until an approved approval gates its tool path." surface="card"
      actions={props.canDispatch ? <Button onClick={props.onDispatch} class="min-h-11">Run SRE workflow</Button> : undefined}>
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No incidents."
        emptyDescription="Open incidents appear when a monitored target breaches a declared threshold." onRetry={props.onRefresh}>
        <For each={props.incidents}>{(incident) => (
          <article class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
            <div class="min-w-0">
              <h3 class="truncate text-base-medium text-ink-gray-9">{incident.title}</h3>
              <p class="text-caption text-ink-gray-7">{incident.targetKey} · observed <DateText value={incident.observedAt} /> · expires <DateText value={incident.expiresAt} /></p>
            </div>
            <div class="flex items-center gap-control-gap">
              <Badge theme={incident.severity === "critical" ? "red" : incident.severity === "warning" ? "amber" : "gray"} label={incident.severity} />
              <Show when={incident.expiresAt && Date.parse(incident.expiresAt) < now}>
                <Badge theme="amber" label="observation stale" />
              </Show>
              <Button onClick={() => props.onOpenIncident(incident.id)} class="min-h-11">Open</Button>
            </div>
          </article>
        )}</For>
      </ScreenRegion>
    </Section>
  );
}

/** Delivery: rubric-backed dossiers; an inconclusive criterion is not a pass. */
export function DeliveryScreen(props: {
  dossiers: DeliveryDossier[];
  state: ScreenState<DeliveryDossier[]>;
  onRefresh: () => void;
  onOpen: (dossierId: string) => void;
  onDecide: (cardId: string, note: string) => Promise<void>;
}): JSX.Element {
  return (
    <Section title="Delivery dossiers" description="Criteria pass only against accepted evidence; inconclusive stays inconclusive." surface="card">
      <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No delivery dossiers."
        emptyDescription="Dossiers are created when a delivery release declares its rubric." onRetry={props.onRefresh}>
        <For each={props.dossiers}>{(dossier) => {
          const passed = () => dossier.criteria.filter((c) => c.status === "passed").length;
          return (
            <article class="flex flex-col gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
              <div class="flex flex-wrap items-center justify-between gap-control-gap">
                <div class="min-w-0">
                  <h3 class="truncate text-base-medium text-ink-gray-9">{dossier.id}</h3>
                  <p class="text-caption text-ink-gray-7">source {dossier.sourceRevision} · {passed()}/{dossier.criteria.length} criteria · updated <DateText value={dossier.updatedAt} /></p>
                </div>
                <Badge theme={dossier.state === "verified" ? "green" : dossier.state === "rejected" ? "red" : "gray"} label={dossier.state} />
              </div>
              <div class="flex flex-wrap gap-1">
                <For each={dossier.criteria}>{(criterion) => (
                  <Badge theme={criterion.status === "passed" ? "green" : criterion.status === "failed" ? "red" : "amber"} label={criterion.criterionId} />
                )}</For>
              </div>
              <Button variant="outline" onClick={() => props.onOpen(dossier.id)} class="min-h-11">Open dossier</Button>
            </article>
          );
        }}</For>
      </ScreenRegion>
    </Section>
  );
}
