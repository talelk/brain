import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import type { AgentCatalogEntry, Mission, PlanTask, TeamMember, WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { agentFits, assignedMember, ineligibleSteps, memberIdFor, memberLabel, whyNotEligible, isStartedWork, type AgentFit } from "../work/plan-team";
import { titleize } from "../format";
import { t } from "../../i18n";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** What the plan editor reads besides the plan: the agents a member can be bound to, and which steps and members already have started work. */
export function createPlanTeamData(mission: () => Mission): { agents: () => AgentFit[] | undefined; startedSteps: () => ReadonlySet<string>; lockedMembers: () => ReadonlySet<string> } {
  const app = useApp();
  const agents = createScopedRead<AgentFit[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const view = await query<Envelope<{ items: AgentCatalogEntry[] }>>({ queryType: "agents.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: agentFits(view.snapshot.items), asOf: view.asOf, sourceWatermark: view.sourceWatermark };
    },
  });
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    resource: () => mission().missionId,
    load: async (scope, signal, missionId) => {
      const view = await query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: view.snapshot.items.filter((item) => item.missionId === missionId && isStartedWork(item)), asOf: view.asOf, sourceWatermark: view.sourceWatermark };
    },
  });
  const started = createMemo(() => items.state().data ?? []);
  return {
    agents: () => agents.state().data,
    startedSteps: createMemo(() => new Set(started().map((item) => item.planTaskId))),
    lockedMembers: createMemo(() => new Set(started().flatMap((item) => (item.assignment?.kind === "agent" ? [item.assignment.id] : [])))),
  };
}

/** Who a step is assigned to. A member that cannot take the step stays in the list, disabled, with the reason; started work cannot be handed over. */
export function StepAssignment(props: { task: PlanTask; position: number; team: readonly TeamMember[]; agents: readonly AgentFit[] | undefined; started: boolean; onAssign: (memberId: string) => void }): JSX.Element {
  const NONE = "__none";
  const current = () => props.task.assignment;
  const fit = (member: TeamMember) => props.agents?.find((agent) => agent.agentId === member.agentId);
  const outside = () => (current() && !assignedMember(props.task, props.team) ? current() : undefined);
  const options = () => [
    { value: NONE, label: t("plan.team.unassigned"), description: t("plan.team.unassigned-hint") },
    ...props.team.map((member) => {
      const reason = whyNotEligible(fit(member), props.task);
      return { value: member.memberId, label: memberLabel(member), description: reason ? t("plan.team.not-eligible", { reason }) : t("plan.team.runs-on", { agent: titleize(member.agentId), engine: member.engine }), disabled: reason !== undefined };
    }),
    ...(outside() ? [{ value: outside()!.id, label: `${outside()!.kind}: ${outside()!.id}`, description: t("plan.team.not-on-team"), disabled: true }] : []),
  ];
  const problem = () => ineligibleSteps([props.task], props.team, props.agents)[0]?.reason;
  return <div class="flex flex-col gap-1.5" data-testid="plan-step-assignment">
    <Select label={t("plan.team.assigned-to-step", { step: props.position })} value={current()?.id ?? NONE} disabled={props.started} options={options()}
      onValueChange={(value) => props.onAssign(!value || value === NONE ? "" : value)} />
    <Show when={props.started}><p class="text-caption text-ink-gray-6" data-testid="plan-step-started">{t("plan.team.started")}</p></Show>
    <Show when={problem()}>{(reason) => <Alert theme="red" variant="outline" title={t("plan.team.cannot-take", { step: props.task.title })} description={reason()} />}</Show>
  </div>;
}

/** The mission team in the editor: members can be added and dropped, never rebound, and a member serving a step or started work stays. */
export function TeamSection(props: { team: readonly TeamMember[]; tasks: readonly PlanTask[]; agents: readonly AgentFit[] | undefined; locked: ReadonlySet<string>; onChange: (team: TeamMember[]) => void }): JSX.Element {
  const [role, setRole] = createSignal("");
  const [agentId, setAgentId] = createSignal("");
  const [engine, setEngine] = createSignal("");
  const agent = (): AgentFit | undefined => props.agents?.find((entry) => entry.agentId === agentId()) ?? props.agents?.[0];
  const engineValue = (): string => (agent()?.engines.includes(engine()) ? engine() : agent()?.engines[0] ?? "");
  const steps = (member: TeamMember) => props.tasks.filter((task) => task.assignment?.kind === "agent" && task.assignment.id === member.memberId).length;
  const keepReason = (member: TeamMember): string | undefined => props.locked.has(member.memberId) ? t("plan.team.serves-started") : steps(member) > 0 ? t("plan.team.serves-steps", { n: steps(member) }) : undefined;
  const add = () => {
    const chosen = agent();
    if (!chosen || !role().trim()) return;
    props.onChange([...props.team, { memberId: memberIdFor(role(), props.team.map((member) => member.memberId)), role: role().trim(), agentId: chosen.agentId, engine: engineValue() }]);
    setRole("");
  };
  return <section class="flex flex-col gap-3 border-b border-outline-gray-1 pb-4" aria-label={t("plan.team.title")} data-testid="plan-team">
    <div class="flex flex-col gap-0.5"><h3 class="text-base-medium text-ink-gray-9">{t("plan.team.title")}</h3><p class="text-caption text-ink-gray-6">{t("plan.team.description")}</p></div>
    <Show when={props.team.length} fallback={<p class="text-interface text-ink-gray-7">{t("plan.team.empty")}</p>}>
      <ul class="flex flex-col gap-2">
        <For each={props.team}>{(member) => <li class="flex flex-wrap items-center gap-2 rounded-control border border-outline-gray-1 px-3 py-2" data-testid="plan-team-member" data-member-id={member.memberId}>
          <span class="lucide-bot size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
          <span class="min-w-0 flex-1 break-words text-interface text-ink-gray-9"><span class="font-medium">{memberLabel(member)}</span> <span class="text-ink-gray-6">{t("plan.team.runs-on", { agent: titleize(member.agentId), engine: member.engine })}</span></span>
          <Show when={keepReason(member)} fallback={<Button size="sm" variant="ghost" theme="red" iconLeft="lucide-user-round-minus" aria-label={t("plan.team.remove-member", { member: memberLabel(member) })} onClick={() => props.onChange(props.team.filter((entry) => entry.memberId !== member.memberId))}>{t("plan.team.remove")}</Button>}>
            {(reason) => <Badge variant="outline" theme="gray" label={reason()} />}
          </Show>
        </li>}</For>
      </ul>
    </Show>
    <Show when={props.agents?.length} fallback={<p class="text-caption text-ink-gray-6">{t("plan.team.no-agents")}</p>}>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="plan-team-add">
        <TextInput label={t("plan.team.role")} value={role()} onInput={(event) => setRole(event.currentTarget.value)} description={t("plan.team.role-hint")} />
        <Select label={t("plan.team.agent")} value={agent()?.agentId ?? null} onValueChange={(value) => setAgentId(value ?? "")} options={(props.agents ?? []).map((entry) => ({ value: entry.agentId, label: titleize(entry.agentId), description: entry.tools.length ? t("plan.team.has-tools", { n: entry.tools.length }) : t("plan.team.no-tools") }))} />
        <Select label={t("plan.team.engine")} value={engineValue() || null} onValueChange={(value) => setEngine(value ?? "")} options={(agent()?.engines ?? []).map((value) => ({ value, label: value }))} />
        <div class="flex items-end"><Button variant="outline" iconLeft="lucide-user-round-plus" disabled={!role().trim() || !agent()} onClick={add}>{t("plan.team.add")}</Button></div>
      </div>
    </Show>
  </section>;
}
