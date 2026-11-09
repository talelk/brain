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
import { FormSheet } from "./BrainForm";
import { ReasonDialog } from "./ReasonDialog";

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
  const [editOpen, setEditOpen] = createSignal(false);
  const [rejectOpen, setRejectOpen] = createSignal(false);
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
      setRejectReason(""); setDirty(false); setRejectOpen(false);
      await Promise.all([proposal.refresh({ force: true }), props.onChanged()]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The rejection was refused"); }
    finally { setBusy(false); }
  }
  return <WorkspaceSection title="Proposal canvas" description="Review each expected outcome, acceptance criterion and dependency before confirming tracked work."
    actions={<Show when={app.canDispatch() && props.mission.state !== "closed"}><Button variant="outline" iconLeft="lucide-sparkles" loading={busy()} disabled={busy()} onClick={() => void generate()}>{proposal.state().data ? "Generate another strategy" : "Prepare plan proposal"}</Button></Show>}>
    <Show when={error()}><Alert theme="red" variant="outline" title="Planning action failed" description={error()} /></Show>
    <ScreenRegion state={proposal.state()} onRetry={() => void proposal.refresh()} emptyTitle="No plan proposal yet" emptyDescription="Ask Brain to prepare a strategy. Nothing becomes tracked work or executes before you confirm it.">
      <Show when={proposal.state().data?.state === "running"}><Alert theme="blue" variant="outline" title="Preparing a validated proposal" description="The mission is durable. No tasks have been created and no execution has started." /></Show>
      <Show when={proposal.state().data?.state === "failed"}><Alert theme="amber" variant="outline" title="No validated proposal yet" description={proposal.state().data?.error} /></Show>
      <Show when={proposal.state().data?.plan} keyed>{(plan) => <PageStack>
        <Alert theme={plan.state === "confirmed" ? "green" : "blue"} variant="outline" title={plan.state === "confirmed" ? "Human-confirmed tracked work" : "AI or manual proposal—not yet tracked"}
          description={plan.state === "confirmed" ? "This version has been confirmed and its work items were created below. Nothing runs until you start a task: start each ready task, then follow it in Live." : "Review and edit this strategy. Confirmation is a separate, explicit command against the mission's current version."} />
        <div><div class="flex flex-wrap items-center gap-2"><Badge variant="outline" theme="blue" label={`Plan revision ${plan.revision}`} /><StatusBadge kind="plan" status={plan.state} /><Show when={dirty()}><Badge theme="amber" label="Unsaved edits" /></Show></div>
          <p class="brain-prose mt-3 text-interface text-ink-gray-7">{plan.summary}</p></div>
        <ol class="flex flex-col gap-2" aria-label="Plan steps"><For each={editedTasks()}>{(task, index) => <li class="flex gap-3 border-b border-outline-gray-1 pb-3">
          <span class="grid size-7 shrink-0 place-items-center rounded-full bg-surface-blue-2 text-caption font-medium text-ink-blue-8">{index() + 1}</span>
          <div class="min-w-0"><p class="break-words text-base-medium text-ink-gray-9">{task.title}</p>
            <Show when={task.criteria.length}><ul class="mt-1 list-disc ps-5 text-interface text-ink-gray-7"><For each={task.criteria}>{(criterion) => <li>{criterion}</li>}</For></ul></Show>
            <p class="mt-1 flex flex-wrap gap-x-3 text-caption text-ink-gray-6"><span>{task.id}</span><Show when={task.dependsOn.length}><span>after {task.dependsOn.join(", ")}</span></Show><Show when={task.assignment}><span>{task.assignment?.kind} {task.assignment?.id} · {task.assignment?.role}</span></Show><Show when={task.workflowId}><span>{task.workflowId}</span></Show><Show when={task.estimatedMinutes}><span>{task.estimatedMinutes} min</span></Show></p></div>
        </li>}</For></ol>
        <FormSheet size="xl" open={editOpen()} onClose={() => setEditOpen(false)} title="Edit the plan steps" description="Edits become a new plan revision when you confirm. Nothing is tracked or executed before that." submit="Keep edits" icon="lucide-check" onSubmit={() => { setEditOpen(false); }}>
          <For each={editedTasks()}>{(task, index) => <section class="flex flex-col gap-3 border-b border-outline-gray-1 pb-4" aria-label={`Step ${index() + 1}`}>
          <div class="flex flex-col gap-3"><TextInput label={`Step ${index() + 1} expected outcome`} value={task.title} onInput={(event) => updateTask(index(), "title", event.currentTarget.value)} />
            <TextInput label="Depends on" value={task.dependsOn.join(", ")} description="Comma-separated task IDs; no dependency graph is inferred when empty" onInput={(event) => updateTask(index(), "dependsOn", event.currentTarget.value)} /></div>
          <Textarea label="Acceptance criteria" value={task.criteria.join("\n")} onInput={(event) => updateTask(index(), "criteria", event.currentTarget.value)} />
          </section>}</For>
        </FormSheet>
        <div class="flex flex-wrap items-center gap-2 border-t border-outline-gray-1 pt-4">
          <Button variant="solid" theme="blue" iconLeft="lucide-check-check" loading={busy()} disabled={busy() || !editedTasks().length || (plan.state === "confirmed" && !dirty())} onClick={() => void confirm()}>Confirm this plan</Button>
          <Button variant="outline" iconLeft="lucide-pencil" disabled={busy()} onClick={() => setEditOpen(true)}>Edit steps</Button>
          <Show when={dirty()}><Button variant="ghost" iconLeft="lucide-undo-2" onClick={() => { setDirty(false); setEditedTasks(plan.tasks.map((task) => ({ ...task }))); }}>Reset edits</Button></Show>
          <Show when={plan.state === "proposed"}><Button variant="outline" theme="red" iconLeft="lucide-x" disabled={busy()} onClick={() => { setRejectReason(""); setRejectOpen(true); }}>Reject…</Button></Show>
        </div>
        <ReasonDialog open={rejectOpen()} onClose={() => setRejectOpen(false)} title="Reject this proposal" description="The proposal is kept in history. The mission continues on its last confirmed plan." reason={rejectReason()} onReason={setRejectReason}
          reasonLabel="Why reject this proposal?" confirmLabel="Reject proposal" tone="red" busy={busy()} onConfirm={() => void reject(plan.planVersionId)} />
        <TechnicalDetails label="Plan version"><p class="break-all">{plan.planVersionId} · digest {plan.digest} · origin {plan.origin}</p></TechnicalDetails>
      </PageStack>}</Show>
    </ScreenRegion>
  </WorkspaceSection>;
}
