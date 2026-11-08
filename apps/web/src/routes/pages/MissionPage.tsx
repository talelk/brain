import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { BrainSession, ExecutionLink, WorkItem, Mission, MissionBrief, MissionMessage, Output, PlanVersion, SinceLastVisitSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack, TechnicalDetails } from "../../ui/components/PageLayout";
import { EmptyPreview, FactStrip, QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { MissionWorkItems } from "../../ui/components/MissionWorkItems";
import { SchedulesPanel } from "../../ui/components/SchedulesPanel";
import { formatDateTime } from "../../ui/format";
import { missionHref, type MissionTab } from "../../ui/mission-links";

const TABS: readonly { id: MissionTab; label: string }[] = [
  { id: "live", label: "Live" }, { id: "team", label: "Team" }, { id: "plan", label: "Plan" },
  { id: "brief", label: "Brief" }, { id: "logs", label: "Logs" }, { id: "outputs", label: "Outputs" },
];

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/**
 * One mission (#43): Live is the default view; Team, Plan, Brief, Logs and
 * Outputs are places within it. Every view reads Governor state; nothing here
 * confirms, approves or verifies by itself.
 */
export default function MissionPage(): JSX.Element {
  const app = useApp();
  const params = useParams();
  const navigate = useNavigate();
  const missionId = () => params.missionId ?? "";
  const tab = () => (TABS.some((entry) => entry.id === params.tab) ? params.tab : "live") as MissionTab;
  const read = <T,>(queryType: string, pick: (raw: unknown) => T, empty?: (value: T) => boolean) => createScopedRead<T>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<unknown>>({ queryType, workspaceId: scope.workspaceId, resourceId: missionId() } as never, signal);
      return { snapshot: pick(response.snapshot), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    ...(empty ? { isEmpty: empty } : {}),
    refreshMs: 15_000,
  });
  const mission = read<Mission>("missions.get", (raw) => raw as Mission);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function act(fn: () => Promise<unknown>): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try { await fn(); await mission.refresh({ force: true }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The command was refused."); }
    finally { setBusy(false); }
  }
  const current = () => mission.state().data;
  return <BrainPage title={current()?.title ?? "Mission"} description={current()?.intent}
    breadcrumbs={[{ label: "Missions", href: `/w/${app.workspaceId()}/missions` }, { label: current()?.title ?? missionId() }]}
    actions={<Show when={current()}>{(m) => <div class="flex flex-wrap gap-2">
      <Button size="md" variant="outline" iconLeft="lucide-eye" onClick={() => void act(() => app.run("mission.watch", { missionId: m().missionId, watch: true }))}>Watch</Button>
      <Show when={m().state === "active"}><Button size="md" variant="outline" iconLeft="lucide-pause" disabled={busy()} onClick={() => void act(() => app.run("mission.pause", { missionId: m().missionId }, { expectedVersion: m().version }))}>Pause</Button></Show>
      <Show when={m().state === "paused"}><Button size="md" variant="outline" iconLeft="lucide-play" disabled={busy()} onClick={() => void act(() => app.run("mission.resume", { missionId: m().missionId }, { expectedVersion: m().version }))}>Resume</Button></Show>
      <Show when={m().state === "active"}><Button size="md" variant="outline" iconLeft="lucide-badge-check" disabled={busy()} onClick={() => void act(() => app.run("mission.proposeCompletion", { missionId: m().missionId }, { expectedVersion: m().version }))}>Propose completion</Button></Show>
      <Show when={m().state !== "closed"}><Button size="md" variant="ghost" iconLeft="lucide-square" disabled={busy()} onClick={() => void act(() => app.run("mission.close", { missionId: m().missionId, outcome: "ended" }, { expectedVersion: m().version }))}>End mission</Button></Show>
    </div>}</Show>}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="The mission refused this change" description={error()} /></Show>
      <ScreenRegion state={mission.state()} onRetry={() => void mission.refresh({ force: true })} emptyTitle="Mission not found" emptyDescription="It may belong to another workspace.">
        <Show when={current()}>{(m) => <>
          <FactStrip label="Mission state" items={[
            { label: "State", value: `${m().state}${m().pauseReason ? ` (${m().pauseReason})` : ""}${m().outcome ? ` · ${m().outcome}` : ""}`, hint: `Brief version ${m().briefVersion}`, icon: "lucide-flag" },
            { label: "Spend", value: `${m().usage.settledMicroUsd + m().usage.reservedMicroUsd}${m().budget.maxMicroUsd !== undefined ? ` / ${m().budget.maxMicroUsd}` : ""} µUSD`, hint: `${m().usage.runningMembers} of ${m().budget.memberCap} members running`, icon: "lucide-wallet" },
            { label: "Autonomy", value: m().autonomyPolicy.preset ?? "custom", hint: `${m().autonomyPolicy.operations.length} operations · policy v${m().autonomyPolicy.version}`, icon: "lucide-shield" },
          ]} />
          <nav aria-label="Mission views" class="flex flex-wrap gap-1 border-b border-outline-gray-1 pb-2">
            <For each={TABS}>{(entry) => <Button size="sm" variant={tab() === entry.id ? "solid" : "ghost"} theme={tab() === entry.id ? "blue" : "gray"} aria-current={tab() === entry.id ? "page" : undefined}
              onClick={() => void navigate(missionHref(app.workspaceId(), m().missionId, entry.id))}>{entry.label}</Button>}</For>
          </nav>
          <Switch>
            <Match when={tab() === "live"}><LiveTab mission={m()} onAct={act} busy={busy()} /></Match>
            <Match when={tab() === "team"}><TeamTab mission={m()} /></Match>
            <Match when={tab() === "plan"}><PlanTab mission={m()} onAct={act} busy={busy()} /></Match>
            <Match when={tab() === "brief"}><BriefTab mission={m()} onAct={act} busy={busy()} /></Match>
            <Match when={tab() === "logs"}><LogsTab mission={m()} /></Match>
            <Match when={tab() === "outputs"}><OutputsTab mission={m()} /></Match>
          </Switch>
        </>}</Show>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}

function useMissionRead<T>(missionId: string, queryType: string, pick: (raw: unknown) => T, empty?: (value: T) => boolean) {
  const app = useApp();
  return createScopedRead<T>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<unknown>>({ queryType, workspaceId: scope.workspaceId, resourceId: missionId } as never, signal);
      return { snapshot: pick(response.snapshot), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    ...(empty ? { isEmpty: empty } : {}),
    refreshMs: 15_000,
  });
}

type ActProps = { mission: Mission; onAct: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean };

/** Live: what changed since you last looked, the team's running sessions and the composer (#38/#40). */
function LiveTab(props: ActProps): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const summary = useMissionRead<SinceLastVisitSummary>(props.mission.missionId, "missions.sinceLastVisit", (raw) => raw as SinceLastVisitSummary);
  const messages = useMissionRead<MissionMessage[]>(props.mission.missionId, "missionMessages.list", (raw) => [...(raw as { items: MissionMessage[] }).items], (items) => items.length === 0);
  const sessions = createScopedRead<BrainSession[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [all, items] = await Promise.all([
        query<Envelope<{ items: BrainSession[] }>>({ queryType: "sessions.list", workspaceId: scope.workspaceId }, signal),
        query<Envelope<{ items: Array<{ workItemId: string; missionId: string }> }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal),
      ]);
      const mine = new Set(items.snapshot.items.filter((item) => item.missionId === props.mission.missionId).map((item) => item.workItemId));
      return { snapshot: all.snapshot.items.filter((session) => session.workItemId && mine.has(session.workItemId)), asOf: all.asOf, sourceWatermark: all.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 10_000,
  });
  const [body, setBody] = createSignal("");
  const [interrupt, setInterrupt] = createSignal(false);
  return <div class="brain-studio-layout">
    <div class="brain-detail-stack">
      <WorkspaceSection title="While you were away" description="Notable events since you last looked; everything else is counted.">
        <ScreenRegion state={summary.state()} onRetry={() => void summary.refresh({ force: true })} emptyTitle="Nothing yet" emptyDescription="Events appear as the mission moves.">
          <Show when={summary.state().data}>{(s) => <>
            <Show when={s().notable.length} fallback={<p class="text-interface text-ink-gray-7">Nothing notable since your last visit.</p>}>
              <ul class="flex flex-col gap-1 text-interface"><For each={s().notable}>{(entry) => <li><span class="text-ink-gray-6">{formatDateTime(entry.at)}</span> · {entry.summary}</li>}</For></ul>
            </Show>
            <Show when={Object.keys(s().otherCounts).length}><p class="mt-2 text-caption text-ink-gray-6">Also: {Object.entries(s().otherCounts).map(([type, count]) => `${count} ${type}`).join(" · ")}</p></Show>
            <Button size="sm" variant="outline" class="mt-2" disabled={s().toCursor === s().fromCursor} onClick={() => void props.onAct(async () => { await app.run("mission.seen", { missionId: props.mission.missionId, cursor: s().toCursor }); await summary.refresh({ force: true }); })}>Mark as seen</Button>
          </>}</Show>
        </ScreenRegion>
      </WorkspaceSection>
      <WorkspaceSection title="Team at work" description="Sessions serving this mission's work items.">
        <ScreenRegion state={sessions.state()} onRetry={() => void sessions.refresh({ force: true })} emptyTitle="No sessions yet" emptyDescription="Sessions appear when the team's work is dispatched.">
          <div class="brain-queue"><For each={sessions.state().data ?? []}>{(session) => <QueueRow title={session.task || session.sessionId} description={`${session.agentId} · ${session.engine.id}`} icon="lucide-terminal"
            tone={session.state === "running" ? "blue" : session.state === "failed" ? "red" : "gray"} meta={<span>{session.state}</span>} onClick={() => void navigate(`/sessions/${session.sessionId}`)} />}</For></div>
        </ScreenRegion>
      </WorkspaceSection>
    </div>
    <WorkspaceSection title="Message the mission" description="Reaches the coordinator, or a running session when its engine can be steered. A message never approves anything.">
      <Textarea label="Message" value={body()} onInput={(event) => setBody(event.currentTarget.value)} placeholder="Prioritise the login flow" />
      <label class="mt-2 flex items-center gap-2 text-interface"><input type="checkbox" checked={interrupt()} onChange={(event) => setInterrupt(event.currentTarget.checked)} />Interrupt running sessions at their next safe point</label>
      <Button size="md" theme="blue" class="mt-2" iconLeft="lucide-send" disabled={!body().trim() || props.busy || props.mission.state === "closed"}
        onClick={() => void props.onAct(async () => { await app.run("mission.message.send", { missionId: props.mission.missionId, recipient: { kind: "mission" }, body: body().trim(), ...(interrupt() ? { interrupt: true } : {}) }); setBody(""); await messages.refresh({ force: true }); })}>Send message</Button>
      <ScreenRegion state={messages.state()} onRetry={() => void messages.refresh({ force: true })} emptyTitle="No messages" emptyDescription="Messages you send appear here with their delivery state.">
        <ul class="mt-3 flex flex-col gap-2"><For each={messages.state().data ?? []}>{(message) => <li class="rounded-control border border-outline-gray-1 p-2">
          <p class="break-words text-interface">{message.body}</p><p class="text-caption text-ink-gray-6">{message.senderId} · {message.delivery} · {formatDateTime(message.createdAt)}</p></li>}</For></ul>
      </ScreenRegion>
    </WorkspaceSection>
  </div>;
}

/** Team: the confirmed plan version's members, their roles, agents and engines (#37). */
function TeamTab(props: { mission: Mission }): JSX.Element {
  const app = useApp();
  const plan = createScopedRead<PlanVersion | null>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!props.mission.activePlanVersionId) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<Envelope<PlanVersion>>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: props.mission.activePlanVersionId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (value) => !value?.team?.length,
  });
  return <WorkspaceSection title="Mission team" description={`Up to ${props.mission.budget.memberCap} members run at once; ${props.mission.usage.runningMembers} running now.`}>
    <ScreenRegion state={plan.state()} onRetry={() => void plan.refresh({ force: true })} emptyTitle="No team yet" emptyDescription="A plan version with a team is proposed by a play or a coordinator and confirmed by a person.">
      <table class="w-full text-left text-interface"><thead><tr><th>Member</th><th>Role</th><th>Agent</th><th>Engine</th><th>Tasks</th></tr></thead>
        <tbody><For each={plan.state().data?.team ?? []}>{(member) => <tr>
          <td>{member.memberId}</td><td>{member.role}</td><td>{member.agentId}</td><td>{member.engine}</td>
          <td>{(plan.state().data?.tasks ?? []).filter((task) => task.assignment?.kind === "agent" && task.assignment.id === member.memberId).map((task) => task.title).join(", ") || "—"}</td>
        </tr>}</For></tbody></table>
    </ScreenRegion>
  </WorkspaceSection>;
}

/** Plan: a pending proposal (?proposal=) against the confirmed version, then the mission's work items (#37/#39/#43). */
function PlanTab(props: ActProps): JSX.Element {
  const app = useApp();
  const [search] = useSearchParams();
  const proposalId = () => typeof search.proposal === "string" ? search.proposal : "";
  const versions = createScopedRead<{ confirmed?: PlanVersion; proposal?: PlanVersion }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const get = async (id: string) => (await query<Envelope<PlanVersion>>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: id }, signal)).snapshot;
      const confirmed = props.mission.activePlanVersionId ? await get(props.mission.activePlanVersionId) : undefined;
      const proposal = proposalId() ? await get(proposalId()) : undefined;
      return { snapshot: { ...(confirmed ? { confirmed } : {}), ...(proposal ? { proposal } : {}) }, asOf: new Date().toISOString(), sourceWatermark: 0 };
    },
  });
  const confirmed = () => versions.state().data?.confirmed;
  return <PageStack>
    <WorkspaceSection title="Plan version" description="Confirmed work and any proposal waiting for a person.">
      <Show when={confirmed()} fallback={<EmptyPreview icon="lucide-list-tree" title="No confirmed plan yet" description="Open a proposal from Needs you, or prepare one from Plans." />}>
        {(plan) => <p class="text-interface">Revision {plan().revision} · {plan().tasks.length} tasks{plan().team?.length ? ` · ${plan().team!.length} members` : ""}</p>}
      </Show>
      <Show when={versions.state().data?.proposal}>{(p) => <section class="mt-3 rounded-control border border-outline-gray-2 p-3" aria-label="Plan proposal">
        <p class="text-base-medium">Proposal: revision {p().revision} · {p().state} · {p().origin}</p>
        <p class="text-interface text-ink-gray-7">Added: {p().tasks.filter((task) => !confirmed()?.tasks.some((other) => other.id === task.id)).map((task) => task.title).join(", ") || "none"}; removed: {(confirmed()?.tasks ?? []).filter((task) => !p().tasks.some((other) => other.id === task.id)).map((task) => task.title).join(", ") || "none"}</p>
        <Show when={p().team?.length}><p class="text-interface text-ink-gray-7">Team: {p().team!.map((member) => `${member.memberId} (${member.role})`).join(", ")}</p></Show>
        <Show when={p().state === "proposed"}><Button size="md" theme="blue" class="mt-2" disabled={props.busy}
          onClick={() => void props.onAct(async () => { await app.run("plan.confirm", { planVersionId: p().planVersionId }, { expectedVersion: props.mission.version }); await versions.refresh({ force: true }); })}>Confirm this plan version</Button></Show>
      </section>}</Show>
    </WorkspaceSection>
    <MissionWorkItems missionId={props.mission.missionId} />
    <MissionSchedules missionId={props.mission.missionId} />
  </PageStack>;
}

/** Scheduled starts of this mission's work items (automation target kind workItem). */
function MissionSchedules(props: { missionId: string }): JSX.Element {
  const app = useApp();
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((item) => item.missionId === props.missionId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  return <Show when={items.state().data?.length}>
    <SchedulesPanel title="Scheduled work item starts" scope={{ kind: "workItem", targets: (items.state().data ?? []).map((item) => ({ id: item.workItemId, label: item.title })) }} />
  </Show>;
}

/** Brief: human-owned intent and constraints, immutable accepted decisions, derived progress (#34). */
function BriefTab(props: ActProps): JSX.Element {
  const app = useApp();
  const brief = useMissionRead<MissionBrief>(props.mission.missionId, "missions.brief", (raw) => raw as MissionBrief);
  const [intent, setIntent] = createSignal<string | undefined>();
  const [constraints, setConstraints] = createSignal<string | undefined>();
  const [decision, setDecision] = createSignal("");
  return <ScreenRegion state={brief.state()} onRetry={() => void brief.refresh({ force: true })} emptyTitle="No brief" emptyDescription="Every mission starts with a brief.">
    <Show when={brief.state().data}>{(b) => <PageStack>
      <WorkspaceSection title={`Brief, version ${b().version}`} description={`${b().writtenChars} of 8000 written characters · updated ${formatDateTime(b().updatedAt)}`}>
        <Textarea label="Intent" value={intent() ?? b().intent} onInput={(event) => setIntent(event.currentTarget.value)} />
        <Textarea label="Constraints (one per line)" value={constraints() ?? b().constraints.join("\n")} onInput={(event) => setConstraints(event.currentTarget.value)} />
        <Button size="md" theme="blue" class="mt-2" disabled={props.busy || (intent() === undefined && constraints() === undefined)}
          onClick={() => void props.onAct(async () => {
            await app.run("mission.brief.edit", { missionId: props.mission.missionId, baseVersion: b().version, ...(intent() !== undefined ? { intent: intent()! } : {}), ...(constraints() !== undefined ? { constraints: constraints()!.split("\n").map((line) => line.trim()).filter(Boolean) } : {}) });
            setIntent(undefined); setConstraints(undefined); await brief.refresh({ force: true });
          })}>Save brief</Button>
      </WorkspaceSection>
      <WorkspaceSection title="Accepted decisions" description="Immutable entries; a later decision supersedes, never edits.">
        <ul class="flex flex-col gap-2"><For each={b().decisions}>{(entry) => <li class={entry.supersededBy ? "text-ink-gray-5 line-through" : ""}>
          {entry.statement} <span class="text-caption text-ink-gray-6">· {entry.source.kind} · accepted by {entry.acceptedBy} in v{entry.introducedInVersion}</span></li>}</For></ul>
        <div class="mt-3 flex flex-wrap items-end gap-2">
          <TextInput label="New decision" value={decision()} onInput={(event) => setDecision(event.currentTarget.value)} />
          <Button size="md" variant="outline" disabled={!decision().trim() || props.busy} onClick={() => void props.onAct(async () => { await app.run("decision.accept", { missionId: props.mission.missionId, baseVersion: b().version, statement: decision().trim(), source: { kind: "human" } }); setDecision(""); await brief.refresh({ force: true }); })}>Accept decision</Button>
        </div>
      </WorkspaceSection>
      <WorkspaceSection title="Progress" description="Derived from work items; nobody writes it.">
        <p class="text-interface">{b().progress.total} work items · {Object.entries(b().progress.byState).map(([state, count]) => `${count} ${state}`).join(" · ") || "none yet"}</p>
      </WorkspaceSection>
    </PageStack>}</Show>
  </ScreenRegion>;
}

/** Logs: the mission's runs, each opening the Log Explorer filtered to it. */
function LogsTab(props: { mission: Mission }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const links = createScopedRead<ExecutionLink[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: ExecutionLink[] }>>({ queryType: "executionLinks.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((link) => link.missionId === props.mission.missionId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  return <WorkspaceSection title="Mission runs" description="Every run linked to this mission's work.">
    <ScreenRegion state={links.state()} onRetry={() => void links.refresh({ force: true })} emptyTitle="No runs yet" emptyDescription="Runs appear once work is dispatched.">
      <div class="brain-queue"><For each={links.state().data ?? []}>{(link) => <QueueRow title={link.runId} description={`Work item ${link.workItemId}`} icon="lucide-scroll-text"
        meta={<span>{formatDateTime(link.createdAt)}</span>} label={`Open logs for run ${link.runId}`} onClick={() => void navigate(`/w/${app.workspaceId()}/logs?run=${encodeURIComponent(link.runId)}`)} />}</For></div>
    </ScreenRegion>
  </WorkspaceSection>;
}

/** Outputs: named outputs with their immutable versions and verification (#41). */
function OutputsTab(props: { mission: Mission }): JSX.Element {
  const outputs = useMissionRead<Output[]>(props.mission.missionId, "missionOutputs.list", (raw) => [...(raw as { items: Output[] }).items], (items) => items.length === 0);
  return <WorkspaceSection title="Mission outputs" description="Named outputs; only verified final versions are consumed by other work.">
    <ScreenRegion state={outputs.state()} onRetry={() => void outputs.refresh({ force: true })} emptyTitle="No outputs yet" emptyDescription="Outputs appear when work records a version of a named output.">
      <For each={outputs.state().data ?? []}>{(output) => <div class="mb-3 border-b border-outline-gray-1 pb-2">
        <p class="text-base-medium">{output.name}<Show when={output.continues}> <span class="text-caption text-ink-gray-6">continues {output.continues}</span></Show></p>
        <ul class="text-interface"><For each={output.versions}>{(version) => <li class="flex flex-wrap items-center gap-2">
          <Badge variant="outline" theme={version.verified ? "green" : "gray"} label={version.verified ? "verified" : version.state} />
          <code class="break-all text-caption">{version.artifactDigest}</code><span class="text-caption text-ink-gray-6">{formatDateTime(version.createdAt)}</span></li>}</For></ul>
      </div>}</For>
      <TechnicalDetails label="About output versions"><p>Versions are immutable. A task input pins one exact verified final version when its attempt is admitted.</p></TechnicalDetails>
    </ScreenRegion>
  </WorkspaceSection>;
}
