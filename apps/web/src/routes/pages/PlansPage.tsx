import { createEffect, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Pagination, Stepper } from "@talelk/newui-molecules";
import type { Mission, MissionPlanView, PlanTask } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { governor, query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack, TechnicalDetails } from "../../ui/components/PageLayout";
import { SelectableListItem } from "../../ui/components/primitives";
import { MissionWorkItems } from "../../ui/components/MissionWorkItems";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { EmptyPreview, FactStrip, WorkspaceSection } from "../../ui/components/Domain";

const MISSIONS_PAGE_SIZE = 25;

export default function PlansPage(): JSX.Element {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const selectedId = () => typeof params.mission === "string" ? params.mission : "";
  const [title, setTitle] = createSignal("");
  const [intent, setIntent] = createSignal("");
  const [criteria, setCriteria] = createSignal("");
  const [editedTasks, setEditedTasks] = createSignal<PlanTask[]>([]);
  const [dirty, setDirty] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const missionList = createScopedRead<Mission[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: Mission[] }; asOf: string; sourceWatermark: number }>({ queryType: "missions.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (missions) => missions.length === 0,
    refreshMs: 15_000,
  });
  const proposal = createScopedRead<MissionPlanView | null>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!selectedId()) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const view = await governor<MissionPlanView>(`/v1/plans/${encodeURIComponent(selectedId())}?workspaceId=${encodeURIComponent(scope.workspaceId)}`, undefined, signal);
      return { snapshot: view, asOf: new Date().toISOString(), sourceWatermark: 0 };
    },
    isEmpty: (view) => view === null,
    refreshMs: 2000,
  });
  createEffect(() => {
    const plan = proposal.state().data?.plan;
    if (plan && !dirty()) setEditedTasks(plan.tasks.map((task) => ({ ...task, criteria: [...task.criteria], dependsOn: [...task.dependsOn] })));
  });

  async function start(missionId?: string) {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const requestId = `web-plan-${crypto.randomUUID()}`;
      const started = await governor<MissionPlanView>("/v1/plans", {
        workspaceId: app.workspaceId(), requestId,
        ...(missionId ? { missionId } : { title: title().trim(), intent: intent().trim(), successCriteria: criteria().split("\n").map((item) => item.trim()).filter(Boolean) }),
      });
      setParams({ mission: started.missionId });
      await proposal.refresh({ force: true });
      if (!missionId) { setTitle(""); setIntent(""); setCriteria(""); }
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
    const mission = missionList.state().data?.find((item) => item.missionId === selectedId());
    if (!current?.planVersionId || !mission || busy()) return;
    setBusy(true); setError("");
    try {
      let planVersionId = current.planVersionId;
      if (dirty()) {
        const proposed = await app.run("plan.propose", { missionId: selectedId(), origin: "manual", summary: current.plan?.summary, tasks: editedTasks() });
        if (!proposed.accepted || !proposed.resourceId) throw new Error(proposed.detail);
        planVersionId = proposed.resourceId;
      }
      const confirmed = await app.run("plan.confirm", { planVersionId }, { expectedVersion: mission.version });
      if (!confirmed.accepted) throw new Error(confirmed.detail);
      setDirty(false);
      await Promise.all([missionList.refresh({ force: true }), proposal.refresh({ force: true })]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Plan confirmation failed"); }
    finally { setBusy(false); }
  }

  const stage = () => !selectedId() ? "describe" : proposal.state().data?.plan ? "confirm" : "review";
  const missions = () => missionList.state().data ?? [];
  const [missionPage, setMissionPage] = createSignal(1);
  const missionPageCount = () => Math.max(1, Math.ceil(missions().length / MISSIONS_PAGE_SIZE));
  const safeMissionPage = () => Math.min(Math.max(1, missionPage()), missionPageCount());
  const visibleMissions = () => missions().slice((safeMissionPage() - 1) * MISSIONS_PAGE_SIZE, safeMissionPage() * MISSIONS_PAGE_SIZE);
  return <BrainPage title="Plans" description="Describe the goal, review a concrete strategy, then explicitly confirm the version that becomes tracked work."
    actions={<Show when={selectedId()}><Button size="md" variant="outline" iconLeft="lucide-refresh-cw" disabled={busy()} onClick={() => void start(selectedId())}>Generate another strategy</Button></Show>}>
    <PageStack>
      <Stepper label="Planning stages" linear={false} value={stage()} steps={[{ value: "describe", label: "Describe goal", description: "Outcome and acceptance" }, { value: "review", label: "Review proposal", description: "Steps and dependencies" }, { value: "confirm", label: "Confirm work", description: "One explicit version" }]} />
      <FactStrip label="Planning workspace summary" items={[
        { label: "Missions", value: String(missions().length), hint: "Authorized workspace missions", icon: "lucide-target" },
        { label: "Current stage", value: stage() === "describe" ? "Describe" : stage() === "review" ? "Review" : "Confirm", hint: "AI proposals stay separate from tracked work", icon: "lucide-list-tree" },
        { label: "Unsaved edits", value: dirty() ? "Yes" : "None", hint: dirty() ? "Confirmation creates a new plan version" : "Current proposal is unchanged", icon: "lucide-file-pen-line" },
      ]} />
      <div class="brain-studio-layout">
        <div class="brain-detail-stack">
          <WorkspaceSection title="Describe the goal" description="Brain proposes a strategy only. Nothing becomes tracked work or executes before your confirmation.">
            <div class="brain-field-grid"><TextInput label="Mission" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Stabilize authentication" /><TextInput label="Success criteria" value={criteria()} onInput={(event) => setCriteria(event.currentTarget.value)} description="One criterion per line" placeholder="Sessions remain valid" /></div>
            <Textarea label="What do you want to accomplish?" value={intent()} onInput={(event) => setIntent(event.currentTarget.value)} placeholder="Analyze the application, distribute the investigation and verify the results." />
            <Button size="md" theme="blue" iconLeft="lucide-sparkles" loading={busy()} disabled={busy() || !title().trim() || !intent().trim() || !criteria().trim() || !app.canDispatch()} onClick={() => void start()}>Prepare plan proposal</Button>
          </WorkspaceSection>
          <Show when={error()}><Alert theme="red" variant="outline" title="Planning action failed" description={error()} /></Show>
          <WorkspaceSection title="Existing missions" description="Return to a durable mission without losing its planning history.">
            <ScreenRegion state={missionList.state()} onRetry={() => void missionList.refresh()} emptyTitle="No missions yet" emptyDescription="Describe the first goal above. Brain will prepare a reviewable strategy.">
              <div class="flex flex-col gap-2"><For each={visibleMissions()}>{(mission) => <SelectableListItem selected={selectedId() === mission.missionId} onClick={() => { setDirty(false); setParams({ mission: mission.missionId }); void proposal.refresh({ force: true }); }}>
                <strong class="break-words">{mission.title}</strong><span class="mt-1 block break-words text-caption text-ink-gray-6">v{mission.version} · {mission.successCriteria.length} success criteria</span>
              </SelectableListItem>}</For></div>
              <Show when={missions().length > MISSIONS_PAGE_SIZE}><div class="mt-4 flex justify-center border-t border-outline-gray-1 pt-3"><Pagination.Root count={missions().length} pageSize={MISSIONS_PAGE_SIZE} page={safeMissionPage()} onPageChange={setMissionPage} aria-label="Missions pagination"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /><Pagination.Range class="ms-2" /></Pagination.Root></div></Show>
            </ScreenRegion>
          </WorkspaceSection>
        </div>
        <WorkspaceSection title="Proposal canvas" description="Review each expected outcome, acceptance criterion and dependency before confirming tracked work.">
          <Show when={selectedId()} fallback={<EmptyPreview icon="lucide-list-tree" title="Your strategy will take shape here" description="Choose an existing mission or describe a new goal. The proposal will include editable steps, dependencies and acceptance criteria—not a blank panel." />}>
            <ScreenRegion state={proposal.state()} onRetry={() => void proposal.refresh()} emptyTitle="No planning request" emptyDescription="Generate a strategy for this mission.">
              <Show when={proposal.state().data?.state === "running"}><Alert theme="blue" variant="outline" title="Preparing a validated proposal" description="The mission is durable. No tasks have been created and no execution has started." /></Show>
              <Show when={proposal.state().data?.state === "failed"}><Alert theme="amber" variant="outline" title="No validated proposal yet" description={proposal.state().data?.error} /></Show>
              <Show when={proposal.state().data?.plan} keyed>{(plan) => <PageStack>
                <Alert theme={plan.state === "confirmed" ? "green" : "blue"} variant="outline" title={plan.state === "confirmed" ? "Human-confirmed tracked work" : "AI or manual proposal—not yet tracked"} description={plan.state === "confirmed" ? "This version has been confirmed. Its work items and acceptance evidence are managed on the board." : "Review and edit this strategy. Confirmation is a separate, explicit command against the mission's current version."} />
                <div><div class="flex flex-wrap items-center gap-2"><Badge variant="outline" theme="blue" label={`Plan revision ${plan.revision}`} /><StatusBadge kind="plan" status={plan.state} /><Show when={dirty()}><Badge theme="amber" label="Unsaved edits" /></Show></div><p class="brain-prose mt-3 text-interface text-ink-gray-7">{plan.summary}</p></div>
                <div class="flex flex-col gap-3"><For each={editedTasks()}>{(task, index) => <article class="border-y border-outline-gray-1 py-3">
                  <div class="mb-2 flex flex-wrap items-center gap-2"><span class="grid size-7 place-items-center rounded-full bg-surface-blue-2 text-caption font-medium text-ink-blue-8">{index() + 1}</span><Badge variant="outline" theme="gray" label={task.id} /><Show when={task.workflowId}><Badge variant="outline" theme="blue" label={task.workflowId} /></Show><Show when={task.estimatedMinutes}><Badge variant="outline" theme="gray" label={`${task.estimatedMinutes} min estimate`} /></Show></div>
                  <div class="brain-field-grid"><TextInput label={`Step ${index() + 1} expected outcome`} value={task.title} onInput={(event) => updateTask(index(), "title", event.currentTarget.value)} /><TextInput label="Depends on" value={task.dependsOn.join(", ")} description="Comma-separated task IDs; no dependency graph is inferred when empty" onInput={(event) => updateTask(index(), "dependsOn", event.currentTarget.value)} /></div>
                  <Textarea label="Acceptance criteria" value={task.criteria.join("\n")} onInput={(event) => updateTask(index(), "criteria", event.currentTarget.value)} />
                  <Show when={task.assignment}><p class="mt-2 text-caption text-ink-gray-6">Proposed assignment: {task.assignment?.kind} {task.assignment?.id} · {task.assignment?.role}</p></Show>
                </article>}</For></div>
                <div class="flex flex-wrap gap-3 border-t border-outline-gray-1 pt-4"><Button size="md" theme="blue" iconLeft="lucide-check-check" loading={busy()} disabled={busy() || !editedTasks().length || (plan.state === "confirmed" && !dirty())} onClick={() => void confirm()}>Confirm this plan</Button><Button size="md" variant="outline" iconLeft="lucide-undo-2" disabled={!dirty()} onClick={() => { setDirty(false); setEditedTasks(plan.tasks.map((task) => ({ ...task }))); }}>Reset edits</Button></div>
                <TechnicalDetails label="Plan version"><p class="break-all">{plan.planVersionId} · digest {plan.digest} · origin {plan.origin}</p></TechnicalDetails>
              </PageStack>}</Show>
            </ScreenRegion>
          </Show>
        </WorkspaceSection>
      </div>
      <Show when={selectedId()} keyed>{(missionId) => <MissionWorkItems missionId={missionId} />}</Show>
    </PageStack>
  </BrainPage>;
}
