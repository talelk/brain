import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { TaskContext, TaskDraft, TaskOrigin, WorkflowCatalogEntry } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { governor } from "../../data/client";
import { ScreenRegion } from "../screen-region";
import { Conversation } from "./Conversation";
import { TaskReview } from "./TaskReview";
import type { TaskHandoff } from "./TaskReview";
function Draft(props: { id: string; workflows: readonly WorkflowCatalogEntry[]; onBack: () => void; onStarted: (handoff: TaskHandoff) => void }) {
  const app = useApp();
  const read = createScopedRead<TaskDraft>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<TaskDraft>(`/v1/tasks/drafts/${encodeURIComponent(props.id)}?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }) });
  const workflow = () => props.workflows.find((entry) => entry.release.id === read.state().data?.workflow.id);
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="Proposal unavailable" emptyDescription="Choose a task from the current catalog."><Show when={workflow()} keyed>{(entry) => <TaskReview workflow={entry} draft={read.state().data} origin={read.state().data?.origin} onBack={props.onBack} onStarted={props.onStarted} />}</Show><Show when={read.state().data && !workflow()}><Alert theme="amber" variant="outline" title="This proposal is no longer available" description="The drafted task is no longer part of the active release. Return to the catalog and choose a current task." /><Button variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Choose a task</Button></Show></ScreenRegion>;
}
function Origin(props: { origin: TaskOrigin; workflows: readonly WorkflowCatalogEntry[]; onBack: () => void; onStarted: (handoff: TaskHandoff) => void }) {
  const app = useApp();
  const read = createScopedRead<TaskContext>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<TaskContext>(`/v1/task-context?workspaceId=${encodeURIComponent(scope.workspaceId)}&kind=${props.origin.kind}&id=${encodeURIComponent(props.origin.id)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }) });
  const workflow = () => props.workflows.find((entry) => entry.release.id === read.state().data?.workflowId);
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="Work item unavailable" emptyDescription="Return to Work to choose an accessible item."><Show when={workflow()} keyed>{(entry) => <TaskReview workflow={entry} initialInput={read.state().data?.input} origin={props.origin} onBack={props.onBack} onStarted={props.onStarted} />}</Show><Show when={read.state().data && !workflow()}><Alert theme="amber" variant="outline" title="No matching task is available in this release" description="The source context is present, but its task is not part of the active release. Return to the source and choose a current task." /><Button variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Choose a task</Button></Show></ScreenRegion>;
}

/**
 * Task entry: one surface. Reviewing a draft or a work-item/ticket/incident origin shows the typed-input
 * review; describing a goal (`mode=ask`) shows the conversation; otherwise the catalog (with its one
 * pick-or-describe search box) is shown. There is no mode picker: typing in the search box offers
 * matching plays/tasks and a "describe it" path.
 */
export function TaskEntry(props: { workflows: readonly WorkflowCatalogEntry[]; catalog: JSX.Element; onStarted: (handoff: TaskHandoff) => void }) {
  const app = useApp(); const navigate = useNavigate(); const [params, setParams] = useSearchParams();
  const origin = (): TaskOrigin | undefined => ["work-item", "ticket", "incident"].includes(String(params.originKind)) && typeof params.originId === "string" ? { kind: params.originKind as TaskOrigin["kind"], id: params.originId } : undefined;
  const draft = () => typeof params.draft === "string" && params.draft ? params.draft : "";
  const describing = () => params.mode === "ask";
  const back = () => {
    const item = origin();
    if (item) { void navigate(item.kind === "work-item" ? `/w/${app.workspaceId()}/missions` : item.kind === "ticket" ? `/tickets/${item.id}` : `/incidents/${item.id}`); return; }
    if (draft()) { setParams({ draft: undefined }); return; }
    setParams({ mode: undefined, conversation: undefined, goal: undefined, selected: undefined });
  };
  return <div class="flex flex-col gap-4">
    <Show when={describing() && !draft() && !origin()}><Button variant="ghost" iconLeft="lucide-arrow-left" class="self-start" onClick={back}>Back to plays and tasks</Button></Show>
    <Show when={draft()} keyed fallback={<Show when={origin()} keyed fallback={<Show when={describing()} fallback={props.catalog}><Conversation onDraft={(id) => setParams({ draft: id })} /></Show>}>{(item) => <Origin origin={item} workflows={props.workflows} onBack={back} onStarted={props.onStarted} />}</Show>}>{(id) => <Draft id={id} workflows={props.workflows} onBack={back} onStarted={props.onStarted} />}</Show>
  </div>;
}
