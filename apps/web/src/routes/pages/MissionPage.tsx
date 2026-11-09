import { createEffect, createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { Badge, Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import type { BrainSession, ExecutionLink, TeamMember, WorkItem, Mission, MissionBrief, MissionMessage, Output, PlanVersion, SinceLastVisitSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { FormSheet } from "../../ui/components/BrainForm";
import { ReasonDialog } from "../../ui/components/ReasonDialog";
import { BrainPage, PageStack, TechnicalDetails } from "../../ui/components/PageLayout";
import { EmptyPreview, FactStrip, QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { MissionWorkItems } from "../../ui/components/MissionWorkItems";
import { SchedulesPanel } from "../../ui/components/SchedulesPanel";
import { PlanCanvas } from "../../ui/components/PlanCanvas";
import { formatDateTime } from "../../ui/format";
import { missionHref, type MissionTab } from "../../ui/mission-links";
import { ConsoleScreen } from "../../ui/console/ConsoleLayout";
import { SessionTranscript } from "../../ui/console/SessionTranscript";
import { readExecFilters, writeExecFilters } from "../../ui/exec/exec-filters";

const TABS: readonly { id: MissionTab; label: string }[] = [
  { id: "live", label: "Live" }, { id: "team", label: "Team" }, { id: "plan", label: "Plan" },
  { id: "brief", label: "Brief" }, { id: "logs", label: "Logs" }, { id: "outputs", label: "Outputs" },
];

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/**
 * The one obvious next move for this mission, derived from its real state:
 * no plan → prepare one; ready tasks → start them; work running → follow it
 * live; everything verified → review the outputs. Each step links to the tab
 * where it is done, so the lifecycle reads brief → plan → start → live → outputs.
 */
function NextStep(props: { mission: Mission; tab: MissionTab }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((item) => item.missionId === props.mission.missionId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    refreshMs: 5000,
  });
  const step = (): { icon: string; title: string; detail: string; action?: { label: string; tab: MissionTab } } | undefined => {
    const m = props.mission;
    if (m.state === "closed") return undefined;
    const list = items.state().data ?? [];
    const count = (state: string) => list.filter((item) => item.state === state).length;
    if (!m.activePlanVersionId) return { icon: "lucide-list-tree", title: "Next: prepare a plan", detail: "No plan is confirmed yet. Ask Brain for a proposal, review it, then confirm.", ...(props.tab !== "plan" ? { action: { label: "Open the plan", tab: "plan" as MissionTab } } : {}) };
    if (count("in-progress") > 0) return { icon: "lucide-radio", title: `${count("in-progress")} task${count("in-progress") === 1 ? " is" : "s are"} running`, detail: "Follow the agents' messages and tool activity as they work.", ...(props.tab !== "live" ? { action: { label: "Follow in Live", tab: "live" as MissionTab } } : {}) };
    if (count("ready") > 0) return { icon: "lucide-play", title: `Next: start ${count("ready")} ready task${count("ready") === 1 ? "" : "s"}`, detail: "The plan is confirmed. A task runs only when it is started.", ...(props.tab !== "plan" ? { action: { label: "Start tasks", tab: "plan" as MissionTab } } : {}) };
    if (count("review") > 0 || count("blocked") > 0) return { icon: "lucide-badge-check", title: "Next: review and unblock work", detail: `${count("review")} in review · ${count("blocked")} blocked. Done needs verified evidence.`, ...(props.tab !== "plan" ? { action: { label: "Open the work", tab: "plan" as MissionTab } } : {}) };
    if (list.length > 0 && list.every((item) => item.state === "done")) return { icon: "lucide-package", title: "All work is done", detail: "Review the outputs, then propose completion from the header.", ...(props.tab !== "outputs" ? { action: { label: "Review outputs", tab: "outputs" as MissionTab } } : {}) };
    return undefined;
  };
  return <Show when={step()}>{(next) => <div role="status" class="flex flex-wrap items-center gap-3 rounded-card border border-outline-blue-1 bg-surface-blue-1 px-3 py-2">
    <span class={`${next().icon} size-5 shrink-0 text-ink-blue-8`} aria-hidden="true" />
    <div class="min-w-0 flex-1"><p class="text-base-medium text-ink-gray-9">{next().title}</p><p class="text-interface text-ink-gray-7">{next().detail}</p></div>
    <Show when={next().action}>{(action) => <Button variant="solid" theme="blue" iconRight="lucide-arrow-right" onClick={() => void navigate(missionHref(app.workspaceId(), props.mission.missionId, action().tab))}>{action().label}</Button>}</Show>
  </div>}</Show>;
}

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
  // The mission's workspace (?w=) wins over the current selection, so links
  // from other workspaces' attention items and push notifications resolve.
  const [where] = useSearchParams();
  createEffect(() => {
    const target = typeof where.w === "string" ? where.w : "";
    if (target && target !== app.workspaceId() && app.workspaceOptions().some((option) => option.value === target)) app.selectWorkspace(target);
  });
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
      <Button variant={m().watching ? "solid" : "outline"} iconLeft={m().watching ? "lucide-eye-off" : "lucide-eye"} aria-pressed={m().watching ? "true" : "false"} disabled={busy()} onClick={() => void act(() => app.run("mission.watch", { missionId: m().missionId, watch: !m().watching }))}>{m().watching ? "Unwatch" : "Watch"}</Button>
      <Show when={m().state === "active"}><Button variant="outline" iconLeft="lucide-pause" disabled={busy()} onClick={() => void act(() => app.run("mission.pause", { missionId: m().missionId }, { expectedVersion: m().version }))}>Pause</Button></Show>
      <Show when={m().state === "paused"}><Button variant="outline" iconLeft="lucide-play" disabled={busy()} onClick={() => void act(() => app.run("mission.resume", { missionId: m().missionId }, { expectedVersion: m().version }))}>Resume</Button></Show>
      <Show when={m().state === "active"}><Button variant="outline" iconLeft="lucide-badge-check" disabled={busy()} onClick={() => void act(() => app.run("mission.proposeCompletion", { missionId: m().missionId }, { expectedVersion: m().version }))}>Propose completion</Button></Show>
      <Show when={m().state !== "closed"}><Button variant="ghost" iconLeft="lucide-square" disabled={busy()} onClick={() => void act(() => app.run("mission.close", { missionId: m().missionId, outcome: "ended" }, { expectedVersion: m().version }))}>End mission</Button></Show>
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
          <NextStep mission={m()} tab={tab()} />
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

/**
 * Live, the mission cockpit (T60, #27/#38/#40): what changed since you last
 * looked, the team rail (members with their sessions), the console limited to
 * this mission's sessions — filtered to one member when chosen — and the
 * composer that messages the mission or one member, may interrupt at the next
 * safe point and may also add the message to the brief as a constraint.
 * Active and historical sessions share this layout; state alone differs.
 */
function LiveTab(props: ActProps): JSX.Element {
  const app = useApp();
  const [search, setSearch] = useSearchParams();
  const summary = useMissionRead<SinceLastVisitSummary>(props.mission.missionId, "missions.sinceLastVisit", (raw) => raw as SinceLastVisitSummary);
  const messages = useMissionRead<MissionMessage[]>(props.mission.missionId, "missionMessages.list", (raw) => [...(raw as { items: MissionMessage[] }).items], (items) => items.length === 0);
  const brief = useMissionRead<MissionBrief>(props.mission.missionId, "missions.brief", (raw) => raw as MissionBrief);
  const team = createScopedRead<{ members: TeamMember[]; items: WorkItem[]; sessions: BrainSession[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [plan, items, sessions] = await Promise.all([
        props.mission.activePlanVersionId ? query<Envelope<PlanVersion>>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: props.mission.activePlanVersionId }, signal) : Promise.resolve(undefined),
        query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal),
        query<Envelope<{ items: BrainSession[] }>>({ queryType: "sessions.list", workspaceId: scope.workspaceId }, signal),
      ]);
      const mine = items.snapshot.items.filter((item) => item.missionId === props.mission.missionId);
      const ids = new Set(mine.map((item) => item.workItemId));
      return { snapshot: { members: [...(plan?.snapshot.team ?? [])], items: mine, sessions: sessions.snapshot.items.filter((session) => session.workItemId && ids.has(session.workItemId)) }, asOf: sessions.asOf, sourceWatermark: sessions.sourceWatermark };
    },
    refreshMs: 10_000,
  });
  const member = () => (typeof search.member === "string" ? search.member : "");
  const memberOf = (session: BrainSession) => {
    const item = team.state().data?.items.find((entry) => entry.workItemId === session.workItemId);
    return item?.assignment?.kind === "agent" ? item.assignment.id : "";
  };
  const sessionsOf = (memberId: string) => (team.state().data?.sessions ?? []).filter((session) => memberOf(session) === memberId);
  const inScope = (session: BrainSession) => (team.state().data?.sessions ?? []).some((entry) => entry.sessionId === session.sessionId) && (!member() || memberOf(session) === member());
  const filters = () => readExecFilters(search);
  // Split compare (?compare=a,b): two of the mission's sessions side by side.
  const compared = () => (typeof search.compare === "string" ? search.compare.split(",").filter(Boolean).slice(0, 2) : []);
  const sessionLabel = (id: string) => {
    const session = team.state().data?.sessions.find((entry) => entry.sessionId === id);
    return session ? `${session.task || session.sessionId}${memberOf(session) ? ` · ${memberOf(session)}` : ""}` : id;
  };
  const setCompared = (index: 0 | 1, value: string) => {
    const next = [...compared()]; next[index] = value;
    setSearch({ compare: next.filter(Boolean).length ? next.join(",") : undefined });
  };
  const [body, setBody] = createSignal("");
  const [recipient, setRecipient] = createSignal("mission");
  const [interrupt, setInterrupt] = createSignal(false);
  const [addToBrief, setAddToBrief] = createSignal(false);
  const [composeOpen, setComposeOpen] = createSignal(false);
  const send = () => void props.onAct(async () => {
    const text = body().trim();
    const sent = await app.run("mission.message.send", { missionId: props.mission.missionId, recipient: recipient() === "mission" ? { kind: "mission" } : { kind: "member", memberId: recipient() }, body: text, ...(interrupt() ? { interrupt: true } : {}) });
    if (!sent.accepted) throw new Error(sent.detail);
    const current = brief.state().data;
    if (addToBrief() && current) {
      const edited = await app.run("mission.brief.edit", { missionId: props.mission.missionId, baseVersion: current.version, constraints: [...current.constraints, text.slice(0, 1000)] });
      if (!edited.accepted) throw new Error(edited.detail);
      await brief.refresh({ force: true });
    }
    setBody(""); setAddToBrief(false); setComposeOpen(false);
    await messages.refresh({ force: true });
  });
  return <PageStack>
    <div class="brain-studio-layout">
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
      <WorkspaceSection title="Messages" description="Reaches the coordinator or one member's running session when its engine can be steered. A message never approves anything." actions={<Button variant="solid" theme="blue" iconLeft="lucide-send" disabled={props.mission.state === "closed"} onClick={() => setComposeOpen(true)}>Message the mission</Button>}>
        <FormSheet open={composeOpen()} onClose={() => setComposeOpen(false)} title="Message the mission" description="A message never approves anything." submit="Send" icon="lucide-send" busy={props.busy} disabled={!body().trim() || props.mission.state === "closed"} onSubmit={() => { if (body().trim() && !props.busy) send(); }}>
        <Select label="Recipient" value={recipient()} onValueChange={(value) => setRecipient(value ?? "mission")}
          options={[{ value: "mission", label: "The mission (coordinator)" }, ...(team.state().data?.members ?? []).map((entry) => ({ value: entry.memberId, label: `${entry.role} (${entry.memberId})` }))]} />
        <Textarea label="Message" required value={body()} onInput={(event) => setBody(event.currentTarget.value)} placeholder="Prioritise the login flow" />
        <Checkbox label="Interrupt running sessions at their next safe point" checked={interrupt()} onCheckedChange={(checked) => setInterrupt(checked === true)} />
        <Checkbox label="Also add to the brief as a constraint" checked={addToBrief()} onCheckedChange={(checked) => setAddToBrief(checked === true)} />
        </FormSheet>
        <ScreenRegion state={messages.state()} onRetry={() => void messages.refresh({ force: true })} emptyTitle="No messages" emptyDescription="Messages you send appear here with their delivery state.">
          <ul class="mt-3 flex flex-col gap-2"><For each={(messages.state().data ?? []).slice(0, 5)}>{(message) => <li class="rounded-control border border-outline-gray-1 p-2">
            <p class="break-words text-interface">{message.body}</p><p class="text-caption text-ink-gray-6">{message.recipient.kind === "member" ? `to ${message.recipient.memberId} · ` : ""}{message.senderId} · {message.delivery} · {formatDateTime(message.createdAt)}</p></li>}</For></ul>
        </ScreenRegion>
      </WorkspaceSection>
    </div>
    <WorkspaceSection title="Team" description="Choose a member to follow only their sessions in the console.">
      <div class="brain-queue">
        <QueueRow title="Whole team" description={`${team.state().data?.sessions.length ?? 0} sessions`} icon="lucide-users" selected={!member()} label="Follow the whole team" onClick={() => setSearch({ member: undefined, session: undefined })} />
        <For each={team.state().data?.members ?? []}>{(entry) => <QueueRow title={entry.role} description={`${entry.agentId} · ${entry.engine}`} eyebrow={entry.memberId} icon="lucide-bot"
          tone={sessionsOf(entry.memberId).some((session) => session.state === "running") ? "blue" : "gray"} selected={member() === entry.memberId}
          meta={<span>{sessionsOf(entry.memberId).filter((session) => session.state === "running").length} running · {sessionsOf(entry.memberId).length} sessions</span>}
          label={`Follow ${entry.role} (${entry.memberId})`} onClick={() => setSearch({ member: entry.memberId, session: undefined })} />}</For>
      </div>
    </WorkspaceSection>
    <WorkspaceSection title="Compare two sessions" description="Follow two members' sessions side by side; each keeps its own filters and live tail."
      actions={<Show when={compared().length}><Button variant="outline" iconLeft="lucide-x" onClick={() => setSearch({ compare: undefined })}>Close comparison</Button></Show>}>
      <div class="brain-field-grid">
        <For each={[0, 1] as const}>{(index) => <Select label={index === 0 ? "Left session" : "Right session"} value={compared()[index] ?? ""} onValueChange={(value) => setCompared(index, value ?? "")}
          options={(team.state().data?.sessions ?? []).map((session) => ({ value: session.sessionId, label: sessionLabel(session.sessionId) }))} />}</For>
      </div>
      <Show when={compared().length === 2 && compared()[0] !== compared()[1]}>
        <div class="mt-3 grid gap-3 lg:grid-cols-2">
          <For each={compared()}>{(id) => <SessionTranscript workspaceId={app.workspaceId()} sessionId={id} title={sessionLabel(id)} />}</For>
        </div>
      </Show>
    </WorkspaceSection>
    <ConsoleScreen workspaceId={app.workspaceId()} include={inScope} requestedSession={typeof search.session === "string" ? search.session : undefined}
      filters={filters()} onFiltersChange={(patch) => setSearch({ ...writeExecFilters({ ...filters(), ...patch }) })}
      onSessionChange={(sessionId) => setSearch({ session: sessionId }, { replace: true })} />
  </PageStack>;
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
  const [rejectReason, setRejectReason] = createSignal("");
  const [rejecting, setRejecting] = createSignal(false);
  return <PageStack>
    <WorkspaceSection title="Plan version" description="Confirmed work and any proposal waiting for a person.">
      <Show when={confirmed()} fallback={<EmptyPreview icon="lucide-list-tree" title="No confirmed plan yet" description="Prepare a plan proposal below, or open one an agent proposed from Needs you." />}>
        {(plan) => <p class="text-interface">Revision {plan().revision} · {plan().tasks.length} tasks{plan().team?.length ? ` · ${plan().team!.length} members` : ""}</p>}
      </Show>
      <Show when={versions.state().data?.proposal}>{(p) => <section class="mt-3 rounded-control border border-outline-gray-2 p-3" aria-label="Plan proposal">
        <p class="text-base-medium">Proposal: revision {p().revision} · {p().state} · {p().origin}</p>
        <p class="text-interface text-ink-gray-7">Added: {p().tasks.filter((task) => !confirmed()?.tasks.some((other) => other.id === task.id)).map((task) => task.title).join(", ") || "none"}; removed: {(confirmed()?.tasks ?? []).filter((task) => !p().tasks.some((other) => other.id === task.id)).map((task) => task.title).join(", ") || "none"}</p>
        <Show when={p().team?.length}><p class="text-interface text-ink-gray-7">Team: {p().team!.map((member) => `${member.memberId} (${member.role})`).join(", ")}</p></Show>
        <Show when={p().state === "proposed"}><Button variant="solid" theme="blue" class="mt-2" disabled={props.busy}
          onClick={() => void props.onAct(async () => { await app.run("plan.confirm", { planVersionId: p().planVersionId }, { expectedVersion: props.mission.version }); await versions.refresh({ force: true }); })}>Confirm this plan version</Button>
          <Button variant="outline" theme="red" class="mt-2" iconLeft="lucide-x" disabled={props.busy} onClick={() => { setRejectReason(""); setRejecting(true); }}>Reject this proposal</Button></Show>
        <ReasonDialog open={rejecting()} onClose={() => setRejecting(false)} title="Reject this proposal" description="The proposal is kept in history. The mission continues on its last confirmed plan." reason={rejectReason()} onReason={setRejectReason}
          reasonLabel="Rejection reason" confirmLabel="Reject proposal" tone="red" busy={props.busy}
          onConfirm={() => void props.onAct(async () => { const result = await app.run("plan.reject", { planVersionId: p().planVersionId, reason: rejectReason().trim() }); if (!result.accepted) throw new Error(result.detail); setRejectReason(""); setRejecting(false); await versions.refresh({ force: true }); })} />
      </section>}</Show>
    </WorkspaceSection>
    <PlanCanvas mission={props.mission} onChanged={() => props.onAct(async () => undefined)} />
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
  const [editOpen, setEditOpen] = createSignal(false);
  const [decideOpen, setDecideOpen] = createSignal(false);
  const saveBrief = (b: MissionBrief) => props.onAct(async () => {
    await app.run("mission.brief.edit", { missionId: props.mission.missionId, baseVersion: b.version, ...(intent() !== undefined ? { intent: intent()! } : {}), ...(constraints() !== undefined ? { constraints: constraints()!.split("\n").map((line) => line.trim()).filter(Boolean) } : {}) });
    setIntent(undefined); setConstraints(undefined); setEditOpen(false); await brief.refresh({ force: true });
  });
  const acceptDecision = (b: MissionBrief) => props.onAct(async () => {
    await app.run("decision.accept", { missionId: props.mission.missionId, baseVersion: b.version, statement: decision().trim(), source: { kind: "human" } });
    setDecision(""); setDecideOpen(false); await brief.refresh({ force: true });
  });
  return <ScreenRegion state={brief.state()} onRetry={() => void brief.refresh({ force: true })} emptyTitle="No brief" emptyDescription="Every mission starts with a brief.">
    <Show when={brief.state().data}>{(b) => <PageStack>
      <WorkspaceSection title={`Brief, version ${b().version}`} description={`${b().writtenChars} of 8000 written characters · updated ${formatDateTime(b().updatedAt)}`} actions={<Button variant="outline" iconLeft="lucide-pencil" onClick={() => { setIntent(undefined); setConstraints(undefined); setEditOpen(true); }}>Edit brief</Button>}>
        <div class="brain-brief"><h3 class="text-base-medium">Intent</h3><p class="brain-readable whitespace-pre-line text-interface">{b().intent}</p>
          <h3 class="mt-3 text-base-medium">Constraints</h3><Show when={b().constraints.length} fallback={<p class="text-interface text-ink-gray-6">None recorded.</p>}><ul class="ml-4 list-disc text-interface"><For each={b().constraints}>{(line) => <li>{line}</li>}</For></ul></Show></div>
        <FormSheet open={editOpen()} onClose={() => setEditOpen(false)} title="Edit the brief" description="Saving creates a new brief version; earlier versions stay in the history." submit="Save brief" icon="lucide-save" busy={props.busy} disabled={intent() === undefined && constraints() === undefined} onSubmit={() => { if (!props.busy && (intent() !== undefined || constraints() !== undefined)) return saveBrief(b()); }}>
        <Textarea label="Intent" value={intent() ?? b().intent} onInput={(event) => setIntent(event.currentTarget.value)} />
        <Textarea label="Constraints (one per line)" value={constraints() ?? b().constraints.join("\n")} onInput={(event) => setConstraints(event.currentTarget.value)} />
        </FormSheet>
      </WorkspaceSection>
      <WorkspaceSection title="Accepted decisions" description="Immutable entries; a later decision supersedes, never edits." actions={<Button variant="outline" iconLeft="lucide-plus" onClick={() => setDecideOpen(true)}>Accept a decision</Button>}>
        <ul class="flex flex-col gap-2"><For each={b().decisions}>{(entry) => <li class={entry.supersededBy ? "text-ink-gray-5 line-through" : ""}>
          {entry.statement} <span class="text-caption text-ink-gray-6">· {entry.source.kind} · accepted by {entry.acceptedBy} in v{entry.introducedInVersion}</span></li>}</For></ul>
        <FormSheet open={decideOpen()} onClose={() => setDecideOpen(false)} title="Accept a decision" description="Decisions are immutable; a later one supersedes it." submit="Accept decision" busy={props.busy} disabled={!decision().trim()} onSubmit={() => { if (decision().trim() && !props.busy) return acceptDecision(b()); }}>
          <TextInput label="New decision" required value={decision()} onInput={(event) => setDecision(event.currentTarget.value)} />
        </FormSheet>
      </WorkspaceSection>
      <WorkspaceSection title="Progress" description="Derived from work items; nobody writes it.">
        <p class="text-interface">{b().progress.total} work items · {Object.entries(b().progress.byState).map(([state, count]) => `${count} ${state}`).join(" · ") || "none yet"}</p>
      </WorkspaceSection>
      <WorkspaceSection title="Version history" description="Every brief version, newest first, with what changed from the one before it.">
        <ol class="flex flex-col gap-2"><For each={b().history ?? []}>{(entry, index) => {
          const previous = () => (b().history ?? [])[index() + 1];
          const added = () => entry.constraints.filter((item) => !previous()?.constraints.includes(item));
          const removed = () => (previous()?.constraints ?? []).filter((item) => !entry.constraints.includes(item));
          return <li class="rounded-control border border-outline-gray-1 p-3" aria-label={`Brief version ${entry.version}`}>
            <div class="flex flex-wrap items-center gap-2"><Badge variant="outline" theme="blue" label={`Version ${entry.version}`} /><Badge variant="outline" theme="gray" label={entry.change} />
              <span class="text-caption text-ink-gray-6">{entry.createdBy} · {formatDateTime(entry.createdAt)}</span></div>
            <Show when={previous() && previous()!.intent !== entry.intent}><p class="mt-2 text-interface"><span class="text-ink-gray-6">Intent changed:</span> {entry.intent}</p></Show>
            <Show when={!previous()}><p class="mt-2 text-interface">{entry.intent}</p></Show>
            <For each={added()}>{(item) => <p class="mt-1 text-interface text-ink-green-8">+ {item}</p>}</For>
            <For each={removed()}>{(item) => <p class="mt-1 text-interface text-ink-red-8 line-through">− {item}</p>}</For>
          </li>;
        }}</For></ol>
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
  const app = useApp();
  const navigate = useNavigate();
  const outputs = useMissionRead<Output[]>(props.mission.missionId, "missionOutputs.list", (raw) => [...(raw as { items: Output[] }).items], (items) => items.length === 0);
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((item) => item.missionId === props.mission.missionId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  /** Outputs grouped by the plan task whose work produced their latest version. */
  const groups = () => {
    const byTask = new Map<string, Output[]>();
    for (const output of outputs.state().data ?? []) {
      const producer = items.state().data?.find((item) => item.workItemId === output.versions.at(-1)?.workItemId);
      const task = producer?.title ?? "Not yet produced";
      byTask.set(task, [...(byTask.get(task) ?? []), output]);
    }
    return [...byTask.entries()];
  };
  return <WorkspaceSection title="Mission outputs" description="Named outputs grouped by the plan task that produces them; only verified final versions are consumed by other work.">
    <ScreenRegion state={outputs.state()} onRetry={() => void outputs.refresh({ force: true })} emptyTitle="No outputs yet" emptyDescription="Outputs appear when work records a version of a named output.">
      <For each={groups()}>{([task, entries]) => <section class="mb-4" aria-label={`Outputs of ${task}`}>
        <h3 class="mb-2 text-base-medium">{task}</h3>
        <div class="brain-queue"><For each={entries}>{(output) => {
          const latest = output.versions.at(-1);
          return <QueueRow title={output.name} description={`${output.versions.length} version${output.versions.length === 1 ? "" : "s"}${output.continues ? " · continues an earlier mission's output" : ""}`} icon="lucide-file-text"
            tone={latest?.verified ? "green" : latest?.state === "final" ? "blue" : "gray"} label={`Open output ${output.name}`}
            meta={<span>{latest ? `latest ${latest.state}${latest.verified ? " · verified" : ""} · ${formatDateTime(latest.createdAt)}` : "no version yet"}</span>}
            onClick={() => void navigate(`/outputs/${encodeURIComponent(output.outputId)}`)} />;
        }}</For></div>
      </section>}</For>
      <TechnicalDetails label="About output versions"><p>Versions are immutable. A task input pins one exact verified final version when its attempt is admitted.</p></TechnicalDetails>
    </ScreenRegion>
  </WorkspaceSection>;
}
