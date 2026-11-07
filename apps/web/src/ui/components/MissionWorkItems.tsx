import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import type { WorkItem, WorkItemState } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { PageStack } from "./PageLayout";
import { WorkItemTasks } from "./WorkItemTasks";
import { EvidenceBundleSelector } from "./ArtifactSelectors";
import { EvidenceList } from "./EvidenceList";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceSection } from "./Domain";

const STATES: readonly { id: WorkItemState; name: string }[] = [
  { id: "backlog", name: "Backlog" }, { id: "ready", name: "Ready" }, { id: "in-progress", name: "In Progress" },
  { id: "blocked", name: "Blocked" }, { id: "review", name: "Review" }, { id: "done", name: "Done" },
];

/**
 * The confirmed work of one mission, managed in place: state, next action,
 * criteria, linked runs and governed moves. Done stays gated by an
 * independently verified evidence bundle the Governor checks per criterion,
 * and every move carries the item version it was read at.
 */
export function MissionWorkItems(props: { missionId: string }): JSX.Element {
  const app = useApp();
  const [selectedId, setSelectedId] = createSignal("");
  const [move, setMove] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [evidence, setEvidence] = createSignal("");
  const [comment, setComment] = createSignal("");
  const [conflict, setConflict] = createSignal("");
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: WorkItem[] }; asOf: string; sourceWatermark: number }>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((item) => item.missionId === props.missionId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (list) => list.length === 0,
    refreshMs: 15_000,
  });
  createEffect(() => { void props.missionId; setSelectedId(""); void items.refresh({ force: true }); });
  const selected = () => items.state().data?.find((item) => item.workItemId === selectedId());
  const reset = () => { setMove(""); setReason(""); setEvidence(""); setComment(""); };

  async function transition(item: WorkItem): Promise<void> {
    try {
      const result = await app.run("workItem.transition", { workItemId: item.workItemId, state: move() as WorkItemState, ...(evidence() ? { evidenceDigest: evidence() } : {}), ...(reason().trim() ? { reason: reason().trim() } : {}) }, { expectedVersion: item.version });
      setConflict(result.accepted ? "" : result.detail ?? "The move was refused");
      if (result.accepted) reset();
    } catch (error) {
      setConflict(error instanceof Error ? error.message : "The move was refused");
    }
    await items.refresh({ force: true });
  }

  async function addComment(item: WorkItem): Promise<void> {
    await app.run("workItem.comment", { workItemId: item.workItemId, text: comment().trim() });
    setComment("");
  }

  return <WorkspaceSection title="Mission work" description="Confirmed work items of this mission. Done requires independently verified evidence for every criterion.">
    <Show when={conflict()}><Alert theme="amber" variant="outline" title="This work changed; your intended move is preserved" description={conflict()} /></Show>
    <ScreenRegion state={items.state()} onRetry={() => void items.refresh({ force: true })} emptyTitle="No confirmed work yet" emptyDescription="Confirm a plan version to create this mission's work items.">
      <Show when={selected()} keyed fallback={<div class="flex flex-col gap-2"><For each={items.state().data ?? []}>{(item) =>
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-2">
          <div class="min-w-0"><p class="break-words text-interface font-medium text-ink-gray-9">{item.title}</p><p class="text-caption text-ink-gray-6">{item.nextAction}</p></div>
          <div class="flex items-center gap-2"><StatusBadge kind="workItem" status={item.state} /><Button size="sm" variant="outline" aria-label={`Manage ${item.title}`} onClick={() => { reset(); setConflict(""); setSelectedId(item.workItemId); }}>Manage</Button></div>
        </div>}</For></div>}>
        {(item) => {
          const verified = () => Boolean(item.evidenceDigest || evidence());
          const doneBlocked = () => move() === "done" && !verified();
          return <PageStack>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex flex-wrap items-center gap-2"><h3 class="text-base-medium">{item.title}</h3><StatusBadge kind="workItem" status={item.state} /><Badge variant="outline" theme={item.evidenceDigest ? "green" : "gray"} label={item.evidenceDigest ? "Verified evidence bound" : "Evidence required for Done"} /></div>
              <Button size="md" variant="ghost" iconLeft="lucide-arrow-left" onClick={() => setSelectedId("")}>Back to mission work</Button>
            </div>
            <div class="border-y border-outline-gray-1 py-3"><h4 class="text-base-medium">Next action</h4><p class="mt-1 text-interface text-ink-gray-7">{item.nextAction}</p><Show when={item.blockedReason}><Alert theme="amber" variant="outline" title="Blocked" description={item.blockedReason} /></Show></div>
            <div><h4 class="text-base-medium">Acceptance criteria</h4><ul class="mt-2 list-disc ps-5 text-interface text-ink-gray-7"><For each={item.criteria}>{(criterion) => <li>{criterion}</li>}</For></ul></div>
            <Show when={item.evidenceDigest}><EvidenceList bundleDigest={item.evidenceDigest} /></Show>
            <WorkItemTasks origin={{ kind: "work-item", id: item.workItemId }} />
            <div class="brain-field-grid">
              <EvidenceBundleSelector label={`Verified evidence for ${item.title}`} onSelect={setEvidence} />
              <Select label={`Move ${item.title}`} value={move() || null} options={STATES.filter((state) => state.id !== item.state).map((state) => ({ value: state.id, label: state.name, disabled: state.id === "done" && !verified() }))} onValueChange={(state) => setMove(state ?? "")} />
              <Show when={move() === "blocked"}><TextInput label="Blocking reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} required /></Show>
            </div>
            <Show when={doneBlocked()}><Alert theme="amber" variant="outline" title="Verified evidence is required" description="Choose an independently verified evidence bundle before selecting Done. Author output alone cannot complete this work." /></Show>
            <TextInput label="Add a comment" value={comment()} onInput={(event) => setComment(event.currentTarget.value)} />
            <div class="flex flex-wrap gap-2 border-t border-outline-gray-1 pt-3">
              <Button size="md" variant="outline" iconLeft="lucide-message-square" disabled={!comment().trim()} onClick={() => void addComment(item)}>Add comment</Button>
              <Button size="md" theme="blue" iconLeft="lucide-arrow-right-left" disabled={!move() || doneBlocked() || (move() === "blocked" && !reason().trim())} onClick={() => void transition(item)}>Move work item</Button>
            </div>
          </PageStack>;
        }}
      </Show>
    </ScreenRegion>
  </WorkspaceSection>;
}
