import { For, Show, createSignal } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import type { JsonValue, TaskDraft, TaskOrigin, WorkflowCatalogEntry, OperationalReadiness } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { governor } from "../../data/client";
import { SchemaForm } from "./SchemaForm";
import type { InputSchema } from "./SchemaForm";
import { StructuredOutputView } from "./StructuredOutputView";
import { ActionFeedback } from "./ActionFeedback";

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
  return <div class="flex flex-col gap-field-gap">
    <Section title={title()} description={presentation()?.description ?? "Complete the inputs, review the task, then start it."} surface="card" actions={<Button size="lg" variant="ghost" onClick={props.onBack}>Back</Button>}>
      <Show when={draft()} keyed fallback={<>
        <Show when={presentation()?.examples?.length}><div class="mb-4 flex flex-wrap gap-2"><For each={presentation()?.examples}>{(example, index) => <Button size="lg" variant="outline" onClick={() => { setSeed(example); setRevision((value) => value + 1); }}>Use example {index() + 1}</Button>}</For></div></Show>
        <SchemaForm schema={(props.workflow.inputSchema ?? {}) as InputSchema} schemaKey={`${props.workflow.release.digest}:${revision()}`} initialInput={seed()} submitLabel="Review task" busy={busy()} disabled={!app.canDispatch()} error={error()} onSubmit={prepare} />
      </>}>{(review) => <div class="flex flex-col gap-4">
        <h3 class="text-heading">Review before starting</h3>
        <p><strong>Workspace:</strong> {app.workspaceOptions().find((workspace) => workspace.value === app.workspaceId())?.label ?? "Selected workspace"}</p>
        <p>{external() ? "This task can propose external changes. Its declared approvals and checks remain required before any effect." : "This task produces an analysis or draft. It does not publish a response or execute a remediation."}</p>
        <Show when={blockers().length}><div role="status"><strong>This task may wait before it can run</strong><For each={blockers()}>{(check) => <p>{check.detail} · {check.nextAction}</p>}</For></div></Show>
        <p>Cost estimate unavailable. Declared agent budgets and workspace limits apply.</p>
        <StructuredOutputView value={review.input} />
        <p>Results require independent validation. Starting a task does not approve any proposed external effect.</p>
        <ActionFeedback tone="error" message={error()} />
        <div class="flex flex-wrap gap-2"><Button size="lg" disabled={!app.canDispatch() || busy()} loading={busy()} onClick={() => void start()}>Start task</Button><Button size="lg" variant="outline" disabled={busy()} onClick={() => { setSeed(review.input); setDraft(undefined); setRevision((value) => value + 1); setError(""); }}>Edit inputs</Button></div>
      </div>}</Show>
      <Show when={!app.canDispatch()}><p>Your current role can inspect this task but cannot start it.</p></Show>
      <details class="mt-4"><summary class="cursor-pointer">Technical details</summary><p class="break-all">Release: {props.workflow.configDigest}</p><pre class="whitespace-pre-wrap break-words text-caption">{JSON.stringify(props.workflow.definition.spec.jobs, null, 2)}</pre></details>
    </Section>
  </div>;
}
