import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import { Alert } from "@talelk/newui-molecules";
import type { ObjectivePlanView, PlanTask, WorkBoardView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { governor, query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { SelectableListItem } from "../../ui/components/primitives";

export default function PlansPage(): JSX.Element {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const selectedId = () => typeof params.objective === "string" ? params.objective : "";
  const [title, setTitle] = createSignal("");
  const [intent, setIntent] = createSignal("");
  const [criteria, setCriteria] = createSignal("");
  const [editedTasks, setEditedTasks] = createSignal<PlanTask[]>([]);
  const [dirty, setDirty] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const board = createScopedRead<WorkBoardView>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: WorkBoardView; asOf: string; sourceWatermark: number }>({ queryType: "workBoard.get", workspaceId: scope.workspaceId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.objectives.length === 0,
    refreshMs: 15_000,
  });
  const proposal = createScopedRead<ObjectivePlanView | null>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!selectedId()) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const view = await governor<ObjectivePlanView>(`/v1/plans/${encodeURIComponent(selectedId())}?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal);
      return { snapshot: view, asOf: new Date().toISOString(), sourceWatermark: 0 };
    },
    isEmpty: (view) => view === null,
    refreshMs: 2000,
  });
  createEffect(() => {
    const plan = proposal.state().data?.plan;
    if (plan && !dirty()) setEditedTasks(plan.tasks.map((task) => ({ ...task, criteria: [...task.criteria], dependsOn: [...task.dependsOn] })));
  });

  async function start(objectiveId?: string) {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const requestId = `web-plan-${crypto.randomUUID()}`;
      const started = await governor<ObjectivePlanView>("/v1/plans", {
        workspaceId: app.workspaceId(), requestId,
        ...(objectiveId ? { objectiveId } : { title: title().trim(), intent: intent().trim(), successCriteria: criteria().split("\n").map((item) => item.trim()).filter(Boolean) }),
      });
      setParams({ objective: started.objectiveId });
      await proposal.refresh({ force: true });
      if (!objectiveId) { setTitle(""); setIntent(""); setCriteria(""); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Plan generation failed"); }
    finally { setBusy(false); }
  }

  function updateTask(index: number, field: "title" | "criteria" | "dependsOn", value: string) {
    setDirty(true);
    setEditedTasks((tasks) => tasks.map((task, position) => position === index ? {
      ...task,
      ...(field === "title" ? { title: value } : field === "criteria" ? { criteria: value.split("\n").map((item) => item.trim()).filter(Boolean) } : { dependsOn: value.split(",").map((item) => item.trim()).filter(Boolean) }),
    } : task));
  }

  async function confirm() {
    const current = proposal.state().data;
    const objective = board.state().data?.objectives.find((item) => item.objectiveId === selectedId());
    if (!current?.planVersionId || !objective || busy()) return;
    setBusy(true); setError("");
    try {
      let planVersionId = current.planVersionId;
      if (dirty()) {
        const proposed = await app.run("plan.propose", { objectiveId: selectedId(), origin: "manual", summary: current.plan?.summary, tasks: editedTasks() });
        if (!proposed.accepted || !proposed.resourceId) throw new Error(proposed.detail);
        planVersionId = proposed.resourceId;
      }
      const confirmed = await app.run("plan.confirm", { planVersionId }, { expectedVersion: objective.version });
      if (!confirmed.accepted) throw new Error(confirmed.detail);
      setDirty(false);
      await Promise.all([board.refresh({ force: true }), proposal.refresh({ force: true })]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Plan confirmation failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title="Plans" description="Describe an outcome, review the proposed strategy and turn one explicit version into tracked work."
    actions={<Button size="lg" variant="outline" disabled={!selectedId() || busy()} onClick={() => void start(selectedId())}>Generate another strategy</Button>}>
    <PageStack>
      <Section title="Ask Brain for a plan" description="The agent proposes tasks only. Nothing enters the board or starts execution before your confirmation." surface="card">
        <div class="brain-field-grid">
          <TextInput label="Objective" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Stabilize authentication" />
          <TextInput label="Success criteria" value={criteria()} onInput={(event) => setCriteria(event.currentTarget.value)} description="One criterion per line" placeholder="Sessions remain valid" />
        </div>
        <Textarea label="What do you want to accomplish?" value={intent()} onInput={(event) => setIntent(event.currentTarget.value)} placeholder="Analyze the application, distribute the investigation and verify the results." />
        <Button size="lg" theme="blue" loading={busy()} disabled={busy() || !title().trim() || !intent().trim() || !criteria().trim() || !app.canDispatch()} onClick={() => void start()}>Create the work</Button>
      </Section>

      <Show when={error()}><Alert theme="red" variant="outline" title="Planning action failed" description={error()} /></Show>
      <ScreenRegion state={board.state()} onRetry={() => void board.refresh()} emptyTitle="No objectives yet" emptyDescription="Start with an intention above. Brain will prepare a reviewable strategy.">
        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Section title="Objectives" description="Select an objective to inspect its current proposal." surface="card">
            <div class="flex flex-col gap-2"><For each={board.state().data?.objectives}>{(objective) => <SelectableListItem onClick={() => { setDirty(false); setParams({ objective: objective.objectiveId }); void proposal.refresh({ force: true }); }}>
              <strong>{objective.title}</strong><span class="mt-1 block text-caption text-ink-gray-6">v{objective.version} · {objective.successCriteria.length} success criteria</span>
            </SelectableListItem>}</For></div>
          </Section>
          <Section title="Plan proposal" description="Edit titles, criteria and dependencies before confirming this version." surface="card">
            <Show when={selectedId()} fallback={<p class="text-ink-gray-7">Choose an objective or create a new plan.</p>}>
              <ScreenRegion state={proposal.state()} onRetry={() => void proposal.refresh()} emptyTitle="No planning request" emptyDescription="Generate a strategy for this objective.">
                <Show when={proposal.state().data?.state === "running"}><p role="status">Brain is preparing and independently validating a plan. The objective is durable; no tasks have been created.</p></Show>
                <Show when={proposal.state().data?.state === "failed"}><Alert theme="amber" variant="outline" title="No validated proposal yet" description={proposal.state().data?.error} /></Show>
                <Show when={proposal.state().data?.plan} keyed>{(plan) => <div class="flex flex-col gap-4">
                  <p class="text-ink-gray-7">{plan.summary}</p>
                  <For each={editedTasks()}>{(task, index) => <article class="grid gap-3 rounded-card border border-outline-gray-2 p-4 lg:grid-cols-2">
                    <TextInput label={`Task ${index() + 1}`} value={task.title} onInput={(event) => updateTask(index(), "title", event.currentTarget.value)} />
                    <TextInput label="Depends on" value={task.dependsOn.join(", ")} description="Comma-separated task IDs" onInput={(event) => updateTask(index(), "dependsOn", event.currentTarget.value)} />
                    <Textarea label="Success criteria" value={task.criteria.join("\n")} onInput={(event) => updateTask(index(), "criteria", event.currentTarget.value)} />
                    <div class="flex flex-wrap content-start gap-2"><Badge theme="gray" label={task.id} /><Show when={task.assignment}><Badge theme="blue" label={`${task.assignment?.kind}: ${task.assignment?.id}`} /></Show><Show when={task.workflowId}><Badge theme="gray" label={task.workflowId} /></Show></div>
                  </article>}</For>
                  <div class="flex flex-wrap gap-3"><Button size="lg" theme="blue" loading={busy()} disabled={busy() || !editedTasks().length} onClick={() => void confirm()}>Confirm this plan</Button><Button size="lg" variant="outline" onClick={() => { setDirty(false); setEditedTasks(plan.tasks.map((task) => ({ ...task }))); }}>Reset edits</Button></div>
                </div>}</Show>
              </ScreenRegion>
            </Show>
          </Section>
        </div>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
