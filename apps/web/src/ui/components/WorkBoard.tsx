import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button, createMediaQuery, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Select } from "@talelk/newui-molecules";
import { KanbanBoard } from "@talelk/newui-organisms";
import type { KanbanColumn, KanbanTone } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import type { WorkBoardView, WorkItem, WorkItemState } from "@brain/contracts";
import type { ScreenState } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { BrainPage, PageStack } from "./PageLayout";
import { WorkItemTasks } from "./WorkItemTasks";
import { EvidenceBundleSelector } from "./ArtifactSelectors";
import { EvidenceList } from "./EvidenceList";
import { StatusBadge } from "./StatusBadge";
import { EmptyPreview, WorkspaceSection } from "./Domain";

const CARD_ACCENT: Record<WorkItemState, string> = {
  backlog: "border-s-outline-gray-3", ready: "border-s-outline-blue-3", "in-progress": "border-s-outline-blue-3",
  blocked: "border-s-outline-red-3", review: "border-s-outline-amber-3", done: "border-s-outline-green-3", abandoned: "border-s-outline-gray-3",
};

const STATES: readonly { id: WorkItemState; name: string; theme: KanbanTone }[] = [
  { id: "backlog", name: "Backlog", theme: "gray" }, { id: "ready", name: "Ready", theme: "blue" },
  { id: "in-progress", name: "In Progress", theme: "blue" }, { id: "blocked", name: "Blocked", theme: "red" },
  { id: "review", name: "Review", theme: "amber" }, { id: "done", name: "Done", theme: "green" },
];

function WorkItemDetail(props: {
  item: WorkItem;
  objective: string;
  comment: string;
  evidence: string;
  move: string;
  reason: string;
  onComment: (value: string) => void;
  onEvidence: (value: string) => void;
  onMove: (value: string) => void;
  onReason: (value: string) => void;
  onAddComment: () => void;
  onTransition: () => void;
  onBack: () => void;
}): JSX.Element {
  const item = () => props.item;
  const verified = () => Boolean(item().evidenceDigest || props.evidence);
  const doneBlocked = () => props.move === "done" && !verified();
  return <PageStack>
    <WorkspaceSection title={item().title} description={`${props.objective} · record v${item().version}`} actions={<Button size="lg" variant="ghost" iconLeft="lucide-arrow-left" onClick={props.onBack}>Back to board</Button>}>
      <div class="flex flex-wrap gap-2"><StatusBadge kind="workItem" status={item().state} /><Badge variant="outline" theme={item().evidenceDigest ? "green" : "gray"} label={item().evidenceDigest ? "Verified evidence bound" : "Evidence required for Done"} /></div>
    </WorkspaceSection>
    <div class="border-y border-outline-gray-1 py-4"><h3 class="text-base-medium">Next action</h3><p class="mt-1 text-interface text-ink-gray-7">{item().nextAction}</p><Show when={item().blockedReason}><Alert theme="amber" variant="outline" title="Blocked" description={item().blockedReason} /></Show></div>
    <div><h3 class="text-base-medium">Acceptance criteria</h3><ul class="mt-2 list-disc ps-5 text-interface text-ink-gray-7"><For each={item().criteria}>{(criterion) => <li>{criterion}</li>}</For></ul></div>
    <Show when={item().evidenceDigest}><EvidenceList bundleDigest={item().evidenceDigest} /></Show>
    <WorkItemTasks origin={{ kind: "work-item", id: item().workItemId }} />
    <div class="brain-field-grid">
      <EvidenceBundleSelector label={`Verified evidence for ${item().title}`} onSelect={props.onEvidence} />
      <Select label={`Move ${item().title}`} value={props.move || null} options={STATES.filter((state) => state.id !== item().state).map((state) => ({ value: state.id, label: state.name, disabled: state.id === "done" && !verified() }))} onValueChange={(state) => props.onMove(state ?? "")} />
      <Show when={props.move === "blocked"}><TextInput label="Blocking reason" value={props.reason} onInput={(event) => props.onReason(event.currentTarget.value)} required /></Show>
    </div>
    <Show when={doneBlocked()}><Alert theme="amber" variant="outline" title="Verified evidence is required" description="Choose an independently verified evidence bundle before selecting Done. Author output alone cannot complete this work." /></Show>
    <TextInput label="Add a comment" value={props.comment} onInput={(event) => props.onComment(event.currentTarget.value)} />
    <div class="flex flex-wrap gap-2 border-t border-outline-gray-1 pt-4"><Button size="md" variant="outline" iconLeft="lucide-message-square" disabled={!props.comment.trim()} onClick={props.onAddComment}>Add comment</Button><Button size="lg" theme="blue" iconLeft="lucide-arrow-right-left" disabled={!props.move || doneBlocked() || (props.move === "blocked" && !props.reason.trim())} onClick={props.onTransition}>Move work item</Button></div>
  </PageStack>;
}

export function WorkBoard(props: {
  board?: WorkBoardView;
  selectedId?: string;
  onSelected: (id?: string) => void;
  state: ScreenState<WorkBoardView>;
  conflict?: string;
  onRefresh: () => void;
  onTransition: (item: WorkItem, state: WorkItemState, evidenceDigest?: string, reason?: string) => Promise<void>;
  onComment: (item: WorkItem, text: string) => Promise<void>;
}): JSX.Element {
  const navigate = useNavigate();
  const desktop = createMediaQuery("(min-width: 1024px)");
  const [comment, setComment] = createSignal("");
  const [evidence, setEvidence] = createSignal("");
  const [move, setMove] = createSignal("");
  const [reason, setReason] = createSignal("");
  type BoardCard = WorkItem & { id: string };
  const cards = (): BoardCard[] => (props.board?.items ?? []).map((item) => ({ ...item, id: item.workItemId }));
  const selected = () => cards().find((item) => item.workItemId === props.selectedId);
  createEffect(() => { if (props.selectedId) { setComment(""); setEvidence(""); setMove(""); setReason(""); } });
  const columns = (): KanbanColumn<BoardCard>[] => STATES.map((state) => ({ id: state.id, name: state.name, theme: state.theme, items: cards().filter((item) => item.state === state.id) }));
  const objective = (item: WorkItem) => props.board?.objectives.find((entry) => entry.objectiveId === item.objectiveId)?.title ?? item.objectiveId;
  const detail = (item: WorkItem, onBack: () => void) => <WorkItemDetail item={item} objective={objective(item)} comment={comment()} evidence={evidence()} move={move()} reason={reason()}
    onComment={setComment} onEvidence={setEvidence} onMove={setMove} onReason={setReason} onBack={onBack}
    onAddComment={() => void props.onComment(item, comment().trim()).then(() => setComment(""))}
    onTransition={() => void props.onTransition(item, move() as WorkItemState, evidence().trim() || undefined, reason().trim() || undefined)} />;
  const board = <div class="brain-kanban-fit"><KanbanBoard columns={columns()} label="Work items" itemLabel={(item) => item.title} onMove={(next) => {
    const item = next.item;
    if (next.to.column === "done" && !item.evidenceDigest) { props.onSelected(item.workItemId); setMove("done"); return; }
    if (next.to.column !== item.state) void props.onTransition(item, next.to.column as WorkItemState, item.evidenceDigest);
  }}>
    {(item) => <div class={`flex flex-col gap-2 rounded-control border-s-2 p-1 ${CARD_ACCENT[item.state]} ${selected()?.workItemId === item.workItemId ? "bg-surface-blue-1" : ""}`}>
      <div><p class="break-words text-base-medium text-ink-gray-9">{item.title}</p><p class="mt-1 truncate text-caption text-ink-gray-6">{objective(item)}</p></div>
      <p class="break-words text-caption text-ink-gray-7">{item.blockedReason ?? item.nextAction}</p>
      <div class="flex flex-wrap gap-1.5"><Show when={item.assignment}><Badge size="sm" theme="blue" label={item.assignment?.kind === "human" ? item.assignment?.id : `${item.assignment?.kind}: ${item.assignment?.id}`} /></Show><Show when={item.dependsOn.length}><Badge size="sm" theme="gray" label={`${item.dependsOn.length} dependencies`} /></Show><Badge size="sm" variant="outline" theme={item.evidenceDigest ? "green" : "gray"} label={item.evidenceDigest ? "Evidence ready" : `${item.criteria.length} criteria`} /></div>
      <Button variant="ghost" size="md" iconRight="lucide-arrow-right" class="self-start" aria-label={`Manage ${item.title}`} onClick={() => props.onSelected(item.workItemId)}>Manage</Button>
    </div>}
  </KanbanBoard></div>;

  return <BrainPage title="Work board" description="Move reviewed work through clear states; Done remains gated by independently verified evidence."
    actions={<Button size="lg" theme="blue" iconLeft="lucide-plus" onClick={() => void navigate(`/w/${props.board?.workspaceId}/plans`)}>New objective</Button>}>
    <PageStack>
      <Show when={props.conflict}><Alert theme="amber" variant="outline" title="This work changed; your intended move is preserved" description={props.conflict} /></Show>
      <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No planned work" emptyDescription="Create an objective and confirm a plan to populate the board." onRetry={props.onRefresh}>
        <Show when={desktop()} fallback={<>{board}<Dialog.Root open={Boolean(selected())} onOpenChange={(open) => { if (!open) props.onSelected(); }}>
          <Dialog.Content size="lg" class="max-sm:fixed max-sm:inset-0 max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"><Show when={selected()} keyed>{(item) => <div class="my-4 max-h-[80dvh] overflow-y-auto pe-1">{detail(item, () => props.onSelected())}</div>}</Show></Dialog.Content>
        </Dialog.Root></>}>
          <PaneLayout class="brain-list-detail" startSize={selected() ? 68 : 100} minStartSize={45} maxStartSize={100} active={selected() ? "end" : "start"} start={board} end={<Show when={selected()} keyed fallback={<EmptyPreview icon="lucide-kanban-square" title="Select a work item" description="Review its criteria, evidence, linked runs and safe transitions without losing the board." />}>{(item) => detail(item, () => props.onSelected())}</Show>} />
        </Show>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
