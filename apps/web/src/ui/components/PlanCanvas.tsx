import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { Mission, MissionPlanView, PlanTask } from "@brain/contracts";
import { useApp } from "../app-context";
import { governor } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { PageStack, TechnicalDetails } from "./PageLayout";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceSection } from "./Domain";

/**
 * The mission's planning canvas (T58, #25: plan creation and review live on
 * the mission's Plan tab). Brain prepares a strategy on request; a person
 * reviews and edits each step's outcome, criteria and dependencies, and an
 * explicit confirmation — proposing an edited version first — turns it into
 * tracked work. Nothing executes before that confirmation.
 */
export function PlanCanvas(props: { mission: Mission; onChanged: () => Promise<void> | void }): JSX.Element {
  const app = useApp();
  const [editedTasks, setEditedTasks] = createSignal<PlanTask[]>([]);
  const [dirty, setDirty] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [rejectReason, setRejectReason] = createSignal("");
  const proposal = createScopedRead<MissionPlanView | null>({
    scope: app.scope,
    load: async (scope, signal) => {
      try {
        const view = await governor<MissionPlanView>(`/v1/plans/${encodeURIComponent(props.mission.missionId)}?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal);
        return { snapshot: view, asOf: new Date().toISOString(), sourceWatermark: 0 };
      } catch (cause) {
        if (cause instanceof Error && /not found|no planning/i.test(cause.message)) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
        throw cause;
      }
    },
    isEmpty: (view) => view === null,
    refreshMs: 2000,
  });
  createEffect(() => {
    const plan = proposal.state().data?.plan;
    if (plan && !dirty()) setEditedTasks(plan.tasks.map((task) => ({ ...task, criteria: [...task.criteria], dependsOn: [...task.dependsOn] })));
  });
  async function generate() {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      await governor<MissionPlanView>("/v1/plans", { workspaceId: app.workspaceId(), requestId: `web-plan-${crypto.randomUUID()}`, missionId: props.mission.missionId });
      setDirty(false);
      await proposal.refresh({ force: true });
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
    if (!current?.planVersionId || busy()) return;
    setBusy(true); setError("");
    try {
      let planVersionId = current.planVersionId;
      if (dirty()) {
        const proposed = await app.run("plan.propose", { missionId: props.mission.missionId, origin: "manual", summary: current.plan?.summary, tasks: editedTasks() });
        if (!proposed.accepted || !proposed.resourceId) throw new Error(proposed.detail);
        planVersionId = proposed.resourceId;
      }
      const confirmed = await app.run("plan.confirm", { planVersionId }, { expectedVersion: props.mission.version });
      if (!confirmed.accepted) throw new Error(confirmed.detail);
      setDirty(false);
      await Promise.all([proposal.refresh({ force: true }), props.onChanged()]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Plan confirmation failed"); }
    finally { setBusy(false); }
  }
  async function reject(planVersionId: string) {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const result = await app.run("plan.reject", { planVersionId, reason: rejectReason().trim() });
      if (!result.accepted) throw new Error(result.detail);
      setRejectReason(""); setDirty(false);
      await Promise.all([proposal.refresh({ force: true }), props.onChanged()]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The rejection was refused"); }
    finally { setBusy(false); }
  }
  return <WorkspaceSection title="Proposal canvas" description="Review each expected outcome, acceptance criterion and dependency before confirming tracked work."
    actions={<Show when={app.canDispatch() && props.mission.state !== "closed"}><Button size="md" variant="outline" iconLeft="lucide-sparkles" loading={busy()} disabled={busy()} onClick={() => void generate()}>{proposal.state().data ? "Generate another strategy" : "Prepare plan proposal"}</Button></Show>}>
    <Show when={error()}><Alert theme="red" variant="outline" title="Planning action failed" description={error()} /></Show>
    <ScreenRegion state={proposal.state()} onRetry={() => void proposal.refresh()} emptyTitle="No plan proposal yet" emptyDescription="Ask Brain to prepare a strategy. Nothing becomes tracked work or executes before you confirm it.">
      <Show when={proposal.state().data?.state === "running"}><Alert theme="blue" variant="outline" title="Preparing a validated proposal" description="The mission is durable. No tasks have been created and no execution has started." /></Show>
      <Show when={proposal.state().data?.state === "failed"}><Alert theme="amber" variant="outline" title="No validated proposal yet" description={proposal.state().data?.error} /></Show>
      <Show when={proposal.state().data?.plan} keyed>{(plan) => <PageStack>
        <Alert theme={plan.state === "confirmed" ? "green" : "blue"} variant="outline" title={plan.state === "confirmed" ? "Human-confirmed tracked work" : "AI or manual proposal—not yet tracked"}
          description={plan.state === "confirmed" ? "This version has been confirmed. Its work items and acceptance evidence are managed below." : "Review and edit this strategy. Confirmation is a separate, explicit command against the mission's current version."} />
        <div><div class="flex flex-wrap items-center gap-2"><Badge variant="outline" theme="blue" label={`Plan revision ${plan.revision}`} /><StatusBadge kind="plan" status={plan.state} /><Show when={dirty()}><Badge theme="amber" label="Unsaved edits" /></Show></div>
          <p class="brain-prose mt-3 text-interface text-ink-gray-7">{plan.summary}</p></div>
        <div class="flex flex-col gap-3"><For each={editedTasks()}>{(task, index) => <article class="border-y border-outline-gray-1 py-3">
          <div class="mb-2 flex flex-wrap items-center gap-2"><span class="grid size-7 place-items-center rounded-full bg-surface-blue-2 text-caption font-medium text-ink-blue-8">{index() + 1}</span><Badge variant="outline" theme="gray" label={task.id} />
            <Show when={task.workflowId}><Badge variant="outline" theme="blue" label={task.workflowId!} /></Show><Show when={task.estimatedMinutes}><Badge variant="outline" theme="gray" label={`${task.estimatedMinutes} min estimate`} /></Show></div>
          <div class="brain-field-grid"><TextInput label={`Step ${index() + 1} expected outcome`} value={task.title} onInput={(event) => updateTask(index(), "title", event.currentTarget.value)} />
            <TextInput label="Depends on" value={task.dependsOn.join(", ")} description="Comma-separated task IDs; no dependency graph is inferred when empty" onInput={(event) => updateTask(index(), "dependsOn", event.currentTarget.value)} /></div>
          <Textarea label="Acceptance criteria" value={task.criteria.join("\n")} onInput={(event) => updateTask(index(), "criteria", event.currentTarget.value)} />
          <Show when={task.assignment}><p class="mt-2 text-caption text-ink-gray-6">Proposed assignment: {task.assignment?.kind} {task.assignment?.id} · {task.assignment?.role}</p></Show>
        </article>}</For></div>
        <div class="flex flex-wrap gap-3 border-t border-outline-gray-1 pt-4">
          <Button size="md" theme="blue" iconLeft="lucide-check-check" loading={busy()} disabled={busy() || !editedTasks().length || (plan.state === "confirmed" && !dirty())} onClick={() => void confirm()}>Confirm this plan</Button>
          <Show when={plan.state === "proposed"}><TextInput label="Why reject this proposal?" value={rejectReason()} onInput={(event) => setRejectReason(event.currentTarget.value)} />
            <Button size="md" variant="outline" theme="red" iconLeft="lucide-x" disabled={busy() || !rejectReason().trim()} onClick={() => void reject(plan.planVersionId)}>Reject proposal</Button></Show>
          <Button size="md" variant="outline" iconLeft="lucide-undo-2" disabled={!dirty()} onClick={() => { setDirty(false); setEditedTasks(plan.tasks.map((task) => ({ ...task }))); }}>Reset edits</Button>
        </div>
        <TechnicalDetails label="Plan version"><p class="break-all">{plan.planVersionId} · digest {plan.digest} · origin {plan.origin}</p></TechnicalDetails>
      </PageStack>}</Show>
    </ScreenRegion>
  </WorkspaceSection>;
}
