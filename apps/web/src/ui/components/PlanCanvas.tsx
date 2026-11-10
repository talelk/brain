import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { Mission, MissionPlanView, PlanTask, PlanVersion } from "@brain/contracts";
import { useApp } from "../app-context";
import { governor, query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { TechnicalDetails } from "./PageLayout";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceSection } from "./Domain";
import { FormSheet } from "./BrainForm";
import { PlainSummary } from "../viz/PlainSummary";
import { ReasonDialog } from "./ReasonDialog";
import { DisclosureCard } from "./primitives";
import { WorkRoadmap, type RoadmapNode } from "../work/WorkRoadmap";
import { minutesText } from "../work/work-model";

/**
 * The mission's one plan area (T58, #25). Brain prepares a strategy on request
 * (or an agent proposes one, opened with ?proposal=); a person reads the steps,
 * edits them in a side sheet, and confirms — proposing an edited version first —
 * to turn them into tracked work. Confirm is the single primary action; Reject
 * asks for a reason in a dialog. Nothing executes before confirmation.
 */
export function PlanCanvas(props: { mission: Mission; proposalId?: string; onChanged: () => Promise<void> | void }): JSX.Element {
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
  /** A proposal opened by link (?proposal=) takes the place of the drafted strategy, with the confirmed plan beside it for the diff. */
  const linked = createScopedRead<{ proposal?: PlanVersion; confirmed?: PlanVersion }>({
    scope: app.scope, refreshMs: 5000,
    load: async (scope, signal) => {
      const get = async (id: string) => (await query<{ snapshot: PlanVersion }>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: id }, signal)).snapshot;
      const proposed = props.proposalId ? await get(props.proposalId) : undefined;
      const confirmed = proposed && props.mission.activePlanVersionId ? await get(props.mission.activePlanVersionId) : undefined;
      return { snapshot: { ...(proposed ? { proposal: proposed } : {}), ...(confirmed ? { confirmed } : {}) }, asOf: new Date().toISOString(), sourceWatermark: 0 };
    },
  });
  /** The mission's confirmed plan, shown when no planning request holds a newer proposal (e.g. a plan confirmed from a play). */
  const active = createScopedRead<PlanVersion | null>({
    scope: app.scope, refreshMs: 5000,
    resource: () => props.mission.activePlanVersionId ?? "",
    load: async (scope, signal, planVersionId) => {
      if (!planVersionId) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: PlanVersion; asOf: string; sourceWatermark: number }>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: planVersionId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const shownPlan = (): PlanVersion | undefined => linked.state().data?.proposal ?? proposal.state().data?.plan ?? active.state().data ?? undefined;
  createEffect(() => {
    const plan = shownPlan();
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
    const current = shownPlan();
    if (!current || busy()) return;
    setBusy(true); setError("");
    try {
      let planVersionId = current.planVersionId;
      if (dirty()) {
        const proposed = await app.run("plan.propose", { missionId: props.mission.missionId, origin: "manual", summary: current.summary, tasks: editedTasks() });
        if (!proposed.accepted || !proposed.resourceId) throw new Error(proposed.detail);
        planVersionId = proposed.resourceId;
      }
      const confirmed = await app.run("plan.confirm", { planVersionId }, { expectedVersion: props.mission.version });
      if (!confirmed.accepted) throw new Error(confirmed.detail);
      setDirty(false);
      await Promise.all([proposal.refresh({ force: true }), linked.refresh({ force: true }), props.onChanged()]);
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
      await Promise.all([proposal.refresh({ force: true }), linked.refresh({ force: true }), props.onChanged()]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The rejection was refused"); }
    finally { setBusy(false); }
  }
  const label = (plan: PlanVersion) => plan.state === "confirmed" ? `Confirmed plan: revision ${plan.revision}` : `Proposal: revision ${plan.revision} · ${plan.state} · ${plan.origin}`;
  const diff = (plan: PlanVersion) => {
    const before = linked.state().data?.confirmed;
    if (!before || plan.state !== "proposed") return undefined;
    const names = (tasks: ReadonlyArray<PlanTask>) => tasks.map((task) => task.title).join(", ") || "none";
    return `Added: ${names(plan.tasks.filter((task) => !before.tasks.some((other) => other.id === task.id)))}; removed: ${names(before.tasks.filter((task) => !plan.tasks.some((other) => other.id === task.id)))}`;
  };
  const member = (task: PlanTask) => {
    if (!task.assignment) return undefined;
    const known = shownPlan()?.team?.find((entry) => entry.memberId === task.assignment?.id);
    return known ? `${known.role} (${known.memberId})` : task.assignment.id;
  };
  const roadmap = (): RoadmapNode[] => editedTasks().map((task) => ({ id: task.id, title: task.title, deps: task.dependsOn, weight: task.estimatedMinutes ?? 1, done: false }));
  const stepCard = (task: PlanTask, critical: boolean): JSX.Element => <div class="flex min-w-0 flex-col gap-2">
    <p class="flex items-start gap-2"><span class="lucide-circle-dashed mt-0.5 size-4 shrink-0 text-ink-gray-6" aria-hidden="true" /><span class="min-w-0 break-words text-interface font-medium text-ink-gray-9">{task.title}</span></p>
    <Show when={critical}><span class="inline-flex w-fit items-center gap-1 rounded-full bg-surface-blue-2 px-1.5 text-caption text-ink-blue-8"><span class="lucide-route size-3" aria-hidden="true" />Critical path</span></Show>
    <Show when={task.criteria.length}><ul class="flex flex-col gap-0.5 text-caption text-ink-gray-7" aria-label="Done when"><For each={task.criteria}>{(criterion) => <li class="flex items-start gap-1"><span class="lucide-check mt-0.5 size-3 shrink-0 text-ink-gray-6" aria-hidden="true" />{criterion}</li>}</For></ul></Show>
    <p class="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-6">
      <Show when={member(task)}>{(name) => <span class="inline-flex items-center gap-1"><span class="lucide-bot size-3.5" aria-hidden="true" />{name()}</span>}</Show>
      <Show when={task.estimatedMinutes}>{(minutes) => <span class="inline-flex items-center gap-1"><span class="lucide-clock size-3.5" aria-hidden="true" />{minutesText(minutes())}</span>}</Show>
      <Show when={task.optional}><span>Optional</span></Show>
    </p>
  </div>;
  const planBody = (plan: PlanVersion): JSX.Element => {
    const canConfirm = () => plan.state === "proposed" || dirty();
    const confirmedQuiet = () => plan.state === "confirmed" && !dirty();
    const estimate = () => editedTasks().reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0);
    return <section aria-label={plan.state === "confirmed" ? "Confirmed plan" : "Plan proposal"} class="flex flex-col gap-4">
      <PlainSummary icon={plan.state === "confirmed" ? "lucide-circle-check" : "lucide-list-checks"}>
        {plan.state === "confirmed" ? "This plan is confirmed and its tasks are tracked. Follow and move them in Mission work below." : "Read the steps below. Nothing runs and no work is tracked until you confirm."}
      </PlainSummary>
      <div class="flex flex-col gap-1">
        <div class="flex flex-wrap items-center gap-2"><p class="text-base-medium">{label(plan)}</p><StatusBadge kind="plan" status={plan.state} /><Show when={dirty()}><Badge theme="amber" label="Unsaved edits" /></Show></div>
        <Show when={plan.summary}><p class="brain-prose text-interface text-ink-gray-7">{plan.summary}</p></Show>
        <p class="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-gray-6">
          <span class="inline-flex items-center gap-1"><span class="lucide-list-checks size-3.5" aria-hidden="true" />{editedTasks().length} {editedTasks().length === 1 ? "step" : "steps"}</span>
          <Show when={estimate() > 0}><span class="inline-flex items-center gap-1"><span class="lucide-clock size-3.5" aria-hidden="true" />About {minutesText(estimate())} of estimated work</span></Show>
          <Show when={plan.team?.length}><span class="inline-flex items-center gap-1"><span class="lucide-users size-3.5" aria-hidden="true" />Team: {plan.team!.map((entry) => `${entry.memberId} (${entry.role})`).join(", ")}</span></Show>
        </p>
        <Show when={diff(plan)}>{(text) => <p class="text-interface text-ink-gray-7">{text()}</p>}</Show>
      </div>
      <Show when={!confirmedQuiet()} fallback={<DisclosureCard label={`See the confirmed plan's ${editedTasks().length} steps`}>
        <div class="flex flex-col gap-3">
          <WorkRoadmap nodes={roadmap()} label="Confirmed plan steps by stage" renderNode={(node, critical) => <Show when={editedTasks().find((task) => task.id === node.id)}>{(task) => stepCard(task(), critical)}</Show>} />
          <div class="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" iconLeft="lucide-pencil" disabled={busy()} onClick={() => setEditOpen(true)}>Edit steps</Button>
            <span class="text-caption text-ink-gray-6">Edits become a new revision for you to confirm.</span></div>
          <TechnicalDetails label="Plan version"><p class="break-all">{plan.planVersionId} · digest {plan.digest} · origin {plan.origin}</p></TechnicalDetails>
        </div>
      </DisclosureCard>}>
        <WorkRoadmap nodes={roadmap()} label="Plan steps by stage"
          renderNode={(node, critical) => <Show when={editedTasks().find((task) => task.id === node.id)}>{(task) => stepCard(task(), critical)}</Show>} />
      </Show>
      <FormSheet size="xl" open={editOpen()} onClose={() => setEditOpen(false)} title="Edit the plan steps" description="Edits become a new plan revision when you confirm. Nothing is tracked or executed before that." submit="Keep edits" icon="lucide-check" onSubmit={() => { setEditOpen(false); }}>
        <For each={editedTasks()}>{(task, index) => <section class="flex flex-col gap-3 border-b border-outline-gray-1 pb-4" aria-label={`Step ${index() + 1}`}>
          <div class="flex flex-col gap-3"><TextInput label={`Step ${index() + 1} expected outcome`} value={task.title} onInput={(event) => updateTask(index(), "title", event.currentTarget.value)} />
            <TextInput label="Depends on" value={task.dependsOn.join(", ")} description="Comma-separated task IDs; no dependency graph is inferred when empty" onInput={(event) => updateTask(index(), "dependsOn", event.currentTarget.value)} /></div>
          <Textarea label="Acceptance criteria" value={task.criteria.join("\n")} onInput={(event) => updateTask(index(), "criteria", event.currentTarget.value)} />
        </section>}</For>
      </FormSheet>
      <Show when={!confirmedQuiet()}><div class="flex flex-wrap items-center gap-2 border-t border-outline-gray-1 pt-4">
        <Show when={canConfirm()}><Button variant="solid" theme="blue" iconLeft="lucide-check-check" loading={busy()} disabled={busy() || !editedTasks().length} onClick={() => void confirm()}>Confirm this plan</Button></Show>
        <Button variant="outline" iconLeft="lucide-pencil" disabled={busy()} onClick={() => setEditOpen(true)}>Edit steps</Button>
        <Show when={dirty()}><Button variant="ghost" iconLeft="lucide-undo-2" onClick={() => { setDirty(false); setEditedTasks(plan.tasks.map((task) => ({ ...task, criteria: [...task.criteria], dependsOn: [...task.dependsOn] }))); }}>Reset edits</Button></Show>
        <Show when={plan.state === "proposed"}><Button variant="ghost" theme="red" iconLeft="lucide-x" disabled={busy()} onClick={() => { setRejectReason(""); setRejectOpen(true); }}>Reject this proposal</Button></Show>
      </div></Show>
      <ReasonDialog open={rejectOpen()} onClose={() => setRejectOpen(false)} title="Reject this proposal" description="The proposal is kept in history. The mission continues on its last confirmed plan." reason={rejectReason()} onReason={setRejectReason}
        reasonLabel="Rejection reason" confirmLabel="Reject proposal" tone="red" busy={busy()} onConfirm={() => void reject(plan.planVersionId)} />
      <Show when={!confirmedQuiet()}><TechnicalDetails label="Plan version"><p class="break-all">{plan.planVersionId} · digest {plan.digest} · origin {plan.origin}</p></TechnicalDetails></Show>
    </section>;
  };
  const hasPlan = () => Boolean(shownPlan());
  return <WorkspaceSection title="Plan" description="The steps Brain will track as work once you confirm them."
    actions={<Show when={app.canDispatch() && props.mission.state !== "closed" && !props.proposalId}><Button variant={hasPlan() ? "ghost" : "solid"} theme="blue" iconLeft="lucide-sparkles" loading={busy()} disabled={busy()} onClick={() => void generate()}>{hasPlan() ? "Generate another strategy" : "Prepare plan proposal"}</Button></Show>}>
    <Show when={error()}><Alert theme="red" variant="outline" title="Planning action failed" description={error()} /></Show>
    <Show when={proposal.state().data?.state === "running"}><Alert theme="blue" variant="outline" title="Preparing a validated proposal" description="The mission is durable. No tasks have been created and no execution has started." /></Show>
    <Show when={proposal.state().data?.state === "failed"}><Alert theme="amber" variant="outline" title="No validated proposal yet" description={proposal.state().data?.error} /></Show>
    <Show when={linked.state().data?.proposal ?? (proposal.state().data?.plan ? undefined : active.state().data ?? undefined)} keyed fallback={
      <ScreenRegion state={proposal.state()} onRetry={() => void proposal.refresh()} emptyTitle="No plan yet" emptyDescription="Ask Brain to prepare a strategy. Nothing becomes tracked work or executes before you confirm it.">
        <Show when={proposal.state().data?.plan} keyed>{(plan) => planBody(plan)}</Show>
      </ScreenRegion>}>
      {(plan) => planBody(plan)}
    </Show>
  </WorkspaceSection>;
}
