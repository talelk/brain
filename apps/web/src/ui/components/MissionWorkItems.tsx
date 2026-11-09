import { createEffect, createSignal, For, Show } from "solid-js";
import { ParkedActions } from "./ParkedActions";
import type { JSX } from "solid-js";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { useNavigate } from "@solidjs/router";
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
import { WorkspaceSection } from "./Domain";import { FormSheet } from "./BrainForm";

const STATES: readonly { id: WorkItemState; name: string }[] = [
  { id: "backlog", name: "Backlog" }, { id: "ready", name: "Ready" }, { id: "in-progress", name: "In Progress" },
  { id: "blocked", name: "Blocked" }, { id: "review", name: "Review" }, { id: "done", name: "Done" },
];

/** Why a task is not moving, in plain words; undefined while it is simply progressing. */
export function waitReason(item: WorkItem): string | undefined {
  if (item.parked) return "Parked after repeated failures. It waits for a person; independent work carries on.";
  if (item.state === "blocked") return `Blocked: ${item.blockedReason ?? "it is waiting on something outside the task"}`;
  if (item.state === "backlog" && item.dependsOn.length) return "Waiting for earlier tasks to be verified done.";
  if (item.state === "review") return "Finished; waiting for you to check the evidence.";
  if (item.failedAttempts > 0 && item.state !== "done") return `${item.failedAttempts} failed attempt${item.failedAttempts === 1 ? "" : "s"} so far.`;
  return undefined;
}

/**
 * The confirmed work of one mission, managed in place: state, next action,
 * criteria, linked runs and governed moves. Done stays gated by an
 * independently verified evidence bundle the Governor checks per criterion,
 * and every move carries the item version it was read at.
 */
export function MissionWorkItems(props: { missionId: string }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [sheet, setSheet] = createSignal<"" | "move" | "comment">("");
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
  const readyItems = () => (items.state().data ?? []).filter((item) => item.state === "ready");
  const readyCount = () => readyItems().length;
  const reset = () => { setMove(""); setReason(""); setEvidence(""); setComment(""); };

  const startHref = (item: WorkItem) => `/w/${app.workspaceId()}/plays?originKind=work-item&originId=${encodeURIComponent(item.workItemId)}`;
  async function transition(item: WorkItem): Promise<void> {
    try {
      const result = await app.run("workItem.transition", { workItemId: item.workItemId, state: move() as WorkItemState, ...(evidence() ? { evidenceDigest: evidence() } : {}), ...(reason().trim() ? { reason: reason().trim() } : {}) }, { expectedVersion: item.version });
      setConflict(result.accepted ? "" : result.detail ?? "The move was refused");
      if (result.accepted) { reset(); setSheet(""); }
    } catch (error) {
      setConflict(error instanceof Error ? error.message : "The move was refused");
    }
    await items.refresh({ force: true });
  }

  async function addComment(item: WorkItem): Promise<void> {
    if (!comment().trim()) return;
    await app.run("workItem.comment", { workItemId: item.workItemId, text: comment().trim() });
    setComment(""); setSheet("");
  }

  return <WorkspaceSection title="Mission work" description="Confirmed work items of this mission. Done requires independently verified evidence for every criterion.">
    <Show when={readyCount() > 1 && app.canDispatch()}><div class="flex flex-wrap items-center justify-between gap-2 rounded-card border border-outline-blue-1 bg-surface-blue-1 px-3 py-2">
      <p class="text-interface text-ink-gray-8">{readyCount()} tasks are ready. Each one starts from its own Start button; this opens the first.</p>
      <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-play" onClick={() => { const first = readyItems()[0]; if (first) void navigate(startHref(first)); }}>Start the first of {readyCount()} ready tasks</Button>
    </div></Show>
    <Show when={conflict() && sheet() !== "move"}><Alert theme="amber" variant="outline" title="This work changed; your intended move is preserved" description={conflict()} /></Show>
    <ScreenRegion state={items.state()} onRetry={() => void items.refresh({ force: true })} emptyTitle="No confirmed work yet" emptyDescription="Confirm a plan version to create this mission's work items.">
      <Show when={selected()} keyed fallback={<div class="flex flex-col gap-2"><For each={items.state().data ?? []}>{(item) =>
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 py-2">
          <div class="min-w-0"><p class="break-words text-interface font-medium text-ink-gray-9">{item.title}</p><p class="text-caption text-ink-gray-6">{item.nextAction}</p>
            <Show when={waitReason(item)}>{(reason) => <p class="mt-0.5 flex items-center gap-1 text-caption text-ink-amber-8"><span class="lucide-hourglass size-3 shrink-0" aria-hidden="true" />{reason()}</p>}</Show></div>
          <div class="flex items-center gap-2"><StatusBadge kind="workItem" status={item.state} /><Show when={item.state === "ready" && app.canDispatch()}><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-play" aria-label={`Start ${item.title}`} onClick={() => void navigate(startHref(item))}>Start</Button></Show><Button size="sm" variant="outline" aria-label={`Manage ${item.title}`} onClick={() => { reset(); setConflict(""); setSelectedId(item.workItemId); }}>Manage</Button></div>
        </div>}</For></div>}>
        {(item) => {
          const verified = () => Boolean(item.evidenceDigest || evidence());
          const doneBlocked = () => move() === "done" && !verified();
          return <PageStack>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex flex-wrap items-center gap-2"><h3 class="text-base-medium">{item.title}</h3><StatusBadge kind="workItem" status={item.state} /><Badge variant="outline" theme={item.evidenceDigest ? "green" : "gray"} label={item.evidenceDigest ? "Verified evidence bound" : "Evidence required for Done"} /></div>
              <Button variant="ghost" iconLeft="lucide-arrow-left" onClick={() => setSelectedId("")}>Back to mission work</Button>
            </div>
            <Show when={item.parked}><ParkedActions item={item} onChanged={async () => { setSelectedId(""); await items.refresh({ force: true }); }} /></Show>
            <div class="border-y border-outline-gray-1 py-3"><h4 class="text-base-medium">Next action</h4><p class="mt-1 text-interface text-ink-gray-7">{item.nextAction}</p><Show when={item.blockedReason}><Alert theme="amber" variant="outline" title="Blocked" description={item.blockedReason} /></Show></div>
            <div><h4 class="text-base-medium">Acceptance criteria</h4><ul class="mt-2 list-disc ps-5 text-interface text-ink-gray-7"><For each={item.criteria}>{(criterion) => <li>{criterion}</li>}</For></ul></div>
            <Show when={item.evidenceDigest}><EvidenceList bundleDigest={item.evidenceDigest} /></Show>
            <WorkItemTasks origin={{ kind: "work-item", id: item.workItemId }} />
            <div class="flex flex-wrap gap-2 border-t border-outline-gray-1 pt-3">
              <Show when={item.state === "ready" && app.canDispatch()}><Button variant="solid" theme="blue" iconLeft="lucide-play" onClick={() => void navigate(startHref(item))}>Start this task</Button></Show>
              <Button variant="outline" iconLeft="lucide-arrow-right-left" onClick={() => { reset(); setSheet("move"); }}>Move work item</Button>
              <Button variant="outline" iconLeft="lucide-message-square" onClick={() => { setComment(""); setSheet("comment"); }}>Add comment</Button>
            </div>
            <FormSheet open={sheet() === "move"} onClose={() => setSheet("")} title={`Update ${item.title}`} description="Done requires independently verified evidence for every criterion."
              submit="Move work item" icon="lucide-arrow-right-left" error={conflict()} errorTitle="This work changed; your intended move is preserved" disabled={!move() || doneBlocked() || (move() === "blocked" && !reason().trim())} onSubmit={() => { if (move() && !doneBlocked()) return transition(item); }}>
              <EvidenceBundleSelector label={`Verified evidence for ${item.title}`} onSelect={setEvidence} />
              <Select label={`Move ${item.title}`} value={move() || null} options={STATES.filter((state) => state.id !== item.state).map((state) => ({ value: state.id, label: state.name, disabled: state.id === "done" && !verified() }))} onValueChange={(state) => setMove(state ?? "")} />
              <Show when={move() === "blocked"}><TextInput label="Blocking reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} required /></Show>
            <Show when={doneBlocked()}><Alert theme="amber" variant="outline" title="Verified evidence is required" description="Choose an independently verified evidence bundle before selecting Done. Author output alone cannot complete this work." /></Show>
            </FormSheet>
            <FormSheet open={sheet() === "comment"} onClose={() => setSheet("")} title="Add a comment" centered description="Comments are recorded on the work item's history." submit="Add comment" icon="lucide-message-square" disabled={!comment().trim()} onSubmit={() => addComment(item)}>
              <Textarea label="Comment" required value={comment()} onInput={(event) => setComment(event.currentTarget.value)} />
            </FormSheet>
          </PageStack>;
        }}
      </Show>
    </ScreenRegion>
  </WorkspaceSection>;
}
