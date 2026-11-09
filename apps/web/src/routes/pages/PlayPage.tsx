import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import type { AgentCatalogEntry, Mission, PlayView, WorkflowCatalogEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { EmptyPreview, FactStrip, QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { ActionFeedback } from "../../ui/components/ActionFeedback";
import { TaskReview } from "../../ui/components/TaskReview";
import type { TaskHandoff } from "../../ui/components/TaskReview";
import { SchedulesPanel } from "../../ui/components/SchedulesPanel";
import { formatDateTime, formatMicroUsd, titleize } from "../../ui/format";
import { missionHref } from "../../ui/mission-links";
import { AgentDetail, authorCandidate } from "../catalog";

type Catalog = { plays: PlayView[]; workflows: WorkflowCatalogEntry[]; agents: AgentCatalogEntry[] };
type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/**
 * `/plays/:id` (#25/#43): one Play — team roles, plan shape, brief, schedules
 * and triggers, the missions it started, and Start — or one single task, a
 * declared workflow treated as a one-task Play: its typed inputs are reviewed
 * and dispatched here, with its schedules and the agents it runs. A Play and a
 * task never share an id (the release compiler refuses it).
 */
export default function PlayPage(): JSX.Element {
  const app = useApp();
  const params = useParams();
  const catalog = createScopedRead<Catalog>({
    scope: app.scope,
    resource: () => params.id,
    load: async (scope, signal) => {
      const list = async <T,>(queryType: "plays.list" | "workflows.list" | "agents.list") => (await query<Envelope<{ items: T[] }>>({ queryType, workspaceId: scope.workspaceId }, signal)).snapshot.items;
      const [plays, workflows, agents] = await Promise.all([list<PlayView>("plays.list"), list<WorkflowCatalogEntry>("workflows.list"), list<AgentCatalogEntry>("agents.list")]);
      return { snapshot: { plays: [...plays], workflows: [...workflows], agents: [...agents] }, asOf: new Date().toISOString(), sourceWatermark: 0 };
    },
  });
  const play = () => catalog.state().data?.plays.find((entry) => entry.playId === params.id);
  const workflow = () => catalog.state().data?.workflows.find((entry) => entry.release.id === params.id);
  const title = () => play()?.title ?? (workflow() ? workflow()!.definition.spec.presentation?.title ?? titleize(workflow()!.release.id) : "Play");
  return <ScreenRegion state={catalog.state()} onRetry={() => void catalog.refresh({ force: true })} emptyTitle="Play not found" emptyDescription="No play or task with this id is in the active release.">
    <Switch fallback={<BrainPage title="Play not found" description="No play or task with this id is in the active release.">
      <EmptyPreview icon="lucide-book-open-check" title="Not in the active release" description="It may have been removed by a newer release. Open Plays to choose another." />
    </BrainPage>}>
      <Match when={play()} keyed>{(entry) => <PlayDetail play={entry} agents={catalog.state().data?.agents ?? []} />}</Match>
      <Match when={workflow()} keyed>{(entry) => <TaskDetail title={title()} workflow={entry} agents={catalog.state().data?.agents ?? []} />}</Match>
    </Switch>
  </ScreenRegion>;
}

function TeamRoles(props: { members: readonly { memberId: string; role: string; agentId: string; engine?: string }[]; agents: readonly AgentCatalogEntry[] }): JSX.Element {
  const [open, setOpen] = createSignal("");
  const agent = (id: string) => props.agents.find((entry) => entry.release.id === id);
  return <WorkspaceSection title="Team roles" description="Who works on it: each member is an agent definition on one engine.">
    <Show when={props.members.length} fallback={<p class="text-interface text-ink-gray-7">No agent runs as part of this.</p>}>
      <div class="brain-queue"><For each={props.members}>{(member) => <QueueRow title={member.role} description={`${titleize(member.agentId)}${member.engine ? ` on ${member.engine}` : ""}`} eyebrow={member.memberId} icon="lucide-bot"
        selected={open() === member.memberId} label={`Show agent ${member.agentId} for ${member.role}`} onClick={() => setOpen(open() === member.memberId ? "" : member.memberId)} />}</For></div>
      <Show when={props.members.find((member) => member.memberId === open())}>{(member) => <Show when={agent(member().agentId)} keyed fallback={<p class="mt-3 text-interface text-ink-gray-7">Agent {member().agentId} is not in the active release.</p>}>
        {(entry) => <div class="mt-4"><AgentDetail agent={entry} headingLevel={3} /></div>}
      </Show>}</Show>
    </Show>
  </WorkspaceSection>;
}

function PlayDetail(props: { play: PlayView; agents: readonly AgentCatalogEntry[] }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const detail = createScopedRead<PlayView>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<PlayView>>({ queryType: "plays.get", workspaceId: scope.workspaceId, resourceId: props.play.playId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const history = createScopedRead<Mission[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: Mission[] }>>({ queryType: "missions.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((mission) => mission.playId === props.play.playId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  const spec = () => detail.state().data?.spec;
  return <BrainPage title={props.play.title} description={props.play.description ?? "A mission template: team, plan shape and brief."}
    actions={<Button variant="solid" theme="blue" iconLeft="lucide-play" onClick={() => void navigate(`/w/${app.workspaceId()}/missions/new?play=${encodeURIComponent(props.play.playId)}`)}>Start a mission</Button>}>
    <PageStack>
      <FactStrip label="Play summary" items={[
        { label: "Team", value: String(props.play.team.length), hint: "Members on the mission team", icon: "lucide-users" },
        { label: "Plan", value: `${props.play.taskCount} tasks`, hint: "Proposed when a mission starts", icon: "lucide-list-tree" },
        { label: "Autonomy", value: props.play.autonomy ?? "standard", hint: "Capped by the workspace ceiling", icon: "lucide-shield" },
        { label: "Budget", value: spec()?.budget?.maxMicroUsd !== undefined ? formatMicroUsd(spec()!.budget!.maxMicroUsd!) : "Workspace default", hint: "Per mission", icon: "lucide-wallet" },
      ]} />
      <Show when={spec()}>{(brief) => <WorkspaceSection title="Brief" description="What every mission started from this play is asked to achieve.">
        <p class="brain-prose whitespace-pre-wrap text-interface text-ink-gray-8">{brief().intent}</p>
        <h3 class="mt-4 text-base-medium">Success criteria</h3>
        <ul class="mt-2 list-disc pl-5 text-interface"><For each={brief().successCriteria}>{(criterion) => <li>{criterion}</li>}</For></ul>
        <Show when={brief().constraints?.length}><h3 class="mt-4 text-base-medium">Constraints</h3><ul class="mt-2 list-disc pl-5 text-interface"><For each={brief().constraints}>{(constraint) => <li>{constraint}</li>}</For></ul></Show>
      </WorkspaceSection>}</Show>
      <TeamRoles members={props.play.team} agents={props.agents} />
      <Show when={spec()}>{(brief) => <WorkspaceSection title="Plan shape" description="The tasks proposed as the first plan version; the coordinator may revise it within the mission's autonomy.">
        <ol class="flex flex-col gap-2"><For each={brief().plan.tasks}>{(task, index) => <li class="rounded-control border border-outline-gray-1 p-3">
          <div class="flex flex-wrap items-center gap-2"><span class="text-base-medium">{index() + 1}. {task.title}</span>
            <Show when={task.dependsOn?.length}><Badge variant="outline" theme="gray" label={`after ${task.dependsOn!.join(", ")}`} /></Show>
            <Show when={task.outputs?.length}><Badge variant="outline" theme="blue" label={`outputs ${task.outputs!.join(", ")}`} /></Show></div>
          <ul class="mt-1 list-disc pl-5 text-caption text-ink-gray-7"><For each={task.criteria}>{(criterion) => <li>{criterion}</li>}</For></ul>
        </li>}</For></ol>
      </WorkspaceSection>}</Show>
      <SchedulesPanel scope={{ kind: "play", targets: [{ id: props.play.playId, label: props.play.title }] }} />
      <WorkspaceSection title="Missions started from this play" description="Newest first, whatever started them: a person, a schedule or a ticket or incident.">
        <ScreenRegion state={history.state()} onRetry={() => void history.refresh({ force: true })} emptyTitle="No missions yet" emptyDescription="Start the first mission from this play.">
          <div class="brain-queue"><For each={history.state().data ?? []}>{(mission) => <QueueRow title={mission.title} description={mission.intent} icon="lucide-flag"
            meta={<><span>{mission.state}{mission.outcome ? ` · ${mission.outcome}` : ""}</span><span>started {formatDateTime(mission.createdAt)}</span></>}
            label={`Open mission ${mission.title}`} onClick={() => void navigate(missionHref(app.workspaceId(), mission.missionId, "live"))} />}</For></div>
        </ScreenRegion>
      </WorkspaceSection>
    </PageStack>
  </BrainPage>;
}

function TaskDetail(props: { title: string; workflow: WorkflowCatalogEntry; agents: readonly AgentCatalogEntry[] }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [error, setError] = createSignal("");
  const agents = () => {
    const ids = new Set<string>();
    for (const job of Object.values(props.workflow.definition.spec.jobs)) if (job.kind === "dispatch" && job.uses.type === "agent") ids.add(job.uses.release.id);
    return [...ids].map((agentId) => ({ memberId: agentId, role: titleize(agentId), agentId }));
  };
  const handoff = (target: TaskHandoff) => {
    if (target.sessionId) void navigate(`/w/${app.workspaceId()}/live?session=${encodeURIComponent(target.sessionId)}`);
    else void navigate(`/runs/${target.runId}`);
  };
  const author = async (mode: "edit" | "duplicate") => {
    setError("");
    try { await authorCandidate(app, navigate, "Workflow", props.workflow.release.id, props.title, mode); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the task candidate"); }
  };
  return <BrainPage title={props.title} description="A single task: review its typed inputs, safety and readiness, then dispatch it."
    actions={<Show when={app.identity()?.actor.scopes.includes("config:activate")}><div class="flex flex-wrap gap-2">
      <Button variant="outline" iconLeft="lucide-copy" onClick={() => void author("duplicate")}>Clone as candidate</Button>
      <Button variant="outline" iconLeft="lucide-square-pen" onClick={() => void author("edit")}>Edit as candidate</Button>
    </div></Show>}>
    <PageStack>
      <ActionFeedback tone="error" message={error()} />
      <TaskReview workflow={props.workflow} onBack={() => void navigate(`/w/${app.workspaceId()}/plays`)} onStarted={handoff} />
      <TeamRoles members={agents()} agents={props.agents} />
      <SchedulesPanel scope={{ kind: "workflow", targets: [{ id: props.workflow.release.id, label: props.title }] }} />
    </PageStack>
  </BrainPage>;
}
