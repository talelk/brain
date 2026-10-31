import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import type { TaskContext, TaskDraft, TaskOrigin, WorkflowCatalogEntry } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { governor } from "../../data/client";
import { ScreenRegion } from "../screen-region";
import { Conversation } from "./Conversation";
import { TaskReview } from "./TaskReview";

function Draft(props: { id: string; workflows: readonly WorkflowCatalogEntry[]; onBack: () => void; onStarted: (id: string) => void }) {
  const app = useApp();
  const read = createScopedRead<TaskDraft>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<TaskDraft>(`/v1/tasks/drafts/${encodeURIComponent(props.id)}?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }) });
  const workflow = () => props.workflows.find((entry) => entry.release.id === read.state().data?.workflow.id);
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="Proposal unavailable" emptyDescription="Choose a task from the current catalog."><Show when={workflow()} keyed>{(entry) => <TaskReview workflow={entry} draft={read.state().data} origin={read.state().data?.origin} onBack={props.onBack} onStarted={props.onStarted} />}</Show><Show when={read.state().data && !workflow()}><p>This task is no longer available. Return to the catalog and choose a current task.</p><Button size="lg" onClick={props.onBack}>Choose a task</Button></Show></ScreenRegion>;
}
function Origin(props: { origin: TaskOrigin; workflows: readonly WorkflowCatalogEntry[]; onBack: () => void; onStarted: (id: string) => void }) {
  const app = useApp();
  const read = createScopedRead<TaskContext>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<TaskContext>(`/v1/task-context?workspaceId=${encodeURIComponent(scope.workspaceId)}&kind=${props.origin.kind}&id=${encodeURIComponent(props.origin.id)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }) });
  const workflow = () => props.workflows.find((entry) => entry.release.id === read.state().data?.workflowId);
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="Work item unavailable" emptyDescription="Return to Work to choose an accessible item."><Show when={workflow()} keyed>{(entry) => <TaskReview workflow={entry} initialInput={read.state().data?.input} origin={props.origin} onBack={props.onBack} onStarted={props.onStarted} />}</Show><Show when={read.state().data && !workflow()}><p>No matching task is available in this release.</p></Show></ScreenRegion>;
}
export function TaskEntry(props: { workflows: readonly WorkflowCatalogEntry[]; catalog: JSX.Element; onStarted: (id: string) => void }) {
  const app = useApp(); const navigate = useNavigate(); const [params, setParams] = useSearchParams();
  let preference = "catalog"; try { preference = localStorage.getItem("brain.task-entry") ?? preference; } catch { /* preference storage is optional */ }
  const mode = () => typeof params.mode === "string" ? params.mode : params.selected || params.diagnostics ? "catalog" : preference;
  const origin = (): TaskOrigin | undefined => ["work-item", "ticket", "incident"].includes(String(params.originKind)) && typeof params.originId === "string" ? { kind: params.originKind as TaskOrigin["kind"], id: params.originId } : undefined;
  function choose(value: string) { try { localStorage.setItem("brain.task-entry", value); } catch { /* optional preference */ } setParams({ mode: value, draft: undefined, selected: undefined, originKind: undefined, originId: undefined }); }
  const back = () => { const item = origin(); if (item) void navigate(item.kind === "work-item" ? `/w/${app.workspaceId()}/board?card=${encodeURIComponent(item.id)}` : item.kind === "ticket" ? `/tickets/${item.id}` : `/incidents/${item.id}`); else setParams({ draft: undefined }); };
  return <div class="flex flex-col gap-field-gap">
    <nav aria-label="Ways to start work" class="flex flex-wrap gap-2"><For each={[{ id: "ask", title: "Ask Brain" }, { id: "catalog", title: "Choose a task" }, { id: "work", title: "From a work item" }]}>{(entry) => <Button size="lg" variant={mode() === entry.id ? "solid" : "outline"} onClick={() => choose(entry.id)}>{entry.title}</Button>}</For></nav>
    <Show when={typeof params.draft === "string" && params.draft} keyed fallback={<Show when={origin()} keyed fallback={<>
      <Show when={mode() === "ask"}><Conversation onDraft={(id) => setParams({ draft: id })} /></Show>
      <Show when={mode() === "work"}><Section title="Choose the work you want to advance" description="Open an item, then select Start a task for this item. Known information is prefilled for your review." surface="card"><div class="flex flex-wrap gap-3"><Button size="lg" onClick={() => void navigate(`/w/${app.workspaceId()}/board`)}>Workboard</Button><Button size="lg" onClick={() => void navigate(`/w/${app.workspaceId()}/support`)}>Support tickets</Button><Button size="lg" onClick={() => void navigate(`/w/${app.workspaceId()}/sre`)}>Incidents</Button></div></Section></Show>
      <Show when={!["ask", "work"].includes(mode())}>{props.catalog}</Show>
    </>}>{(item) => <Origin origin={item} workflows={props.workflows} onBack={back} onStarted={props.onStarted} />}</Show>}>{(id) => <Draft id={id} workflows={props.workflows} onBack={back} onStarted={props.onStarted} />}</Show>
  </div>;
}
