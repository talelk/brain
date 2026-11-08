import { For, Show } from "solid-js";
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
import { WorkspaceSection } from "./Domain";

function Draft(props: { id: string; workflows: readonly WorkflowCatalogEntry[]; onBack: () => void; onStarted: (handoff: TaskHandoff) => void }) {
  const app = useApp();
  const read = createScopedRead<TaskDraft>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<TaskDraft>(`/v1/tasks/drafts/${encodeURIComponent(props.id)}?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }) });
  const workflow = () => props.workflows.find((entry) => entry.release.id === read.state().data?.workflow.id);
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="Proposal unavailable" emptyDescription="Choose a task from the current catalog."><Show when={workflow()} keyed>{(entry) => <TaskReview workflow={entry} draft={read.state().data} origin={read.state().data?.origin} onBack={props.onBack} onStarted={props.onStarted} />}</Show><Show when={read.state().data && !workflow()}><Alert theme="amber" variant="outline" title="This proposal is no longer available" description="The drafted task is no longer part of the active release. Return to the catalog and choose a current task." /><Button size="md" variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Choose a task</Button></Show></ScreenRegion>;
}
function Origin(props: { origin: TaskOrigin; workflows: readonly WorkflowCatalogEntry[]; onBack: () => void; onStarted: (handoff: TaskHandoff) => void }) {
  const app = useApp();
  const read = createScopedRead<TaskContext>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<TaskContext>(`/v1/task-context?workspaceId=${encodeURIComponent(scope.workspaceId)}&kind=${props.origin.kind}&id=${encodeURIComponent(props.origin.id)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }) });
  const workflow = () => props.workflows.find((entry) => entry.release.id === read.state().data?.workflowId);
  return <ScreenRegion state={read.state()} onRetry={() => void read.refresh()} emptyTitle="Work item unavailable" emptyDescription="Return to Work to choose an accessible item."><Show when={workflow()} keyed>{(entry) => <TaskReview workflow={entry} initialInput={read.state().data?.input} origin={props.origin} onBack={props.onBack} onStarted={props.onStarted} />}</Show><Show when={read.state().data && !workflow()}><Alert theme="amber" variant="outline" title="No matching task is available in this release" description="The source context is present, but its task is not part of the active release. Return to the source and choose a current task." /><Button size="md" variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Choose a task</Button></Show></ScreenRegion>;
}

const MODES = [
  { id: "catalog", title: "Pick a play or task", icon: "lucide-layout-grid", description: "Start a mission from a play, or run a single task with typed inputs and explicit readiness." },
  { id: "ask", title: "Describe the work", icon: "lucide-sparkles", description: "Describe a goal; Brain proposes a published recipe for your review. Conversation never executes it." },
  { id: "work", title: "From a work item", icon: "lucide-link", description: "Keep the board item, ticket or incident linked to the new execution." },
] as const;

type StartMode = "ask" | "catalog" | "work";
type StepKey = "start" | "recipe" | "review";
interface Step { key: StepKey; label: string; state: "done" | "current" | "upcoming"; jump?: () => void }

/** The guided rail: pick or describe → published recipe → review & dispatch. */
function Steps(props: { steps: readonly Step[] }) {
  return <ol aria-label="Guided steps" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-gray-6">
    <For each={props.steps}>{(step, index) => <>
      <li>
        <Show when={step.jump} fallback={<span class="flex items-center gap-1.5" aria-current={step.state === "current" ? "step" : undefined}>
          <span class={`grid size-5 place-items-center rounded-full text-[11px] ${step.state === "current" ? "bg-surface-blue-2 text-ink-blue-8" : "bg-surface-gray-2 text-ink-gray-6"}`}>{index() + 1}</span>
          <span class={step.state === "current" ? "text-base-medium text-ink-gray-9" : ""}>{step.label}</span>
        </span>}>
          <button type="button" class="flex items-center gap-1.5 rounded-control px-1 hover:text-ink-gray-9" onClick={() => step.jump?.()}>
            <span class="grid size-5 place-items-center rounded-full bg-surface-blue-7 text-[11px] text-white"><span class="lucide-check size-3" aria-hidden="true" /></span>
            <span class="underline-offset-2 hover:underline">{step.label}</span>
          </button>
        </Show>
      </li>
      <Show when={index() < props.steps.length - 1}><li aria-hidden="true" class="lucide-chevron-right size-3.5 text-ink-gray-5" /></Show>
    </>}</For>
  </ol>;
}

export function TaskEntry(props: { workflows: readonly WorkflowCatalogEntry[]; catalog: JSX.Element; onStarted: (handoff: TaskHandoff) => void }) {
  const app = useApp(); const navigate = useNavigate(); const [params, setParams] = useSearchParams();
  let preference = "catalog"; try { preference = localStorage.getItem("brain.task-entry") ?? preference; } catch { /* preference storage is optional */ }
  const mode = (): StartMode => {
    if (typeof params.mode === "string" && MODES.some((entry) => entry.id === params.mode)) return params.mode as StartMode;
    if (typeof params.mode !== "string" && (params.q || params.diagnostics)) return "catalog";
    return preference as StartMode;
  };
  const origin = (): TaskOrigin | undefined => ["work-item", "ticket", "incident"].includes(String(params.originKind)) && typeof params.originId === "string" ? { kind: params.originKind as TaskOrigin["kind"], id: params.originId } : undefined;
  const draft = () => typeof params.draft === "string" && params.draft ? params.draft : "";
  const reviewing = () => Boolean(draft() || origin());
  const stepKey = (): StepKey => reviewing() ? "review" : mode() === "catalog" ? "recipe" : "start";
  function choose(value: StartMode) { try { localStorage.setItem("brain.task-entry", value); } catch { /* optional preference */ } setParams({ mode: value, draft: undefined, selected: undefined, originKind: undefined, originId: undefined }); }
  const jumpStart = () => setParams({ draft: undefined, selected: undefined, originKind: undefined, originId: undefined });
  const jumpRecipe = () => setParams({ draft: undefined, selected: undefined });
  const back = () => {
    const item = origin();
    if (item) { void navigate(item.kind === "work-item" ? `/w/${app.workspaceId()}/missions` : item.kind === "ticket" ? `/tickets/${item.id}` : `/incidents/${item.id}`); return; }
    if (draft()) { setParams({ draft: undefined }); return; }
    setParams({ selected: undefined });
  };
  const steps = (): Step[] => [
    { key: "start", label: "Start", state: stepKey() === "start" ? "current" : "done", ...(stepKey() === "start" ? {} : { jump: jumpStart }) },
    { key: "recipe", label: "Recipe", state: stepKey() === "recipe" ? "current" : stepKey() === "review" ? "done" : "upcoming", ...(stepKey() === "review" && !origin() ? { jump: jumpRecipe } : {}) },
    { key: "review", label: "Review & dispatch", state: stepKey() === "review" ? "current" : "upcoming" },
  ];
  return <div class="flex flex-col gap-4">
    <Steps steps={steps()} />
    <nav aria-label="Ways to start work" class="grid gap-2 md:grid-cols-3"><For each={MODES}>{(entry) => <button type="button" class="brain-selection-card" style={{ "min-height": "0", padding: "var(--spacing-3)", gap: "var(--spacing-1.5)" }} data-selected={mode() === entry.id} aria-pressed={mode() === entry.id} onClick={() => choose(entry.id)}>
      <span class={`grid size-8 place-items-center rounded-control ${mode() === entry.id ? "bg-surface-blue-2 text-ink-blue-8" : "bg-surface-gray-2 text-ink-gray-7"}`}><span class={`${entry.icon} size-4`} aria-hidden="true" /></span>
      <span class="text-base-medium text-ink-gray-9">{entry.title}</span><span class="text-caption text-ink-gray-6">{entry.description}</span>
    </button>}</For></nav>
    <Show when={draft()} keyed fallback={<Show when={origin()} keyed fallback={<>
      <Show when={mode() === "ask"}><Conversation onDraft={(id) => setParams({ draft: id })} /></Show>
      <Show when={mode() === "work"}><WorkspaceSection title="Advance an existing item" description="Choose the source first. Its current context and linkage are preserved when you configure the task.">
        <div class="grid gap-3 md:grid-cols-3"><For each={[
          { title: "Missions", description: "Continue work inside a mission.", icon: "lucide-flag", route: `/w/${app.workspaceId()}/missions` },
          { title: "Support tickets", description: "Investigate or draft from a customer request.", icon: "lucide-headset", route: `/w/${app.workspaceId()}/plays/support` },
          { title: "Incidents", description: "Start from an observed operational issue.", icon: "lucide-siren", route: `/w/${app.workspaceId()}/plays/sre` },
        ]}>{(item) => <button type="button" class="brain-selection-card" onClick={() => void navigate(item.route)}><span class={`${item.icon} size-5 text-ink-blue-8`} aria-hidden="true" /><span class="text-base-medium">{item.title}</span><span class="text-caption text-ink-gray-6">{item.description}</span></button>}</For></div>
      </WorkspaceSection></Show>
      <Show when={mode() === "catalog"}>{props.catalog}</Show>
    </>}>{(item) => <Origin origin={item} workflows={props.workflows} onBack={back} onStarted={props.onStarted} />}</Show>}>{(id) => <Draft id={id} workflows={props.workflows} onBack={back} onStarted={props.onStarted} />}</Show>
  </div>;
}
