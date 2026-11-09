import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { FormSheet } from "./BrainForm";
import type { Mission, PlanTask, PlanVersion, WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/**
 * What a person does with a parked work item (#39/#43): retry it, drop it, or
 * — as a new confirmed plan version, never an in-place edit — reassign it to
 * another member or change its title and acceptance criteria.
 */
export function ParkedActions(props: { item: WorkItem; onChanged: () => Promise<void> }): JSX.Element {
  const app = useApp();
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [member, setMember] = createSignal(props.item.assignment?.kind === "agent" ? props.item.assignment.id : "");
  const [title, setTitle] = createSignal(props.item.title);
  const [criteria, setCriteria] = createSignal(props.item.criteria.join("\n"));
  const [dropping, setDropping] = createSignal(false);
  const context = createScopedRead<{ mission: Mission; plan: PlanVersion }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const mission = (await query<Envelope<Mission>>({ queryType: "missions.get", workspaceId: scope.workspaceId, resourceId: props.item.missionId }, signal)).snapshot;
      const plan = (await query<Envelope<PlanVersion>>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: mission.activePlanVersionId ?? props.item.planVersionId }, signal)).snapshot;
      return { snapshot: { mission, plan }, asOf: new Date().toISOString(), sourceWatermark: 0 };
    },
  });
  const act = async (fn: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true); setError("");
    try { await fn(); await props.onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The change was refused."); } finally { setBusy(false); }
  };
  const move = (state: "ready" | "abandoned") => act(async () => {
    const result = await app.run("workItem.transition", { workItemId: props.item.workItemId, state }, { expectedVersion: props.item.version });
    if (!result.accepted) throw new Error(result.detail);
  });
  /** Proposes and confirms the confirmed plan with this item's task changed. */
  const revise = (change: (task: PlanTask) => PlanTask, summary: string) => act(async () => {
    const current = context.state().data;
    if (!current) throw new Error("The mission's plan is still loading.");
    const tasks = current.plan.tasks.map((task) => task.id === props.item.planTaskId ? change(task) : task);
    const proposed = await app.run("plan.propose", { missionId: props.item.missionId, origin: "manual", summary, tasks, ...(current.plan.team ? { team: current.plan.team } : {}) });
    if (!proposed.accepted || !proposed.resourceId) throw new Error(proposed.detail);
    const confirmed = await app.run("plan.confirm", { planVersionId: proposed.resourceId }, { expectedVersion: current.mission.version });
    if (!confirmed.accepted) throw new Error(confirmed.detail);
    await context.refresh({ force: true });
  });
  const lines = () => criteria().split("\n").map((line) => line.trim()).filter(Boolean);
  return <section aria-label="Parked work item" class="flex flex-col gap-3 rounded-control border border-outline-amber-3 p-3">
    <Alert theme="amber" variant="outline" title="Parked after repeated failures" description={props.item.blockedReason ?? "This work waits for a person. Independent work and the mission carry on."} />
    <Show when={error()}><Alert theme="red" variant="outline" title="The change was refused" description={error()} /></Show>
    <div class="flex flex-wrap gap-2">
      <Button variant="solid" theme="blue" iconLeft="lucide-rotate-ccw" disabled={busy()} onClick={() => void move("ready")}>Retry</Button>
      <Show when={!dropping()} fallback={<>
        <Button theme="red" iconLeft="lucide-trash-2" disabled={busy()} onClick={() => void move("abandoned")}>Confirm drop</Button>
        <Button variant="ghost" onClick={() => setDropping(false)}>Keep it</Button>
      </>}><Button variant="outline" iconLeft="lucide-trash-2" disabled={busy()} onClick={() => setDropping(true)}>Drop</Button></Show>
    </div>
    <Show when={context.state().data?.plan.team?.length}>
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-48 flex-1"><Select label="Reassign to" value={member() || null} onValueChange={(value) => setMember(value ?? "")}
          options={(context.state().data?.plan.team ?? []).map((entry) => ({ value: entry.memberId, label: `${entry.role} (${entry.memberId})` }))} /></div>
        <Button variant="outline" iconLeft="lucide-user-round-cog" disabled={busy() || !member() || (props.item.assignment?.kind === "agent" && props.item.assignment.id === member())}
          onClick={() => void revise((task) => ({ ...task, assignment: { kind: "agent", id: member(), role: task.assignment?.role ?? "specialist" } }), `Reassign ${props.item.title} to ${member()} after it parked`)}>Reassign</Button>
      </div>
    </Show>
    <div><Button variant="outline" iconLeft="lucide-pencil" disabled={busy()} onClick={() => setEditing(true)}>Edit the task</Button></div>
    <FormSheet open={editing()} onClose={() => setEditing(false)} title="Edit the task" description="Saving creates a new plan version; the parked task is re-planned, never edited in place."
      submit="Save as a new plan version" icon="lucide-save" busy={busy()} disabled={!title().trim() || !lines().length} error={error()} errorTitle="The change was refused"
      onSubmit={async () => { if (!busy() && title().trim() && lines().length) { await revise((task) => ({ ...task, title: title().trim(), criteria: lines() }), `Edit ${props.item.title} after it parked`); if (!error()) setEditing(false); } }}>
        <TextInput label="Task title" required value={title()} onInput={(event) => setTitle(event.currentTarget.value)} />
        <Textarea label="Task acceptance criteria" value={criteria()} onInput={(event) => setCriteria(event.currentTarget.value)} description="One criterion per line." />
    </FormSheet>
  </section>;
}
