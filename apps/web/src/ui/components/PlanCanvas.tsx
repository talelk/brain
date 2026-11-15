import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import type { Mission, MissionPlanView, PlanTask, PlanVersion, ReuseItem, TeamMember } from "@brain/contracts";
import { useApp } from "../app-context";
import { governor, query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { wantFastPulse } from "../../data/live";
import { pickForPlan, reuseSearch } from "../../data/reuse";
import { PastWorkUsed } from "./Reuse";
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
import { assignmentChanges, assignTo, candidatesComplete, ineligibleSteps, memberLabel, withCandidateChoice, withCandidateCount } from "../work/plan-team";
import { createPlanTeamData, StepAssignment, StepCandidates, TeamSection } from "./PlanTeamEditor";
import { InlineMarkdown } from "../outputs/Markdown";
import { t } from "../../i18n";

/**
 * The mission's one plan area (T58, #25). Brain prepares a strategy on request
 * (or an agent proposes one, opened with ?proposal=); a person reads the steps,
 * edits them in a side sheet, and confirms — proposing an edited version first —
 * to turn them into tracked work. Confirm is the single primary action; Reject
 * asks for a reason in a dialog. Nothing executes before confirmation.
 */
/** What the plan draft is doing right now, from `MissionPlanView.stage`. */
const NO_PARENT = "none";
const stageLine = (stage: "reading" | "drafting" | "checking"): string => t(stage === "reading" ? "plan.stage.reading" : stage === "drafting" ? "plan.stage.drafting" : "plan.stage.checking");

export function PlanCanvas(props: { mission: Mission; proposalId?: string; onChanged: () => Promise<void> | void }): JSX.Element {
  const app = useApp();
  const [editedTasks, setEditedTasks] = createSignal<PlanTask[]>([]);
  const [editedTeam, setEditedTeam] = createSignal<TeamMember[]>([]);
  const teamData = createPlanTeamData(() => props.mission);
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
  });
  // The drafting stages (reading, drafting, checking) are progress that emits no events: while a draft runs the bus pulses faster.
  createEffect(() => { if (proposal.state().data?.state === "running") onCleanup(wantFastPulse()); });
  /** A proposal opened by link (?proposal=) takes the place of the drafted strategy, with the confirmed plan beside it for the diff. */
  const linked = createScopedRead<{ proposal?: PlanVersion; confirmed?: PlanVersion }>({
    scope: app.scope, load: async (scope, signal) => {
      const get = async (id: string) => (await query<{ snapshot: PlanVersion }>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: id }, signal)).snapshot;
      const proposed = props.proposalId ? await get(props.proposalId) : undefined;
      const confirmed = proposed && props.mission.activePlanVersionId ? await get(props.mission.activePlanVersionId) : undefined;
      return { snapshot: { ...(proposed ? { proposal: proposed } : {}), ...(confirmed ? { confirmed } : {}) }, asOf: new Date().toISOString(), sourceWatermark: 0 };
    },
  });
  /** The mission's confirmed plan, shown when no planning request holds a newer proposal (e.g. a plan confirmed from a play). */
  const active = createScopedRead<PlanVersion | null>({
    scope: app.scope, resource: () => props.mission.activePlanVersionId ?? "",
    load: async (scope, signal, planVersionId) => {
      if (!planVersionId) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: PlanVersion; asOf: string; sourceWatermark: number }>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: planVersionId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  /** Similar past work, searched once before the first plan is drafted (#68). Relevant picks go with the draft by themselves; zero hits leaves the flow unchanged. */
  const [reuseHandled, setReuseHandled] = createSignal(false);
  const [reuseKey, setReuseKey] = createSignal(0);
  /** The picks a draft in flight carries, so the "Used from past work" line shows while Brain is still drafting. */
  const [sent, setSent] = createSignal<ReuseItem[]>([]);
  const suggestions = createScopedRead<ReuseItem[]>({
    scope: app.scope,
    resource: () => props.mission.missionId,
    load: async (scope, signal) => reuseSearch(scope.workspaceId, props.mission.intent, props.mission.missionId, signal, 12),
  });
  const autoPicks = (): ReuseItem[] => (reuseHandled() ? [] : pickForPlan(suggestions.state().data ?? []));
  /** A drafted plan counts only while it is a live proposal: a superseded or rejected one is history, and the confirmed plan is what the mission runs. */
  const draftedProposal = (): PlanVersion | undefined => { const drafted = proposal.state().data?.plan; return drafted?.state === "proposed" ? drafted : undefined; };
  const shownPlan = (): PlanVersion | undefined => linked.state().data?.proposal ?? draftedProposal() ?? active.state().data ?? proposal.state().data?.plan ?? undefined;
  createEffect(() => {
    const plan = shownPlan();
    if (plan && !dirty()) { setEditedTasks(plan.tasks.map((task) => ({ ...task, criteria: [...task.criteria], dependsOn: [...task.dependsOn] }))); setEditedTeam([...(plan.team ?? [])]); }
  });
  async function generate(kept: readonly string[] = [], dropped: readonly string[] = []) {
    if (busy()) return;
    setBusy(true); setError("");
    setSent((suggestions.state().data ?? []).filter((item) => kept.includes(item.itemRef)));
    try {
      // A dropped suggestion is remembered, so it is never offered to this mission again.
      for (const itemRef of dropped) await app.run("mission.reuse.decide", { missionId: props.mission.missionId, itemRef, decision: "drop" });
      setReuseHandled(true);
      await governor<MissionPlanView>("/v1/plans", { workspaceId: app.workspaceId(), requestId: `web-plan-${crypto.randomUUID()}`, missionId: props.mission.missionId, ...(kept.length ? { reuse: kept } : {}) });
      setReuseKey((key) => key + 1);
      setDirty(false);
      await proposal.refresh({ force: true });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Plan generation failed"); }
    finally { setBusy(false); }
  }
  /** Nobody has to ask for the first strategy: an active mission with no plan, no proposal and no failed attempt drafts one as the page opens. */
  let drafted = false;
  createEffect(() => {
    const view = proposal.state();
    const settled = view.status === "ready" || view.status === "empty-authorized";
    if (drafted || !settled || view.data || props.proposalId || !app.canDispatch()) return;
    if (props.mission.state !== "active" || props.mission.activePlanVersionId || linked.state().status === "loading" || active.state().status === "loading") return;
    if (linked.state().data?.proposal) return;
    // The search is quick; the draft waits for it so relevant past work goes with the first draft, and never waits for a person.
    if (suggestions.state().status === "loading") return;
    drafted = true;
    void generate(autoPicks().map((item) => item.itemRef));
  });
  function updateTask(index: number, field: "title" | "criteria" | "dependsOn", value: string) {
    setDirty(true);
    setEditedTasks((tasks) => tasks.map((task, position) => position === index ? {
      ...task,
      ...(field === "title" ? { title: value } : field === "criteria" ? { criteria: value.split("\n").map((item) => item.trim()).filter(Boolean) } : { dependsOn: value.split(",").map((item) => item.trim()).filter(Boolean) }),
    } : task));
  }
  /** A step names the success criteria it serves from the mission's own list, never as typed ids (ADR 0034). */
  function toggleCriterion(index: number, criterionId: string, checked: boolean) {
    setDirty(true);
    setEditedTasks((tasks) => tasks.map((task, position) => {
      if (position !== index) return task;
      const kept = (task.criterionIds ?? []).filter((id) => id !== criterionId);
      const next = checked ? props.mission.successCriteria.map((criterion) => criterion.criterionId).filter((id) => id === criterionId || kept.includes(id)) : kept;
      const { criterionIds: _previous, ...rest } = task;
      return next.length ? { ...rest, criterionIds: next } : rest;
    }));
  }
  /** Who a step is given to, and who is on the mission team, are plan edits like any other: they make a new plan version, applied with the plan on confirm. */
  function assign(index: number, memberId: string) {
    setDirty(true);
    setEditedTasks((tasks) => tasks.map((task, position) => position === index ? assignTo(task, memberId) : task));
  }
  /** A step sits inside another step (a subtask) or stands alone; the Governor refuses chains and loops, so the choices offered are the plain ones. */
  function setParent(index: number, parentId: string) {
    setDirty(true);
    setEditedTasks((tasks) => tasks.map((task, position) => {
      if (position !== index) return task;
      const { parentId: _previous, ...rest } = task;
      return parentId === NO_PARENT ? rest : { ...rest, parentId };
    }));
  }
  /** A new, empty subtask is listed right after the last subtask of its parent; the person names it and says when it is done. */
  function addSubtask(index: number) {
    const parent = editedTasks()[index];
    if (!parent) return;
    const taken = new Set(editedTasks().map((task) => task.id));
    let n = 1;
    while (taken.has(`${parent.id}-sub-${n}`)) n += 1;
    const subtask: PlanTask = { id: `${parent.id}-sub-${n}`, title: "", criteria: [], dependsOn: [], parentId: parent.id };
    setDirty(true);
    setEditedTasks((tasks) => {
      let at = tasks.findIndex((task) => task.id === parent.id);
      tasks.forEach((task, position) => { if (task.parentId === parent.id) at = Math.max(at, position); });
      return [...tasks.slice(0, at + 1), subtask, ...tasks.slice(at + 1)];
    });
  }
  const parentOptions = (task: PlanTask) => [
    { value: NO_PARENT, label: t("plan.no-parent") },
    ...editedTasks().filter((other) => other.id !== task.id && !other.parentId && !editedTasks().some((child) => child.parentId === task.id)).map((other) => ({ value: other.id, label: other.title || other.id })),
  ];
  /** A step runs as two to four candidates or as one attempt (ADR 0064). */
  function setCandidateCount(index: number, count: number) {
    setDirty(true);
    setEditedTasks((tasks) => tasks.map((task, position) => position === index ? withCandidateCount(task, count) : task));
  }
  function chooseCandidate(index: number, candidate: number, choice: string) {
    setDirty(true);
    setEditedTasks((tasks) => tasks.map((task, position) => position === index ? withCandidateChoice(task, candidate, choice) : task));
  }
  const incomplete = () => editedTasks().some((task) => !task.title.trim() || task.criteria.length === 0 || !candidatesComplete(task));
  function changeTeam(team: TeamMember[]) { setDirty(true); setEditedTeam(team); }
  const unfit = () => ineligibleSteps(editedTasks(), editedTeam(), teamData.agents());
  const serves = (task: PlanTask) => props.mission.successCriteria.filter((criterion) => task.criterionIds?.includes(criterion.criterionId));
  async function confirm() {
    const current = shownPlan();
    if (!current || busy()) return;
    setBusy(true); setError("");
    try {
      let planVersionId = current.planVersionId;
      if (dirty()) {
        const proposed = await app.run("plan.propose", { missionId: props.mission.missionId, origin: "manual", summary: current.summary, tasks: editedTasks(), ...(editedTeam().length ? { team: editedTeam() } : {}) });
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
    const known = editedTeam().find((entry) => entry.memberId === task.assignment?.id);
    return known ? memberLabel(known) : task.assignment.id;
  };
  /** What the shown version changes (a proposal against the confirmed plan) or what unsaved edits would change, in assignments and team. */
  const changes = (plan: PlanVersion): string[] => {
    const base = dirty() || plan.state !== "proposed" ? plan : linked.state().data?.confirmed ?? active.state().data ?? undefined;
    return base ? assignmentChanges(base, editedTasks(), editedTeam()) : [];
  };
  const roadmap = (): RoadmapNode[] => editedTasks().map((task) => ({ id: task.id, title: task.title, deps: task.dependsOn, weight: task.estimatedMinutes ?? 1, done: false }));
  const stepCard = (task: PlanTask, critical: boolean): JSX.Element => <div class="flex min-w-0 flex-col gap-2">
    <p class="flex items-start gap-2"><span class="lucide-circle-dashed mt-0.5 size-4 shrink-0 text-ink-gray-6" aria-hidden="true" /><span class="min-w-0 break-words text-interface font-medium text-ink-gray-9"><InlineMarkdown text={task.title} /></span></p>
    <Show when={task.parentId}>{(parentId) => <p class="flex items-center gap-1 text-caption text-ink-gray-6" data-testid="plan-step-parent-line"><span class="lucide-corner-down-right size-3.5" aria-hidden="true" />{t("work.subtask-of", { title: editedTasks().find((other) => other.id === parentId())?.title || parentId() })}</p>}</Show>
    <Show when={critical}><span class="inline-flex w-fit items-center gap-1 rounded-full bg-surface-blue-2 px-1.5 text-caption text-ink-blue-8"><span class="lucide-route size-3" aria-hidden="true" />{t("plan.critical-path.c77e")}</span></Show>
    <Show when={task.criteria.length}><ul class="flex flex-col gap-0.5 text-caption text-ink-gray-7" aria-label={t("plan.done-when.c84f")}><For each={task.criteria}>{(criterion) => <li class="flex items-start gap-1"><span class="lucide-check mt-0.5 size-3 shrink-0 text-ink-gray-6" aria-hidden="true" /><InlineMarkdown text={criterion} /></li>}</For></ul></Show>
    <Show when={serves(task).length}><ul class="flex flex-col gap-0.5 text-caption text-ink-gray-7" aria-label={t("plan.serves.label")} data-testid="plan-step-serves"><For each={serves(task)}>{(criterion) => <li class="flex items-start gap-1" data-criterion-id={criterion.criterionId}><span class="lucide-target mt-0.5 size-3 shrink-0 text-ink-gray-6" aria-hidden="true" /><span class="min-w-0 break-words">{criterion.text}</span></li>}</For></ul></Show>
    <p class="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-6">
      <Show when={member(task)}>{(name) => <span class="inline-flex items-center gap-1"><span class="lucide-bot size-3.5" aria-hidden="true" />{name()}</span>}</Show>
      <Show when={task.estimatedMinutes}>{(minutes) => <span class="inline-flex items-center gap-1"><span class="lucide-clock size-3.5" aria-hidden="true" />{minutesText(minutes())}</span>}</Show>
      <Show when={task.candidates}>{(candidates) => <span class="inline-flex items-center gap-1" data-testid="plan-step-candidates-line"><span class="lucide-git-fork size-3.5" aria-hidden="true" />{t("plan.candidates-line", { n: candidates().length, names: candidates().map((candidate) => candidate.memberId ?? candidate.workflowId ?? candidate.id).join(", ") })}</span>}</Show>
      <Show when={task.optional}><span>{t("plan.optional.0c6c")}</span></Show>
    </p>
  </div>;
  const planBody = (plan: PlanVersion): JSX.Element => {
    const canConfirm = () => plan.state === "proposed" || dirty();
    const confirmedQuiet = () => plan.state === "confirmed" && !dirty();
    const estimate = () => editedTasks().reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0);
    return <section aria-label={plan.state === "confirmed" ? t("plan.confirmed-plan.1210") : t("plan.plan-proposal.8f88")} class="flex flex-col gap-4">
      <PlainSummary icon={plan.state === "confirmed" ? "lucide-circle-check" : "lucide-list-checks"}>
        {plan.state === "confirmed" ? (props.mission.state !== "closed" ? t("plan.this-plan-is-confirmed-and-its-t.e4cd") : t("plan.this-plan-was-confirmed-and-carr.acf5")) : plan.state === "proposed" ? "Read the steps below. Nothing runs and no work is tracked until you confirm." : t("plan.not-running")}
      </PlainSummary>
      <div class="flex flex-col gap-1">
        <div class="flex flex-wrap items-center gap-2"><p class="text-base-medium">{label(plan)}</p><StatusBadge kind="plan" status={plan.state} /><Show when={dirty()}><Badge theme="amber" label={t("plan.unsaved-edits.0881")} /></Show></div>
        <Show when={plan.summary}><p class="brain-prose text-interface text-ink-gray-7"><InlineMarkdown text={plan.summary ?? ""} /></p></Show>
        <p class="flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-gray-6">
          <span class="inline-flex items-center gap-1"><span class="lucide-list-checks size-3.5" aria-hidden="true" />{editedTasks().length} {editedTasks().length === 1 ? "step" : "steps"}</span>
          <Show when={estimate() > 0}><span class="inline-flex items-center gap-1"><span class="lucide-clock size-3.5" aria-hidden="true" />About {minutesText(estimate())} of estimated work</span></Show>
          <Show when={editedTeam().length}><span class="inline-flex items-center gap-1" data-testid="plan-team-line"><span class="lucide-users size-3.5" aria-hidden="true" />Team: {editedTeam().map((entry) => `${entry.memberId} (${entry.role})`).join(", ")}</span></Show>
        </p>
        <Show when={diff(plan)}>{(text) => <p class="text-interface text-ink-gray-7">{text()}</p>}</Show>
        <Show when={changes(plan).length}><ul class="flex flex-col gap-0.5 text-interface text-ink-gray-7" aria-label={t("plan.team.changes")} data-testid="plan-assignment-changes"><For each={changes(plan)}>{(line) => <li class="flex items-start gap-1"><span class="lucide-user-round-cog mt-0.5 size-3.5 shrink-0 text-ink-gray-6" aria-hidden="true" />{line}</li>}</For></ul></Show>
      </div>
      <Show when={!confirmedQuiet()} fallback={<DisclosureCard label={`See the confirmed plan's ${editedTasks().length} steps`}>
        <div class="flex flex-col gap-3">
          <WorkRoadmap nodes={roadmap()} label={t("plan.confirmed-plan-steps-by-round.74f9")} renderNode={(node, critical) => <Show when={editedTasks().find((task) => task.id === node.id)}>{(task) => stepCard(task(), critical)}</Show>} />
          <div class="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" iconLeft="lucide-pencil" disabled={busy()} onClick={() => setEditOpen(true)}>{t("plan.edit-steps.06ec")}</Button>
            <span class="text-caption text-ink-gray-6">{t("plan.edits-become-a-new-revision-for.d692")}</span></div>
          <TechnicalDetails label={t("plan.details.dc3d")}><p class="break-all">{plan.planVersionId} · digest {plan.digest} · origin {plan.origin}</p></TechnicalDetails>
        </div>
      </DisclosureCard>}>
        <WorkRoadmap nodes={roadmap()} label={t("plan.plan-steps-by-round.7712")}
          renderNode={(node, critical) => <Show when={editedTasks().find((task) => task.id === node.id)}>{(task) => stepCard(task(), critical)}</Show>} />
      </Show>
      <FormSheet size="xl" open={editOpen()} onClose={() => setEditOpen(false)} title={t("plan.edit-the-plan-steps.a8fd")} description={t("plan.edits-become-a-new-plan-revision.18a4")} submit={t("plan.keep-edits.2584")} icon="lucide-check" disabled={unfit().length > 0 || incomplete()} onSubmit={() => { setEditOpen(false); }}>
        <TeamSection team={editedTeam()} tasks={editedTasks()} agents={teamData.agents()} locked={teamData.lockedMembers()} standing={teamData.standingTeams() ?? []} onChange={changeTeam} />
        <For each={editedTasks()}>{(task, index) => <section class="flex flex-col gap-3 border-b border-outline-gray-1 pb-4" aria-label={`Step ${index() + 1}`}>
          <div class="flex flex-col gap-3"><TextInput label={`Step ${index() + 1} expected outcome`} value={task.title} onInput={(event) => updateTask(index(), "title", event.currentTarget.value)} />
            <TextInput label={t("plan.depends-on.8bfa")} value={task.dependsOn.join(", ")} description={t("plan.comma-separated-task-ids-no-depe.46ab")} onInput={(event) => updateTask(index(), "dependsOn", event.currentTarget.value)} /></div>
          <Textarea label={t("plan.acceptance-criteria.133c")} value={task.criteria.join("\n")} onInput={(event) => updateTask(index(), "criteria", event.currentTarget.value)} />
          <div class="flex flex-col gap-1.5" data-testid="plan-step-parent">
            <Select label={t("plan.subtask-of")} value={task.parentId ?? NO_PARENT} options={parentOptions(task)} onValueChange={(value) => setParent(index(), value ?? NO_PARENT)} />
            <Show when={!task.parentId}><div class="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" iconLeft="lucide-list-plus" onClick={() => addSubtask(index())}>{t("plan.add-subtask")}</Button>
              <span class="text-caption text-ink-gray-6">{t("plan.subtask-hint")}</span></div></Show>
          </div>
          <Show when={editedTeam().length || task.assignment}><StepAssignment task={task} position={index() + 1} team={editedTeam()} agents={teamData.agents()} started={teamData.startedSteps().has(task.id)} onAssign={(memberId) => assign(index(), memberId)} /></Show>
          <StepCandidates task={task} position={index() + 1} team={editedTeam()} ways={teamData.ways()} started={teamData.startedSteps().has(task.id)}
            nested={Boolean(task.parentId) || editedTasks().some((child) => child.parentId === task.id)} onCount={(count) => setCandidateCount(index(), count)} onChoose={(candidate, choice) => chooseCandidate(index(), candidate, choice)} />
          <fieldset class="flex flex-col gap-1.5" data-testid="plan-step-criteria"><legend class="text-interface font-medium text-ink-gray-8">{t("plan.serves.legend")}</legend>
            <For each={props.mission.successCriteria}>{(criterion) => <Checkbox checked={task.criterionIds?.includes(criterion.criterionId) ?? false} onCheckedChange={(checked) => toggleCriterion(index(), criterion.criterionId, Boolean(checked))} label={criterion.text} />}</For>
          </fieldset>
        </section>}</For>
        <Show when={incomplete()}><p class="text-caption text-ink-amber-8" role="status" data-testid="plan-step-incomplete">{t("plan.step-incomplete")}</p></Show>
      </FormSheet>
      <Show when={!confirmedQuiet() && (plan.state === "proposed" || dirty())}><section class="brain-plan-actions" aria-label={t("plan.plan-decision.6411")}>
        <p class="brain-plan-actions-hint"><span class="lucide-shield-check size-4 shrink-0" aria-hidden="true" /><span>{editedTasks().length} {editedTasks().length === 1 ? "step" : "steps"} · nothing runs until you confirm</span></p>
        <div class="brain-plan-actions-buttons">
          <Show when={canConfirm()}><Button class="brain-plan-primary" variant="solid" theme="blue" iconLeft="lucide-check-check" loading={busy()} disabled={busy() || !editedTasks().length || unfit().length > 0 || incomplete()} onClick={() => void confirm()}>{t("plan.confirm-this-plan.f61c")}</Button></Show>
          <Button variant="outline" iconLeft="lucide-pencil" disabled={busy()} onClick={() => setEditOpen(true)}>{t("plan.edit-steps.06ec")}</Button>
          <Show when={dirty()}><Button variant="ghost" iconLeft="lucide-undo-2" onClick={() => { setDirty(false); setEditedTasks(plan.tasks.map((task) => ({ ...task, criteria: [...task.criteria], dependsOn: [...task.dependsOn] }))); setEditedTeam([...(plan.team ?? [])]); }}>{t("plan.reset-edits.56d9")}</Button></Show>
          <Show when={plan.state === "proposed"}><Button variant="ghost" theme="red" iconLeft="lucide-x" disabled={busy()} onClick={() => { setRejectReason(""); setRejectOpen(true); }}>{t("plan.reject-this-proposal.09f4")}</Button></Show>
        </div>
      </section></Show>
      <ReasonDialog open={rejectOpen()} onClose={() => setRejectOpen(false)} title={t("plan.reject-this-proposal.09f4")} description={t("plan.the-proposal-is-kept-in-history.a680")} reason={rejectReason()} onReason={setRejectReason}
        reasonLabel="Rejection reason" confirmLabel={t("plan.reject-proposal.9492")} tone="red" busy={busy()} onConfirm={() => void reject(plan.planVersionId)} />
      <Show when={!confirmedQuiet()}><TechnicalDetails label={t("plan.details.dc3d")}><p class="break-all">{plan.planVersionId} · digest {plan.digest} · origin {plan.origin}</p></TechnicalDetails></Show>
    </section>;
  };
  const hasPlan = () => Boolean(shownPlan());
  /** The first draft starts by itself; the manual button only returns when that attempt failed (or a plan exists, for another strategy). */
  const retryable = () => Boolean(error()) || proposal.state().data?.state === "failed";
  return <WorkspaceSection title={t("plan.plan.ae2f")} description={t("plan.the-steps-brain-will-track-as-wo.9a8f")}
    actions={<Show when={app.canDispatch() && props.mission.state !== "closed" && !props.proposalId && (hasPlan() || retryable())}><Button variant={hasPlan() ? "ghost" : "solid"} theme="blue" iconLeft="lucide-sparkles" loading={busy()} disabled={busy()} onClick={() => void generate(hasPlan() ? [] : autoPicks().map((item) => item.itemRef))}>{hasPlan() ? t("plan.draft-another-plan.f88d") : t("plan.try-drafting-again.c69b")}</Button></Show>}>
    <Show when={error()}><Alert theme="red" variant="outline" title={t("plan.planning-action-failed.a063")} description={error()} /></Show>
    <PastWorkUsed missionId={props.mission.missionId} workspaceId={props.mission.workspaceId} pending={busy() ? sent() : []} busy={busy()} canEdit={app.canDispatch() && props.mission.state !== "closed"} refreshKey={reuseKey()}
      onRedraft={(kept, dropped) => void generate(kept, dropped)} />
    <Show when={proposal.state().data?.state === "running"}><Alert theme="blue" variant="outline" title={t("plan.preparing-a-validated-proposal.5bc9")} description={`${stageLine(proposal.state().data?.stage ?? "reading")} ${t("plan.stage.saved")}`} /></Show>
    <Show when={proposal.state().data?.state === "failed"}><Alert theme="amber" variant="outline" title={t("plan.no-validated-proposal-yet.b7ae")} description={proposal.state().data?.error} /></Show>
    <Show when={shownPlan()} keyed fallback={
      <ScreenRegion state={proposal.state()} onRetry={() => void proposal.refresh()} emptyTitle={t("plan.no-plan-yet.5f3d")} emptyDescription={t("plan.ask-brain-to-draft-a-plan-nothin.d322")}><></></ScreenRegion>}>
      {(plan) => planBody(plan)}
    </Show>
  </WorkspaceSection>;
}
