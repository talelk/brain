import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Select } from "@talelk/newui-molecules";
import { KanbanBoard } from "@talelk/newui-organisms";
import type { KanbanColumn, KanbanTone } from "@talelk/newui-organisms";
import type { WorkBoardView, WorkItem, WorkItemState } from "@brain/contracts";
import type { ScreenState } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { BrainPage, PageStack } from "./PageLayout";
import { WorkItemTasks } from "./WorkItemTasks";
import { EvidenceBundleSelector } from "./ArtifactSelectors";
import { EvidenceList } from "./EvidenceList";

const CARD_ACCENT: Record<WorkItemState, string> = {
  backlog: "border-s-outline-gray-3", ready: "border-s-outline-blue-3", "in-progress": "border-s-outline-blue-3",
  blocked: "border-s-outline-red-3", review: "border-s-outline-amber-3", done: "border-s-outline-green-3", abandoned: "border-s-outline-gray-3",
};

const STATES: readonly { id: WorkItemState; name: string; theme: KanbanTone }[] = [
  { id: "backlog", name: "Backlog", theme: "gray" }, { id: "ready", name: "Ready", theme: "blue" },
  { id: "in-progress", name: "In Progress", theme: "blue" }, { id: "blocked", name: "Blocked", theme: "red" },
  { id: "review", name: "Review", theme: "amber" }, { id: "done", name: "Done", theme: "green" },
];

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
  return <BrainPage title="Work board" description="The operational view of reviewed plans, assignments, dependencies, executions and verified outcomes."
    actions={<Button size="lg" theme="blue" iconLeft="lucide-plus" onClick={() => void navigate(`/w/${props.board?.workspaceId}/plans`)}>New objective</Button>}>
    <PageStack>
      <Show when={props.conflict}><Alert theme="amber" variant="outline" title="This work changed" description={props.conflict} /></Show>
      <ScreenRegion state={props.state} skeleton="cards" emptyTitle="No planned work" emptyDescription="Create an objective and confirm a plan to populate the board." onRetry={props.onRefresh}>
        <KanbanBoard columns={columns()} label="Work items" onMove={(next) => {
          const item = next.item;
          if (next.to.column !== item.state) void props.onTransition(item, next.to.column as WorkItemState, item.evidenceDigest);
        }}>
          {(item) => <div class={`flex flex-col gap-2 border-s-2 ${CARD_ACCENT[item.state]}`}>
            <div><p class="text-base-medium text-ink-gray-9">{item.title}</p><p class="mt-1 text-caption text-ink-gray-6">{objective(item)}</p></div>
            <p class="text-caption text-ink-gray-7">{item.nextAction}</p>
            <div class="flex flex-wrap gap-2"><Show when={item.assignment}><Badge theme="blue" label={item.assignment?.kind === "human" ? item.assignment?.id : `${item.assignment?.kind}: ${item.assignment?.id}`} /></Show><Show when={item.dependsOn.length}><Badge theme="gray" label={`${item.dependsOn.length} dependencies`} /></Show><Show when={item.evidenceDigest}><Badge theme="green" label="Evidence attached" /></Show></div>
            <Button variant="ghost" size="sm" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onSelected(item.workItemId)}>Manage {item.title}</Button>
          </div>}
        </KanbanBoard>
      </ScreenRegion>

      <Dialog.Root open={Boolean(selected())} onOpenChange={(open) => { if (!open) props.onSelected(); }}>
        <Dialog.Content size="lg" class="max-sm:fixed max-sm:inset-0 max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
          <Show when={selected()} keyed>{(item) => <>
            <Dialog.Header><Dialog.Title>{item.title}</Dialog.Title><Dialog.Description>{objective(item)} · plan {item.planVersionId} · record v{item.version}</Dialog.Description></Dialog.Header>
            <div class="my-4 flex max-h-[60dvh] flex-col gap-4 overflow-y-auto pe-1">
              <div><strong>Next action</strong><p>{item.nextAction}</p><Show when={item.blockedReason}><Alert theme="amber" variant="outline" title="Blocked" description={item.blockedReason} /></Show></div>
              <div><strong>Success criteria</strong><ul class="mt-2 list-disc ps-5"><For each={item.criteria}>{(criterion) => <li>{criterion}</li>}</For></ul></div>
              <Show when={item.evidenceDigest}><EvidenceList bundleDigest={item.evidenceDigest} /></Show>
              <WorkItemTasks origin={{ kind: "work-item", id: item.workItemId }} />
              <EvidenceBundleSelector label={`Verified evidence for ${item.title}`} onSelect={setEvidence} />
              <Select label={`Move ${item.title}`} value={move() || null} options={STATES.filter((state) => state.id !== item.state).map((state) => ({ value: state.id, label: state.name }))} onValueChange={(state) => setMove(state ?? "")} />
              <Show when={move() === "blocked"}><TextInput label="Blocking reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} required /></Show>
              <TextInput label="Add a comment" value={comment()} onInput={(event) => setComment(event.currentTarget.value)} />
            </div>
            <Dialog.Footer class="flex-wrap justify-end border-t border-outline-gray-1 pt-4">
              <Button size="lg" variant="outline" disabled={!comment().trim()} onClick={() => void props.onComment(item, comment().trim()).then(() => setComment(""))}>Add comment</Button>
              <Button size="lg" theme="blue" disabled={!move() || (move() === "blocked" && !reason().trim())} onClick={() => void props.onTransition(item, move() as WorkItemState, evidence().trim() || undefined, reason().trim() || undefined)}>Move work item</Button>
            </Dialog.Footer>
          </>}</Show>
        </Dialog.Content>
      </Dialog.Root>
    </PageStack>
  </BrainPage>;
}
