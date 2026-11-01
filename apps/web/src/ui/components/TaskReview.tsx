import { For, Show, createSignal } from "solid-js";
import { Badge, Button } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { JsonValue, TaskDraft, TaskOrigin, WorkflowCatalogEntry, OperationalReadiness } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { governor } from "../../data/client";
import { SchemaForm } from "./SchemaForm";
import type { InputSchema } from "./SchemaForm";
import { StructuredOutputView } from "./StructuredOutputView";
import { ActionFeedback } from "./ActionFeedback";
import { FactStrip, WorkspaceSection } from "./Domain";
import { PageStack, TechnicalDetails } from "./PageLayout";

export function TaskReview(props: { workflow: WorkflowCatalogEntry; initialInput?: JsonValue; origin?: TaskOrigin; draft?: TaskDraft; onBack: () => void; onStarted: (id: string) => void }) {
  const app = useApp();
  const [draft, setDraft] = createSignal<TaskDraft | undefined>(props.draft);
  const [seed, setSeed] = createSignal<JsonValue>(props.draft?.input ?? props.initialInput ?? {});
  const [revision, setRevision] = createSignal(0);
  const [error, setError] = createSignal(""); const [busy, setBusy] = createSignal(false);
  const readiness = createScopedRead<OperationalReadiness>({ scope: app.scope, load: async (scope, signal) => { const snapshot = await governor<OperationalReadiness>(`/v1/doctor?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal); return { snapshot, asOf: snapshot.asOf, sourceWatermark: 0 }; } });
  const blockers = () => readiness.state().data?.checks.filter((check) => check.status === "missing" && ["model", "release", `workflow:${props.workflow.release.id}`].includes(check.id)) ?? [];
  const presentation = () => props.workflow.definition.spec.presentation;
  const title = () => presentation()?.title ?? props.workflow.release.id.replaceAll("-", " ");
  const external = () => Object.values(props.workflow.definition.spec.jobs).some((job) => "effectClass" in job && job.effectClass !== "read");
  const workspaceName = () => app.workspaceOptions().find((workspace) => workspace.value === app.workspaceId())?.label ?? app.workspaceId();
  async function prepare(input: Record<string, unknown>) {
    setBusy(true); setError("");
    try { setSeed(input as JsonValue); setDraft(await governor<TaskDraft>("/v1/tasks/drafts", { workspaceId: app.workspaceId(), workflowId: props.workflow.release.id, input, ...(props.origin ? { origin: props.origin } : {}) })); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not prepare the task."); }
    finally { setBusy(false); }
  }
  async function start() {
    const exact = draft(); if (!exact || busy()) return;
    setBusy(true); setError("");
    try {
      const accepted = await governor<TaskDraft>(`/v1/tasks/drafts/${encodeURIComponent(exact.id)}/start`, { workspaceId: app.workspaceId() });
      if (accepted.runId) props.onStarted(accepted.runId);
    } catch (e) { setError(`${e instanceof Error ? e.message : "Acceptance could not be confirmed."} Starting this same review again recovers its existing run if it was already accepted.`); }
    finally { setBusy(false); }
  }
  return <PageStack>
    <WorkspaceSection title={title()} description={presentation()?.description ?? "Complete the validated inputs, review the exact task, then start it."} actions={<Button size="lg" variant="ghost" iconLeft="lucide-arrow-left" onClick={props.onBack}>Back</Button>}>
      <div class="flex flex-wrap gap-2"><Badge variant="outline" theme={external() ? "amber" : "blue"} label={external() ? "Governed external effects" : "Read / draft outcome"} /><Show when={props.origin}><Badge variant="outline" theme="blue" label={`Linked ${props.origin?.kind}: ${props.origin?.id}`} /></Show></div>
    </WorkspaceSection>
    <FactStrip label="Task launch facts" items={[
      { label: "Workspace", value: workspaceName(), hint: "Authorization and placement scope", icon: "lucide-building-2" },
      { label: "Expected result", value: "Structured output", hint: "Checked against the active output schema", icon: "lucide-package-check" },
      { label: "Cost", value: "Not estimated", hint: "Declared budgets and workspace limits still apply", icon: "lucide-wallet-cards" },
    ]} />
    <Alert theme={external() ? "amber" : "blue"} variant="outline" title={external() ? "Execution can propose external changes" : "Analysis, not automatic publication"}
      description={external() ? "Declared approvals and independent checks remain required before any external effect. Starting this task grants no blanket authority." : "This task can produce an analysis or draft. It does not publish a response, execute remediation, or approve its own result."} />
    <Show when={blockers().length}><Alert theme="amber" variant="outline" title="This task may wait before it can run" description={<ul class="ml-4 list-disc"><For each={blockers()}>{(check) => <li>{check.detail} · {check.nextAction}</li>}</For></ul>} /></Show>
    <Show when={draft()} keyed fallback={<WorkspaceSection title="Configure inputs" description="Fields and validation come from the active workflow schema. No unavailable launch fields are inferred.">
      <Show when={presentation()?.examples?.length}><div class="mb-4 flex flex-wrap gap-2"><For each={presentation()?.examples}>{(example, index) => <Button size="lg" variant="outline" onClick={() => { setSeed(example); setRevision((value) => value + 1); }}>Use example {index() + 1}</Button>}</For></div></Show>
      <SchemaForm schema={(props.workflow.inputSchema ?? {}) as InputSchema} schemaKey={`${props.workflow.release.digest}:${revision()}`} initialInput={seed()} submitLabel="Review task" busy={busy()} disabled={!app.canDispatch()} error={error()} onSubmit={prepare} />
    </WorkspaceSection>}>{(review) => <WorkspaceSection title="Review before starting" description="This is the exact reviewed draft. Starting it once recovers the same run if the response is lost.">
      <div class="border-y border-outline-gray-1 py-4"><StructuredOutputView value={review.input} /></div>
      <Alert theme="blue" variant="outline" title="Queued does not mean complete" description="After durable acceptance you will open the actual run. Queue, placement, author output and independent verification remain separate states." />
      <ActionFeedback tone="error" message={error()} />
      <div class="flex flex-wrap gap-2"><Button size="lg" disabled={!app.canDispatch() || busy()} loading={busy()} iconLeft="lucide-play" onClick={() => void start()}>Start task</Button><Button size="lg" variant="outline" disabled={busy()} onClick={() => { setSeed(review.input); setDraft(undefined); setRevision((value) => value + 1); setError(""); }}>Edit inputs</Button></div>
    </WorkspaceSection>}</Show>
    <Show when={!app.canDispatch()}><Alert theme="gray" variant="outline" title="Read-only access" description="Your current role can inspect this task but cannot start it." /></Show>
    <TechnicalDetails label="Release, output schema, and execution declarations"><p class="break-all">Release: {props.workflow.configDigest}</p><h3 class="mt-3 text-base-medium">Output schema</h3><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption">{JSON.stringify(props.workflow.outputSchema, null, 2)}</pre><h3 class="mt-3 text-base-medium">Declared steps</h3><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption">{JSON.stringify(props.workflow.definition.spec.jobs, null, 2)}</pre></TechnicalDetails>
  </PageStack>;
}
