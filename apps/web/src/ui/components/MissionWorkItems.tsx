import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Alert, Select, TabButtons } from "@talelk/newui-molecules";
import type { BrainSession, Handoff, Mission, PlanVersion, WorkItem, WorkItemState } from "@brain/contracts";
import { ParkedActions } from "./ParkedActions";
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
import { FormSheet } from "./BrainForm";
import { createHandoffNeed, HandoffSheet } from "./HandoffStep";
import { missionHref } from "../mission-links";
import { formatUsd } from "../format";
import { Meter } from "../viz/Meter";
import { StateBar } from "../viz/StateBar";
import { WorkBoard } from "../work/WorkBoard";
import { WorkCard } from "../work/WorkCard";
import { TaskSessionsContext } from "../work/TaskNow";
import { WorkRoadmap, type RoadmapNode } from "../work/WorkRoadmap";
import { minutesText, workGraph, type BoardColumnId, type NextAction } from "../work/work-model";

const STATES: readonly { id: WorkItemState; name: string }[] = [
  { id: "backlog", name: "Backlog" }, { id: "ready", name: "Ready" }, { id: "in-progress", name: "In Progress" },
  { id: "blocked", name: "Blocked" }, { id: "review", name: "Review" }, { id: "done", name: "Done" },
];

type View = "timeline" | "board" | "list";
const VIEWS: readonly { value: View; label: string; icon: string }[] = [
  { value: "timeline", label: "Timeline", icon: "lucide-chart-gantt" },
  { value: "board", label: "Board", icon: "lucide-square-kanban" },
  { value: "list", label: "List", icon: "lucide-list" },
];

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/**
 * The confirmed work of one mission (#43): an at-a-glance strip (progress,
 * critical path, time and budget), then the same items as a dependency
 * Timeline, a Kanban Board or a List — the view lives in the URL (?view=).
 * Opening an item manages it in place. Done stays gated by an independently
 * verified evidence bundle, and every move carries the item version it was
 * read at.
 */
export function MissionWorkItems(props: { mission: Mission }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const view = (): View => (VIEWS.some((entry) => entry.value === search.view) ? search.view as View : "timeline");
  const [sheet, setSheet] = createSignal<"" | "move" | "comment" | "handoff">("");
  const [selectedId, setSelectedId] = createSignal("");
  const [move, setMove] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [evidence, setEvidence] = createSignal("");
  const [comment, setComment] = createSignal("");
  const [conflict, setConflict] = createSignal("");
  const missionId = () => props.mission.missionId;
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((item) => item.missionId === missionId()), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (list) => list.length === 0,
    refreshMs: 5_000,
  });
  // Sessions let each active task row say what it is doing now (#61).
  const sessions = createScopedRead<BrainSession[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: BrainSession[] }>>({ queryType: "sessions.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    refreshMs: 10_000,
  });
  // The confirmed plan names each task's estimate and the team that owns it.
  const plan = createScopedRead<PlanVersion | null>({
    scope: app.scope,
    resource: () => props.mission.activePlanVersionId ?? "",
    load: async (scope, signal, planVersionId) => {
      if (!planVersionId) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<Envelope<PlanVersion>>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: planVersionId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  createEffect(() => { void missionId(); setSelectedId(""); void items.refresh({ force: true }); });
  const live = createMemo(() => (items.state().data ?? []).filter((item) => item.state !== "abandoned"));
  const selected = () => items.state().data?.find((item) => item.workItemId === selectedId());
  const reset = () => { setMove(""); setReason(""); setEvidence(""); setComment(""); };

  const taskOf = (item: WorkItem) => plan.state().data?.tasks.find((task) => task.id === item.planTaskId);
  const estimateOf = (item: WorkItem) => taskOf(item)?.estimatedMinutes;
  const ownerOf = (item: WorkItem): string | undefined => {
    const assignment = item.assignment ?? taskOf(item)?.assignment;
    if (!assignment) return undefined;
    const member = plan.state().data?.team?.find((entry) => entry.memberId === assignment.id);
    return member ? `${member.role} (${member.memberId})` : assignment.kind === "human" ? `${assignment.id} (person)` : assignment.id;
  };

  // Work others depend on needs a handoff before Done: one batch read for every item in review.
  const [handoffs] = createResource(
    () => {
      const review = live().filter((item) => item.state === "review" && live().some((other) => other.dependsOn.includes(item.workItemId)));
      return `${app.workspaceId()}|${review.map((item) => `${item.workItemId}@${item.version}`).join(",")}`;
    },
    async (key) => {
      const workspaceId = key.split("|")[0]!;
      const due = new Set<string>();
      const all = untrack(live);
      await Promise.all(all.filter((item) => key.includes(`${item.workItemId}@`)).map(async (item) => {
        const dependent = all.find((other) => other.dependsOn.includes(item.workItemId));
        if (!dependent) return;
        const received = await query<{ snapshot: { items: Handoff[] } }>({ queryType: "handoffs.forWorkItem", workspaceId, resourceId: dependent.workItemId });
        if (!received.snapshot.items.some((handoff) => handoff.workItemId === item.workItemId)) due.add(item.workItemId);
      }));
      return due;
    },
  );
  const handoffRequired = (item: WorkItem) => handoffs.latest?.has(item.workItemId) ?? false;

  const graph = createMemo(() => workGraph(live().map((item) => ({ id: item.workItemId, deps: item.dependsOn, weight: estimateOf(item) ?? 1, done: item.state === "done" }))));
  const critical = createMemo(() => new Set(graph().critical));

  const startHref = (item: WorkItem) => `/w/${app.workspaceId()}/plays?originKind=work-item&originId=${encodeURIComponent(item.workItemId)}`;
  const open = (item: WorkItem, then?: "handoff") => { reset(); setConflict(""); setSelectedId(item.workItemId); if (then) setSheet(then); };
  const act = (item: WorkItem, action: NextAction) => {
    if (action.kind === "start") void navigate(startHref(item));
    else if (action.kind === "follow") void navigate(missionHref(app.workspaceId(), missionId(), "live"));
    else open(item, action.kind === "handoff" ? "handoff" : undefined);
  };

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

  /** A board drag: the same governed transition, at the version the card was read at. */
  async function boardMove(item: WorkItem, to: BoardColumnId): Promise<string | undefined> {
    let refused: string | undefined;
    try {
      const result = await app.run("workItem.transition", { workItemId: item.workItemId, state: to }, { expectedVersion: item.version });
      if (!result.accepted) refused = result.detail ?? "The move was refused";
    } catch (error) {
      refused = error instanceof Error ? error.message : "The move was refused";
    }
    await items.refresh({ force: true });
    return refused;
  }

  async function addComment(item: WorkItem): Promise<void> {
    if (!comment().trim()) return;
    await app.run("workItem.comment", { workItemId: item.workItemId, text: comment().trim() });
    setComment(""); setSheet("");
  }

  const card = (item: WorkItem, showState: boolean) => <WorkCard item={item} items={live()} owner={ownerOf(item)} estimateMinutes={estimateOf(item)}
    handoffRequired={handoffRequired(item)} canDispatch={app.canDispatch()} critical={critical().has(item.workItemId) && item.state !== "done"} showState={showState}
    onOpen={() => open(item)} onAction={(action) => act(item, action)} />;

  const roadmapNodes = (): RoadmapNode[] => live().map((item) => ({ id: item.workItemId, title: item.title, deps: item.dependsOn, weight: estimateOf(item) ?? 1, done: item.state === "done" }));

  return <TaskSessionsContext.Provider value={() => sessions.state().data ?? []}><WorkspaceSection title="Mission work" description="Confirmed work items of this mission. Done requires independently verified evidence for every criterion.">
    <Show when={conflict() && sheet() !== "move"}><Alert theme="amber" variant="outline" title="This work changed; your intended move is preserved" description={conflict()} /></Show>
    <ScreenRegion state={items.state()} onRetry={() => void items.refresh({ force: true })} emptyTitle="No confirmed work yet" emptyDescription="Confirm a plan version to create this mission's work items.">
      <Show when={selected()} keyed fallback={<div class="flex min-w-0 flex-col gap-4">
        <WorkOverview mission={props.mission} items={live()} criticalSteps={graph().critical.length}
          criticalMinutes={graph().critical.every((id) => estimateOf(live().find((item) => item.workItemId === id)!) !== undefined) ? graph().criticalWeight : undefined} />
        <div class="flex flex-wrap items-center justify-between gap-2">
          <TabButtons label="How to show the work" value={view()} onValueChange={(value) => setSearch({ view: value === "timeline" ? undefined : value }, { replace: true })}
            options={VIEWS.map((entry) => ({ value: entry.value, label: entry.label, icon: entry.icon }))} />
          <p class="flex items-center gap-1.5 text-caption text-ink-gray-6"><span class="inline-block h-0.5 w-5 rounded-full bg-surface-blue-7" aria-hidden="true" />Critical path: the longest chain of work still to do</p>
        </div>
        <Switch>
          <Match when={view() === "timeline"}>
            <WorkRoadmap nodes={roadmapNodes()} label="Mission work by stage"
              renderNode={(node) => <Show when={live().find((item) => item.workItemId === node.id)}>{(item) => card(item(), true)}</Show>} />
          </Match>
          <Match when={view() === "board"}>
            <WorkBoard items={live()} ownerOf={ownerOf} estimateOf={estimateOf} handoffRequired={handoffRequired} canDispatch={app.canDispatch()}
              critical={critical()} onOpen={(item) => open(item)} onAction={act} onMove={boardMove} />
          </Match>
          <Match when={view() === "list"}>
            <ul class="flex flex-col divide-y divide-outline-gray-1 border-y border-outline-gray-1" aria-label="Work items">
              <For each={live()}>{(item) => <li class="py-3">{card(item, true)}</li>}</For>
            </ul>
          </Match>
        </Switch>
      </div>}>
        {(item) => {
          const handoff = createHandoffNeed(() => item);
          const verified = () => Boolean(item.evidenceDigest || evidence());
          const doneBlocked = () => move() === "done" && (!verified() || handoff.required());
          return <PageStack>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex flex-wrap items-center gap-2"><h3 class="text-base-medium">{item.title}</h3><StatusBadge kind="workItem" status={item.state} /><Badge variant="outline" theme={item.evidenceDigest ? "green" : "gray"} label={item.evidenceDigest ? "Verified evidence bound" : "Evidence required for Done"} /></div>
              <Button variant="ghost" iconLeft="lucide-arrow-left" onClick={() => setSelectedId("")}>Back to mission work</Button>
            </div>
            <Show when={item.parked}><ParkedActions item={item} onChanged={async () => { setSelectedId(""); await items.refresh({ force: true }); }} /></Show>
            <div class="border-y border-outline-gray-1 py-3"><h4 class="text-base-medium">Next action</h4><p class="mt-1 text-interface text-ink-gray-7">{item.nextAction}</p><Show when={item.blockedReason}><Alert theme="amber" variant="outline" title="Blocked" description={item.blockedReason} /></Show></div>
            <div><h4 class="text-base-medium">Acceptance criteria</h4><ul class="mt-2 list-disc ps-5 text-interface text-ink-gray-7"><For each={item.criteria}>{(criterion) => <li>{criterion}</li>}</For></ul></div>
            <Show when={item.evidenceDigest}><EvidenceList bundleDigest={item.evidenceDigest} /></Show>
            <Show when={handoff.required()}><Alert theme="amber" variant="outline" title="Other tasks are waiting on this one"
              description="Before it can be Done, hand off what was done to the next tasks. Brain adds the verified facts itself.">
              <Button variant="solid" theme="blue" iconLeft="lucide-send" onClick={() => setSheet("handoff")}>Hand off to the next tasks</Button>
            </Alert></Show>
            <WorkItemTasks origin={{ kind: "work-item", id: item.workItemId }} />
            <div class="flex flex-wrap gap-2 border-t border-outline-gray-1 pt-3">
              <Show when={item.state === "ready" && app.canDispatch()}><Button variant="solid" theme="blue" iconLeft="lucide-play" onClick={() => void navigate(startHref(item))}>Start this task</Button></Show>
              <Button variant="outline" iconLeft="lucide-arrow-right-left" onClick={() => { reset(); setSheet("move"); }}>Move work item</Button>
              <Button variant="outline" iconLeft="lucide-message-square" onClick={() => { setComment(""); setSheet("comment"); }}>Add comment</Button>
            </div>
            <FormSheet open={sheet() === "move"} onClose={() => setSheet("")} title={`Update ${item.title}`} description="Done requires independently verified evidence for every criterion."
              submit="Move work item" icon="lucide-arrow-right-left" error={conflict()} errorTitle="This work changed; your intended move is preserved" disabled={!move() || doneBlocked() || (move() === "blocked" && !reason().trim())} onSubmit={() => { if (move() && !doneBlocked()) return transition(item); }}>
              <EvidenceBundleSelector label={`Verified evidence for ${item.title}`} workItemId={item.workItemId} onSelect={setEvidence} />
              <Select label={`Move ${item.title}`} value={move() || null} options={STATES.filter((state) => state.id !== item.state).map((state) => ({ value: state.id, label: state.name, disabled: state.id === "done" && !verified() }))} onValueChange={(state) => setMove(state ?? "")} />
              <Show when={move() === "blocked"}><TextInput label="Blocking reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} required /></Show>
              <Show when={move() === "done" && handoff.required()}><Alert theme="amber" variant="outline" title="Hand off to the next tasks first" description="Other tasks depend on this one. Close this form and use Hand off to the next tasks on the work item." /></Show>
              <Show when={move() === "done" && !verified()}><Alert theme="amber" variant="outline" title="Verified evidence is required" description="Choose an independently verified evidence bundle before selecting Done. Author output alone cannot complete this work." /></Show>
            </FormSheet>
            <HandoffSheet item={item} open={sheet() === "handoff"} onClose={() => setSheet("")} onSubmitted={async () => { setSheet(""); await handoff.refresh(); await items.refresh({ force: true }); }} />
            <FormSheet open={sheet() === "comment"} onClose={() => setSheet("")} title="Add a comment" centered description="Comments are recorded on the work item's history." submit="Add comment" icon="lucide-message-square" disabled={!comment().trim()} onSubmit={() => addComment(item)}>
              <Textarea label="Comment" required value={comment()} onInput={(event) => setComment(event.currentTarget.value)} />
            </FormSheet>
          </PageStack>;
        }}
      </Show>
    </ScreenRegion>
  </WorkspaceSection></TaskSessionsContext.Provider>;
}

/** Progress, the critical path, time and budget: the four numbers that say whether the mission is on course. */
function WorkOverview(props: { mission: Mission; items: readonly WorkItem[]; criticalSteps: number; criticalMinutes?: number }): JSX.Element {
  const counts = () => {
    const out: Record<string, number> = {};
    for (const item of props.items) out[item.state] = (out[item.state] ?? 0) + 1;
    return out;
  };
  const done = () => counts().done ?? 0;
  const activeMinutes = () => props.mission.usage.activeMs / 60_000;
  const wallMinutes = () => (props.mission.budget.maxWallClockMs ?? 0) / 60_000;
  const timeShare = () => (wallMinutes() > 0 ? Math.min(100, Math.round((activeMinutes() / wallMinutes()) * 100)) : 0);
  return <section class="grid grid-cols-2 gap-x-4 gap-y-4 rounded-card border border-outline-gray-1 bg-surface-gray-1 p-3 sm:gap-x-6 sm:p-4 xl:grid-cols-4" aria-label="Mission work at a glance">
    <div class="col-span-2 flex min-w-0 flex-col gap-1.5 xl:col-span-1">
      <p class="flex items-center gap-1.5 text-caption font-medium text-ink-gray-6"><span class="lucide-circle-check size-3.5" aria-hidden="true" />Progress</p>
      <p class="text-base-medium text-ink-gray-9">{done()} of {props.items.length} verified done</p>
      <StateBar counts={counts()} label="Mission work" />
    </div>
    <div class="flex min-w-0 flex-col gap-1.5">
      <p class="flex items-center gap-1.5 text-caption font-medium text-ink-gray-6"><span class="lucide-route size-3.5" aria-hidden="true" />Critical path</p>
      <p class="text-base-medium text-ink-gray-9">{props.criticalSteps === 0 ? "Nothing left to do" : `${props.criticalSteps} ${props.criticalSteps === 1 ? "task" : "tasks"} in a row`}</p>
      <p class="text-caption text-ink-gray-6">{props.criticalSteps === 0 ? "Every task is verified done." : props.criticalMinutes !== undefined ? `About ${minutesText(props.criticalMinutes)} of estimated work on the longest chain.` : "The longest chain of work still to do sets the finish."}</p>
    </div>
    <div class="flex min-w-0 flex-col gap-1.5">
      <p class="flex items-center gap-1.5 text-caption font-medium text-ink-gray-6"><span class="lucide-timer size-3.5" aria-hidden="true" />Time</p>
      <p class="text-base-medium text-ink-gray-9">{minutesText(activeMinutes())} active{wallMinutes() > 0 ? ` of ${minutesText(wallMinutes())}` : ""}</p>
      <Show when={wallMinutes() > 0} fallback={<p class="text-caption text-ink-gray-6">No time limit is set for this mission.</p>}>
        <span role="progressbar" aria-label="Mission time used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={timeShare()} aria-valuetext={`${timeShare()}% of the time limit used`} class="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-gray-3">
          <span class={`h-full ${timeShare() >= 90 ? "bg-surface-amber-6" : "bg-surface-blue-9"}`} style={{ width: `${timeShare()}%` }} />
        </span>
      </Show>
    </div>
    <div class="flex min-w-0 flex-col gap-1.5">
      <p class="flex items-center gap-1.5 text-caption font-medium text-ink-gray-6"><span class="lucide-wallet size-3.5" aria-hidden="true" />Budget</p>
      <Show when={props.mission.budget.maxMicroUsd} fallback={<><p class="text-base-medium text-ink-gray-9">{formatUsd(props.mission.usage.settledMicroUsd + props.mission.usage.reservedMicroUsd)} spent</p><p class="text-caption text-ink-gray-6">No spending limit is set.</p></>}>
        {(limit) => <><p class="text-base-medium text-ink-gray-9">{formatUsd(props.mission.usage.settledMicroUsd + props.mission.usage.reservedMicroUsd)} of {formatUsd(limit())}</p>
          <Meter label="Mission budget" settled={props.mission.usage.settledMicroUsd} reserved={props.mission.usage.reservedMicroUsd} limit={limit()} format={formatUsd} /></>}
      </Show>
    </div>
  </section>;
}
