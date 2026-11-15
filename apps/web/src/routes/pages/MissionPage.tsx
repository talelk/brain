import { createEffect, createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { Badge, Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Dropdown, Select, TabButtons } from "@talelk/newui-molecules";
import type { BrainSession, TeamMember, WorkItem, Mission, MissionBrief, MissionMessage, PlanVersion, SinceLastVisitSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { FormSheet } from "../../ui/components/BrainForm";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { MissionWorkItems } from "../../ui/components/MissionWorkItems";
import { MissionCriteria } from "../../ui/components/MissionCriteria";
import { isStoppedForRetry } from "../../ui/work/work-model";
import { SchedulesLink } from "../../ui/components/SchedulesPanel";
import { PlanCanvas } from "../../ui/components/PlanCanvas";
import { eventWords, formatDateTime, formatUsd } from "../../ui/format";
import { FlowStepper, type FlowStep } from "../../ui/viz/FlowStepper";
import { Meter } from "../../ui/viz/Meter";
import { StateBar } from "../../ui/viz/StateBar";
import { t, type MessageKey } from "../../i18n";
import { missionHref, type MissionTab } from "../../ui/mission-links";
import { ConsoleScreen } from "../../ui/console/ConsoleLayout";
import { SessionTranscript } from "../../ui/console/SessionTranscript";
import { readExecFilters, writeExecFilters } from "../../ui/exec/exec-filters";
import { MissionOutputs } from "../../ui/outputs/MissionOutputs";
import { MissionUsage, reportsNoCost } from "../../ui/usage/Usage";
import { UsageBreakdown } from "../../ui/usage/UsageBreakdown";
import { PlanEstimate } from "../../ui/usage/PlanEstimate";
import { ReusedInBrief } from "../../ui/components/Reuse";
import { MissionTimeline } from "../../ui/timeline/MissionTimeline";

const TAB_KEYS: Readonly<Record<MissionTab, MessageKey>> = {
  live: "mission.tab.live", team: "mission.tab.team", plan: "mission.tab.plan", brief: "mission.tab.brief", timeline: "mission.tab.timeline", outputs: "mission.tab.outputs",
};
const TABS: readonly { id: MissionTab }[] = (["live", "team", "plan", "brief", "timeline", "outputs"] as const).map((id) => ({ id }));
const tabLabel = (id: MissionTab): string => t(TAB_KEYS[id]);

/** The views a person needs day to day; the rest sit under "More views". */
const MAIN_TABS: readonly MissionTab[] = ["live", "plan", "outputs"];

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

type Guide = { step: FlowStep; tab: MissionTab; title: string; detail: string; icon: string; allDone: boolean; action?: { label: string; tab: MissionTab } | { label: string; start: WorkItem } };

/** The same event repeated reads once with a count, at its latest time: two identical "Plan version confirmed" lines say nothing the first does not. */
function groupNotable(entries: ReadonlyArray<{ at: string; summary: string }>): Array<{ at: string; summary: string; count: number }> {
  const groups = new Map<string, { at: string; summary: string; count: number }>();
  for (const entry of entries) {
    const known = groups.get(entry.summary);
    if (known) { known.count += 1; if (entry.at > known.at) known.at = entry.at; }
    else groups.set(entry.summary, { at: entry.at, summary: entry.summary, count: 1 });
  }
  return [...groups.values()];
}

const tally = (items: readonly WorkItem[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  return counts;
};

/** Where the mission really is: derived from the plan and the work items, never stored. Also the tab that fits that step. */
function missionGuide(m: Mission, items: readonly WorkItem[], canStart: boolean): Guide {
  const counts = tally(items);
  const n = (state: string) => counts[state] ?? 0;
  const live = items.filter((item) => item.state !== "abandoned");
  const allDone = live.length > 0 && live.every((item) => item.state === "done");
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (m.state === "closed") return { step: "close", tab: "outputs", icon: "lucide-flag", title: t("mp.this-mission-is-closed.03df"), detail: t("mp.the-outcome-is-recorded-outputs.f66e"), allDone };
  // The mission and its work items are separate reads that refresh at different moments: work that exists means a plan was confirmed, whatever the mission read still says.
  if (!m.activePlanVersionId && live.length === 0) return { step: "plan", tab: "plan", icon: "lucide-list-tree", title: t("mp.prepare-and-confirm-a-plan.e751"), detail: t("mp.no-plan-is-confirmed-yet-brain-d.62a1"), allDone, action: { label: t("mp.review-the-plan.e180"), tab: "plan" } };
  if (m.state === "verifying") return { step: "close", tab: "outputs", icon: "lucide-badge-check", title: t("mission.guide.signoff.title"), detail: t("mission.guide.signoff.detail"), allDone, action: { label: t("decision.signOff.open"), tab: "outputs" } };
  if (n("in-progress") > 0) return { step: "start", tab: "live", icon: "lucide-radio", title: `${plural(n("in-progress"), "task is", "tasks are")} in progress`, detail: t("mp.an-agent-is-working-on-it-or-abo.53e5"), allDone, action: { label: t("mp.follow-in-live.c4a1"), tab: "live" } };
  const ready = items.find((item) => item.state === "ready");
  if (ready && canStart) return { step: "confirm", tab: "plan", icon: "lucide-play", title: `${plural(n("ready"), "task is", "tasks are")} ready to start`, detail: t("mp.the-plan-is-confirmed-start-a-re.8482"), allDone, action: { label: `Start ${ready.title}`, start: ready } };
  if (ready) return { step: "confirm", tab: "plan", icon: "lucide-play", title: `${plural(n("ready"), "task is", "tasks are")} ready to start`, detail: t("mp.someone-with-dispatch-rights-has.6dda"), allDone };
  if (allDone) return { step: "review", tab: "outputs", icon: "lucide-package", title: t("mp.all-work-is-done.2698"), detail: m.autoStart ? t("mp.every-task-is-verified-by-an-ind.ef62") : t("mp.review-the-outputs-then-finish-t.0fcd"), allDone, action: { label: t("mp.review-outputs.0d8d"), tab: "outputs" } };
  const stoppedItems = items.filter((item) => isStoppedForRetry(item));
  if (stoppedItems.length > 0 && n("review") === 0) return { step: "review", tab: "plan", icon: "lucide-circle-pause", title: t("mp.stopped-waiting-for-you-to-try-a.47a0"), detail: `${plural(stoppedItems.length, "task was", "tasks were")} interrupted too often to carry on by itself. Press Try again on ${stoppedItems.length === 1 ? "it" : "each"}.`, allDone, action: { label: t("mp.open-the-work.ae17"), tab: "plan" } };
  if (n("review") > 0 || n("blocked") > 0) return { step: "review", tab: "plan", icon: "lucide-badge-check", title: n("review") > 0 ? t("mp.work-is-waiting-for-your-review.0c74") : t("mp.some-work-is-blocked.1e92"), detail: `${n("review")} in review · ${n("blocked")} blocked. Done needs verified evidence.`, allDone, action: { label: t("mp.open-the-work.ae17"), tab: "plan" } };
  return { step: "start", tab: "live", icon: "lucide-hourglass", title: t("mp.waiting-for-work-to-unlock.f2fd"), detail: waitingDetail(items), allDone };
}

/** Which task waits for which: the first waiting task and the unfinished work it depends on, in the task's own words. */
function waitingDetail(items: readonly WorkItem[]): string {
  const first = items.find((item) => item.state === "backlog");
  if (!first) return t("mp.remaining-tasks-wait-for-earlier.8d28");
  const unmet = first.dependsOn.map((id) => items.find((item) => item.workItemId === id)).filter((dependency): dependency is WorkItem => dependency !== undefined && dependency.state !== "done");
  if (unmet.length === 0) return t("mp.releasing", { task: first.title });
  return t("mp.waits-for", { task: first.title, dependencies: unmet.map((dependency) => `"${dependency.title}" (${stateWord(dependency)})`).join(", ") });
}

/** A work item's state in the words the plan uses, for "waits for" lines. */
function stateWord(item: WorkItem): string {
  return item.parked ? "needs a person" : item.state === "in-progress" ? "running" : item.state === "review" ? "being checked" : item.state === "backlog" ? "waiting" : item.state;
}

/** The mission at a glance: the flow stepper with one primary action for the current step, task states, completion and the budget against its cap. */
function MissionSnapshot(props: { mission: Mission; items: WorkItem[]; tab: MissionTab; onAct: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const guide = () => missionGuide(props.mission, props.items, app.canDispatch());
  const counts = () => tally(props.items);
  const waits = () => {
    const out: string[] = [];
    const c = counts();
    const stopped = props.items.filter((item) => isStoppedForRetry(item)).length;
    const parked = props.items.filter((item) => item.parked).length - stopped;
    if (stopped) out.push(`${stopped} ${stopped === 1 ? "task has" : "tasks have"} stopped: waiting for you to try again. The agent was interrupted too often to carry on by itself. Next: open ${stopped === 1 ? "it" : "them"} in the plan and press Try again.`);
    if (props.mission.state === "paused" && props.mission.pauseReason === "stopped") out.push(t("mission.waits.stopped", { reason: props.mission.pauseNote ?? "" }));
    else if (props.mission.state === "paused") out.push(`The mission is paused${props.mission.pauseReason === "budget" ? " because a time, spending or token limit was reached. Next: use Raise limits below" : " by a person"}.`);
    if (parked) out.push(`${parked} ${parked === 1 ? "task is" : "tasks are"} parked after repeated failures and need a person. Next: open ${parked === 1 ? "it" : "them"} in the plan and press Decide.`);
    const blockedItems = props.items.filter((item) => item.state === "blocked" && !item.parked);
    if (blockedItems.length) out.push(`${blockedItems.length} ${blockedItems.length === 1 ? "task is" : "tasks are"} blocked: ${blockedItems[0]?.blockedReason ?? "waiting on something outside the task"}. Next: fix that, then press Unblock on the task.`);
    if ((c.review ?? 0) > 0) out.push(`${c.review} ${c.review === 1 ? "task is" : "tasks are"} waiting for your review.`);
    return out;
  };
  const percent = () => {
    const live = props.items.filter((item) => item.state !== "abandoned");
    return live.length ? Math.round((live.filter((item) => item.state === "done").length / live.length) * 100) : 0;
  };
  const go = (action: NonNullable<Guide["action"]>) => {
    if ("start" in action) void navigate(`/w/${app.workspaceId()}/plays?originKind=work-item&originId=${encodeURIComponent(action.start.workItemId)}`);
    else void navigate(missionHref(app.workspaceId(), props.mission.missionId, action.tab));
  };
  const actionHere = () => {
    const action = guide().action;
    if (!action) return undefined;
    return "tab" in action && action.tab === props.tab ? undefined : action;
  };
  return <div class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-gray-1 p-3">
    <FlowStepper current={guide().step} />
    <div role="status" class="flex flex-wrap items-center gap-3 rounded-card border border-outline-blue-1 bg-surface-blue-1 px-3 py-2">
      <span class={`${guide().icon} size-5 shrink-0 text-ink-blue-8`} aria-hidden="true" />
      <div class="min-w-0 flex-1"><p class="text-base-medium text-ink-gray-9">{guide().title}</p><p class="text-interface text-ink-gray-7">{guide().detail}</p></div>
      <Show when={actionHere()}>{(action) => <Button variant="solid" theme="blue" iconLeft={"start" in action() ? "lucide-play" : undefined} iconRight={"start" in action() ? undefined : "lucide-arrow-right"} onClick={() => go(action())}>{action().label}</Button>}</Show>
    </div>
    <Show when={waits().length}><ul class="flex flex-col gap-1 text-interface text-ink-gray-7" aria-label={t("mp.why-work-is-waiting.1ac0")}><For each={waits()}>{(line) => <li class="flex items-start gap-1.5"><span class="lucide-hourglass mt-0.5 size-3.5 shrink-0 text-ink-amber-8" aria-hidden="true" />{line}</li>}</For></ul></Show>
    <MissionCriteria criteria={props.mission.successCriteria} />
    <div class="grid gap-4 md:grid-cols-2">
      <div class="flex min-w-0 flex-col gap-1"><p class="text-interface text-ink-gray-7">{props.items.length ? t("mission.criteria.tasks-percent", { percent: percent() }) : "No tasks yet"}</p><StateBar counts={counts()} />
        <Show when={props.mission.taskTrust}>{(trust) => <p class="flex items-start gap-1.5 text-caption text-ink-gray-7" data-testid="mission-trust" data-model={trust().model}><span class={`${trust().model > 0 ? "lucide-circle-alert text-ink-amber-8" : "lucide-shield-check text-ink-green-8"} mt-0.5 size-3.5 shrink-0`} aria-hidden="true" />{trust().text}</p>}</Show></div>
      <Show when={props.tab !== "plan" && !reportsNoCost(props.mission.usage) ? props.mission.budget.maxMicroUsd : undefined}>{(limit) => <div class="flex min-w-0 flex-col gap-1"><p class="text-base-medium">{t("mp.budget.7aeb")}</p><Meter label={t("mp.mission-budget.8424")} settled={props.mission.usage.settledMicroUsd} reserved={props.mission.usage.reservedMicroUsd} limit={limit()} format={formatUsd} /></div>}</Show>
    </div>
    <MissionUsage mission={props.mission} taskTokenCap={props.items.reduce<number | undefined>((top, item) => (item.tokenCap === undefined ? top : Math.max(top ?? 0, item.tokenCap)), undefined)} onAct={props.onAct} busy={props.busy} />
    <UsageBreakdown mission={props.mission} />
  </div>;
}

/**
 * One mission (#43): Live is the default view; Team, Plan, Brief, Timeline and
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
  const explicitTab = () => TABS.some((entry) => entry.id === params.tab);
  const tab = () => (explicitTab() ? params.tab : "live") as MissionTab;
  const read = <T,>(queryType: string, pick: (raw: unknown) => T, empty?: (value: T) => boolean) => createScopedRead<T>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<unknown>>({ queryType, workspaceId: scope.workspaceId, resourceId: missionId() } as never, signal);
      return { snapshot: pick(response.snapshot), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    ...(empty ? { isEmpty: empty } : {}),
  });
  const mission = read<Mission>("missions.get", (raw) => raw as Mission);
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((item) => item.missionId === missionId()), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [ending, setEnding] = createSignal(false);
  async function act(fn: () => Promise<unknown>): Promise<void> {
    if (busy()) return;
    setBusy(true); setError("");
    try { await fn(); await Promise.all([mission.refresh({ force: true }), items.refresh({ force: true })]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The command was refused."); }
    finally { setBusy(false); }
  }
  const current = () => mission.state().data;
  // A tab-less address opens on the view that matches the mission's step; an explicit tab is never overridden.
  const [placed, setPlaced] = createSignal(false);
  createEffect(() => {
    const m = current();
    const list = items.state().data;
    if (explicitTab() || placed() || !m || !list) return;
    setPlaced(true);
    void navigate(missionHref(app.workspaceId(), m.missionId, missionGuide(m, list, app.canDispatch()).tab), { replace: true });
  });
  return <BrainPage title={current()?.title ?? "Mission"} description={current()?.intent}
    breadcrumbs={[{ label: t("mp.missions.323e"), href: `/w/${app.workspaceId()}/missions` }, { label: current()?.title ?? missionId() }]}
    actions={<Show when={current()}>{(m) => <div class="flex flex-wrap gap-2">
      <Button variant={m().watching ? "solid" : "outline"} iconLeft={m().watching ? "lucide-eye-off" : "lucide-eye"} aria-pressed={m().watching ? "true" : "false"} disabled={busy()} onClick={() => void act(() => app.run("mission.watch", { missionId: m().missionId, watch: !m().watching }))}>{m().watching ? t("mp.unwatch.5105") : t("mp.watch.d91e")}</Button>
      <Show when={m().state === "closed"}><Button variant="outline" theme="blue" iconLeft="lucide-repeat" onClick={() => void navigate(`/w/${app.workspaceId()}/schedules?repeat=${encodeURIComponent(m().missionId)}`)}>{t("mp.repeat-this.011e")}</Button></Show>
      <Show when={m().state === "paused"}><Button variant="solid" theme="blue" iconLeft="lucide-play" disabled={busy()} onClick={() => void act(() => app.run("mission.resume", { missionId: m().missionId }, { expectedVersion: m().version }))}>{t("mp.resume.b3bd")}</Button></Show>
      <Show when={m().state === "active" && missionGuide(m(), items.state().data ?? [], app.canDispatch()).allDone}><Button variant="solid" theme="blue" iconLeft="lucide-badge-check" disabled={busy()} onClick={() => void act(() => app.run("mission.proposeCompletion", { missionId: m().missionId }, { expectedVersion: m().version }))}>{t("mp.finish-mission.6e55")}</Button></Show>
      <Show when={m().state !== "closed"}><Dropdown aria-label={t("mp.more-mission-actions.98b8")} options={[
          ...(m().state === "active" ? [{ value: "pause", label: t("mp.pause-the-mission.86e9"), icon: "lucide-pause" }] : []),
          ...(m().state === "active" && !missionGuide(m(), items.state().data ?? [], app.canDispatch()).allDone ? [{ value: "finish", label: t("mp.finish-mission-propose-completio.1e4c"), icon: "lucide-badge-check" }] : []),
          { value: "autoStart", label: m().autoStart ? t("mp.starting-tasks-automatic-switch.eab0") : t("mp.starting-tasks-ask-me-before-eac.6322"), icon: m().autoStart ? "lucide-zap" : "lucide-hand" },
          { value: "end", label: t("mp.end-mission-without-completion.1351"), icon: "lucide-square" }]}
        onSelect={(value) => {
          if (value === "end") setEnding(true);
          if (value === "pause") void act(() => app.run("mission.pause", { missionId: m().missionId }, { expectedVersion: m().version }));
          if (value === "finish") void act(() => app.run("mission.proposeCompletion", { missionId: m().missionId }, { expectedVersion: m().version }));
          if (value === "autoStart") void act(() => app.run("mission.policy.set", { missionId: m().missionId, autoStart: !m().autoStart }, { expectedVersion: m().version }));
        }}><span class="flex items-center gap-1.5"><span class="lucide-ellipsis size-4" aria-hidden="true" />{t("mp.more.4bab")}</span></Dropdown></Show>
    </div>}</Show>}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title={t("mp.the-mission-refused-this-change.e1f1")} description={error()} /></Show>
      <ScreenRegion state={mission.state()} onRetry={() => void mission.refresh({ force: true })} emptyTitle={t("mp.mission-not-found.843a")} emptyDescription={t("mp.it-may-belong-to-another-workspa.da49")}>
        <Show when={current()}>{(m) => <>
          <Show when={!m().autoStart && m().state !== "closed"}><Alert theme="blue" variant="outline" title={t("mp.tasks-start-when-you-start-them.0485")} description={t("mp.this-mission-asks-before-each-ta.7c4e")} /></Show>
          <MissionSnapshot mission={m()} items={items.state().data ?? []} tab={tab()} onAct={act} busy={busy()} />
          <Dialog.Root open={ending()} onOpenChange={(open) => { if (!open) setEnding(false); }}>
            <Dialog.Content size="md">
              <Dialog.Header><Dialog.Title>{t("mp.end-this-mission.e359")}</Dialog.Title><Dialog.Description>{t("mp.ending-closes-the-mission-now-wi.c214")}</Dialog.Description></Dialog.Header>
              <Dialog.Footer class="flex-wrap justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setEnding(false)}>{t("mp.cancel.77df")}</Button>
                <Button size="sm" variant="solid" theme="red" loading={busy()} onClick={() => void act(async () => { await app.run("mission.close", { missionId: m().missionId, outcome: "ended" }, { expectedVersion: m().version }); setEnding(false); })}>{t("mp.end-mission.c54f")}</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Root>
          <div class="flex flex-wrap items-center gap-2">
            <TabButtons label={t("mission.tab.label")} value={tab()} wrap onValueChange={(value) => void navigate(missionHref(app.workspaceId(), m().missionId, value as MissionTab))}
              options={TABS.filter((entry) => MAIN_TABS.includes(entry.id) || entry.id === tab()).map((entry) => ({ value: entry.id, label: tabLabel(entry.id) }))} />
            <Dropdown aria-label={t("mission.tab.more")} options={TABS.filter((entry) => !MAIN_TABS.includes(entry.id) && entry.id !== tab()).map((entry) => ({ value: entry.id, label: tabLabel(entry.id) }))}
              onSelect={(value) => void navigate(missionHref(app.workspaceId(), m().missionId, value as MissionTab))}><span class="flex items-center gap-1.5"><span class="lucide-ellipsis size-4" aria-hidden="true" />{t("mp.more-views.5e8b")}</span></Dropdown>
          </div>
          <Switch>
            <Match when={tab() === "live"}><LiveTab mission={m()} onAct={act} busy={busy()} /></Match>
            <Match when={tab() === "team"}><TeamTab mission={m()} /></Match>
            <Match when={tab() === "plan"}><PlanTab mission={m()} onAct={act} busy={busy()} /></Match>
            <Match when={tab() === "brief"}><BriefTab mission={m()} onAct={act} busy={busy()} /></Match>
            <Match when={tab() === "timeline"}><MissionTimeline mission={m()} /></Match>
            <Match when={tab() === "outputs"}><MissionOutputs mission={m()} onChanged={() => void act(async () => undefined)} /></Match>
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
  });
  const member = () => (typeof search.member === "string" ? search.member : "");
  /** A team member by its role, as a person reads it; the id only when the plan no longer lists the member. */
  const roleOfMember = (memberId: string | undefined): string => (team.state().data?.members ?? []).find((entry) => entry.memberId === memberId)?.role ?? memberId ?? "";
  /** Who wrote a message: a person by name, a team member's session by its role, or Brain itself. A raw principal id is never shown. */
  const senderName = (message: MissionMessage): string => (message.senderKind === "agent" ? t("plan.team-member-name.c101", { name: roleOfMember(message.senderMemberId) }) : message.senderKind === "system" ? "Brain" : app.personName(message.senderId));
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
  const running = (memberId: string) => sessionsOf(memberId).filter((session) => session.state === "running" || session.state === "starting" || session.state === "waiting").length;
  /** With no session yet, say what the work is waiting for rather than that nobody is working. */
  const idle = () => {
    const items = team.state().data?.items ?? [];
    if (items.some((item) => item.state === "in-progress")) return { title: t("mp.starting-waiting-for-a-runner.0dea"), description: t("mp.a-task-is-under-way-and-its-agen.26e2") };
    if (items.some((item) => item.state === "review")) return { title: t("mp.waiting-for-the-independent-chec.30c3"), description: t("mp.the-work-is-finished-and-an-inde.dd1d") };
    return undefined;
  };
  const chip = (selected: boolean) => `inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-full border py-1 ps-1 pe-3 text-caption focus-visible:focus-ring ${selected ? "border-outline-blue-3 bg-surface-blue-1 text-ink-blue-8" : "border-outline-gray-2 bg-surface-elevation-1 text-ink-gray-8 hover:bg-surface-gray-1"}`;
  return <PageStack>
    <fieldset class="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      <legend class="sr-only">{t("mp.whose-sessions-to-follow.39fe")}</legend>
      <span class="me-1 text-caption font-medium text-ink-gray-6" aria-hidden="true">{t("mp.follow.6658")}</span>
      <button type="button" class={chip(!member())} aria-pressed={!member()} aria-label={t("mp.follow-the-whole-team.922b")} onClick={() => setSearch({ member: undefined, session: undefined })}>
        <span class="grid size-6 place-items-center rounded-full bg-surface-gray-2 text-ink-gray-7" aria-hidden="true"><span class="lucide-users size-3.5" /></span>
        Whole team <span class="text-ink-gray-6">{team.state().data?.sessions.length ?? 0} sessions</span>
      </button>
      <For each={team.state().data?.members ?? []}>{(entry) => <button type="button" class={chip(member() === entry.memberId)} aria-pressed={member() === entry.memberId}
        aria-label={`Follow ${entry.role} (${entry.memberId})`} title={`${entry.agentId} · ${entry.engine}`} onClick={() => setSearch({ member: entry.memberId, session: undefined })}>
        <span class="relative grid size-6 place-items-center rounded-full bg-surface-gray-2 text-ink-gray-7" aria-hidden="true"><span class="lucide-bot size-3.5" />
          <span class={`absolute -end-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface-elevation-1 ${running(entry.memberId) > 0 ? "bg-surface-green-7 brain-live-dot" : "bg-surface-gray-5"}`} /></span>
        <span class="truncate">{entry.role}</span>
        <span class="text-ink-gray-6">{running(entry.memberId) > 0 ? `${running(entry.memberId)} working` : `${sessionsOf(entry.memberId).length} sessions`}</span>
      </button>}</For>
    </fieldset>
    <ConsoleScreen workspaceId={app.workspaceId()} include={inScope} jobScope={{ missionId: props.mission.missionId, search: props.mission.title }} idle={idle()} requestedSession={typeof search.session === "string" ? search.session : undefined}
      filters={filters()} onFiltersChange={(patch) => setSearch({ ...writeExecFilters({ ...filters(), ...patch }) })}
      onSessionChange={(sessionId) => setSearch({ session: sessionId }, { replace: true })} />
    <div class="grid min-w-0 gap-4 lg:grid-cols-2">
      <WorkspaceSection title={t("mp.while-you-were-away.ae75")} description={t("mp.notable-events-since-you-last-lo.fff2")}>
        <ScreenRegion state={summary.state()} onRetry={() => void summary.refresh({ force: true })} emptyTitle={t("mp.nothing-yet.76eb")} emptyDescription={t("mp.events-appear-as-the-mission-mov.7942")}>
          <Show when={summary.state().data}>{(s) => <>
            <Show when={s().notable.length} fallback={<p class="text-interface text-ink-gray-7">{t("mp.nothing-notable-since-your-last.e283")}</p>}>
              <ul class="flex flex-col gap-1 text-interface"><For each={groupNotable(s().notable)}>{(entry) => <li><span class="text-ink-gray-6">{formatDateTime(entry.at)}</span> · {entry.summary}{entry.count > 1 ? ` (${entry.count} times)` : ""}</li>}</For></ul>
            </Show>
            <Show when={Object.keys(s().otherCounts).length}><p class="mt-2 text-caption text-ink-gray-6">Also: {Object.entries(s().otherCounts).map(([type, count]) => `${count} ${eventWords(type)}`).join(" · ")}</p></Show>
            <Button size="sm" variant="outline" class="mt-2" disabled={s().toCursor === s().fromCursor} onClick={() => void props.onAct(async () => { await app.run("mission.seen", { missionId: props.mission.missionId, cursor: s().toCursor }); await summary.refresh({ force: true }); })}>{t("mp.mark-as-seen.c074")}</Button>
          </>}</Show>
        </ScreenRegion>
      </WorkspaceSection>
      <WorkspaceSection title={t("mp.messages.f170")} description={t("mp.reaches-the-coordinator-or-one-m.675c")} actions={<Button variant="outline" theme="blue" iconLeft="lucide-send" disabled={props.mission.state === "closed"} onClick={() => setComposeOpen(true)}>{t("mp.message-the-mission.4ffc")}</Button>}>
        <FormSheet open={composeOpen()} onClose={() => setComposeOpen(false)} title={t("mp.message-the-mission.4ffc")} centered description={t("mp.a-message-never-approves-anythin.4e43")} submit={t("mp.send.9bc2")} icon="lucide-send" busy={props.busy} disabled={!body().trim() || props.mission.state === "closed"} onSubmit={() => { if (body().trim() && !props.busy) send(); }}>
        <Select label={t("mp.recipient.9034")} value={recipient()} onValueChange={(value) => setRecipient(value ?? "mission")}
          options={[{ value: "mission", label: t("mp.the-mission-coordinator.5ace") }, ...(team.state().data?.members ?? []).map((entry) => ({ value: entry.memberId, label: `${entry.role} (${entry.memberId})` }))]} />
        <Textarea label={t("mp.message.68f4")} required value={body()} onInput={(event) => setBody(event.currentTarget.value)} placeholder={t("mp.prioritise-the-login-flow.3f3d")} />
        <Checkbox label={t("mp.interrupt-running-sessions-at-th.c995")} checked={interrupt()} onCheckedChange={(checked) => setInterrupt(checked === true)} />
        <Checkbox label={t("mp.also-add-to-the-brief-as-a-const.4a42")} checked={addToBrief()} onCheckedChange={(checked) => setAddToBrief(checked === true)} />
        </FormSheet>
        <ScreenRegion state={messages.state()} onRetry={() => void messages.refresh({ force: true })} emptyTitle={t("mp.no-messages.6f77")} emptyDescription={t("mp.messages-you-send-appear-here-wi.c1d0")}>
          <ul class="mt-3 flex flex-col gap-2"><For each={(messages.state().data ?? []).slice(0, 5)}>{(message) => <li class="rounded-control border border-outline-gray-1 p-2">
            <p class="break-words text-interface">{message.body}</p><p class="text-caption text-ink-gray-6">{message.recipient.kind === "member" ? `to ${roleOfMember(message.recipient.memberId)} · ` : ""}<span data-message-sender>{senderName(message)}</span> · {message.delivery} · {formatDateTime(message.createdAt)}</p></li>}</For></ul>
        </ScreenRegion>
      </WorkspaceSection>
    </div>
    <Show when={(team.state().data?.sessions.length ?? 0) >= 2 || compared().length}><WorkspaceSection title={t("mp.compare-two-sessions.6e12")} description={t("mp.follow-two-members-sessions-side.a728")}
      actions={<Show when={compared().length}><Button variant="outline" iconLeft="lucide-x" onClick={() => setSearch({ compare: undefined })}>{t("mp.close-comparison.45b1")}</Button></Show>}>
      <div class="brain-field-grid">
        <For each={[0, 1] as const}>{(index) => <Select label={index === 0 ? t("mp.left-session.4a72") : t("mp.right-session.0404")} value={compared()[index] ?? ""} onValueChange={(value) => setCompared(index, value ?? "")}
          options={(team.state().data?.sessions ?? []).map((session) => ({ value: session.sessionId, label: sessionLabel(session.sessionId) }))} />}</For>
      </div>
      <Show when={compared().length === 2 && compared()[0] !== compared()[1]}>
        <div class="mt-3 grid gap-3 lg:grid-cols-2">
          <For each={compared()}>{(id) => <SessionTranscript workspaceId={app.workspaceId()} sessionId={id} title={sessionLabel(id)} />}</For>
        </div>
      </Show>
    </WorkspaceSection></Show>
  </PageStack>;
}

/** Team: the confirmed plan version's members, their roles, agents and engines (#37). */
function TeamTab(props: { mission: Mission }): JSX.Element {
  const app = useApp();
  const plan = createScopedRead<PlanVersion | null>({
    scope: app.scope, load: async (scope, signal) => {
      if (!props.mission.activePlanVersionId) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<Envelope<PlanVersion>>({ queryType: "plans.get", workspaceId: scope.workspaceId, resourceId: props.mission.activePlanVersionId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (value) => !value?.team?.length,
  });
  return <WorkspaceSection title={t("mp.mission-team.414d")} description={`Up to ${props.mission.budget.memberCap} members run at once; ${props.mission.usage.runningMembers} running now.`}>
    <ScreenRegion state={plan.state()} onRetry={() => void plan.refresh({ force: true })} emptyTitle={t("mp.no-team-yet.6fb4")} emptyDescription={t("mp.a-plan-version-with-a-team-is-pr.fcae")}>
      <table class="w-full text-start text-interface"><thead><tr><th>{t("mp.member.6853")}</th><th>{t("mp.role.c3f1")}</th><th>{t("mp.agent.5ce2")}</th><th>{t("mp.engine.c1f6")}</th><th>{t("mp.tasks.090e")}</th></tr></thead>
        <tbody><For each={plan.state().data?.team ?? []}>{(member) => <tr>
          <td>{member.memberId}</td><td>{member.role}</td><td>{member.agentId}</td><td>{member.engine}</td>
          <td>{(plan.state().data?.tasks ?? []).filter((task) => task.assignment?.kind === "agent" && task.assignment.id === member.memberId).map((task) => task.title).join(", ") || "—"}</td>
        </tr>}</For></tbody></table>
    </ScreenRegion>
  </WorkspaceSection>;
}

/** Plan: a pending proposal (?proposal=) against the confirmed version, then the mission's work items (#37/#39/#43). */
function PlanTab(props: ActProps): JSX.Element {
  const [search] = useSearchParams();
  const proposalId = () => typeof search.proposal === "string" ? search.proposal : "";
  const estimated = () => proposalId() || props.mission.activePlanVersionId || "";
  return <PageStack>
    {/* The estimate arrives after the page: its slot is reserved so nothing below it jumps when it appears. */}
    <div class="min-h-14" data-testid="plan-estimate-slot"><Show when={estimated()} keyed>{(id) => <PlanEstimate planVersionId={id} />}</Show></div>
    <PlanCanvas mission={props.mission} proposalId={proposalId() || undefined} onChanged={() => props.onAct(async () => undefined)} />
    <MissionWorkItems mission={props.mission} />
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
    <SchedulesLink targetIds={(items.state().data ?? []).map((item) => item.workItemId)} label="this mission's tasks" />
  </Show>;
}

/** Brief: human-owned intent and constraints, immutable accepted decisions, derived progress (#34). */
function BriefTab(props: ActProps): JSX.Element {
  const [search] = useSearchParams();
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
  return <ScreenRegion state={brief.state()} onRetry={() => void brief.refresh({ force: true })} emptyTitle={t("mp.no-brief.d1b5")} emptyDescription={t("mp.every-mission-starts-with-a-brie.3283")}>
    <Show when={brief.state().data}>{(b) => <PageStack>
      <WorkspaceSection title={`Brief, version ${b().version}`} description={`${b().writtenChars} of 8000 written characters · updated ${formatDateTime(b().updatedAt)}`} actions={<Button variant="outline" iconLeft="lucide-pencil" onClick={() => { setIntent(undefined); setConstraints(undefined); setEditOpen(true); }}>{t("mp.edit-brief.7ef2")}</Button>}>
        <div class="brain-brief"><h3 class="text-base-medium">{t("mp.intent.9c6e")}</h3><p class="brain-readable whitespace-pre-line text-interface">{b().intent}</p>
          <h3 class="mt-3 text-base-medium">{t("mp.constraints.52e6")}</h3><Show when={b().constraints.length} fallback={<p class="text-interface text-ink-gray-6">{t("mp.none-recorded.6176")}</p>}><ul class="ms-4 list-disc text-interface"><For each={b().constraints}>{(line) => <li>{line}</li>}</For></ul></Show></div>
        <FormSheet open={editOpen()} onClose={() => setEditOpen(false)} title={t("mp.edit-the-brief.0204")} description={t("mp.saving-creates-a-new-brief-versi.74b8")} submit={t("mp.save-brief.e788")} icon="lucide-save" busy={props.busy} disabled={intent() === undefined && constraints() === undefined} onSubmit={() => { if (!props.busy && (intent() !== undefined || constraints() !== undefined)) return saveBrief(b()); }}>
        <Textarea label={t("mp.intent.9c6e")} value={intent() ?? b().intent} onInput={(event) => setIntent(event.currentTarget.value)} />
        <Textarea label={t("mp.constraints-one-per-line.f7a1")} value={constraints() ?? b().constraints.join("\n")} onInput={(event) => setConstraints(event.currentTarget.value)} />
        </FormSheet>
      </WorkspaceSection>
      <WorkspaceSection title={t("mp.accepted-decisions.aba3")} description={t("mp.immutable-entries-a-later-decisi.414a")} actions={<Button variant="outline" iconLeft="lucide-plus" onClick={() => setDecideOpen(true)}>{t("mp.accept-a-decision.1bd6")}</Button>}>
        <ul class="flex flex-col gap-2"><For each={b().decisions}>{(entry) => <li id={`decision-${entry.decisionId}`} data-decision={entry.decisionId} aria-current={search.decision === entry.decisionId ? "true" : undefined} class={`${entry.supersededBy ? "text-ink-gray-5 line-through" : ""} ${search.decision === entry.decisionId ? "rounded-control bg-surface-blue-2 px-2 py-1" : ""}`}>
          {entry.statement} <span class="text-caption text-ink-gray-6">· {entry.source.kind} · accepted by {entry.acceptedBy} in v{entry.introducedInVersion}</span></li>}</For></ul>
        <FormSheet open={decideOpen()} onClose={() => setDecideOpen(false)} title={t("mp.accept-a-decision.1bd6")} centered description={t("mp.decisions-are-immutable-a-later.2f26")} submit={t("mp.accept-decision.26a3")} busy={props.busy} disabled={!decision().trim()} onSubmit={() => { if (decision().trim() && !props.busy) return acceptDecision(b()); }}>
          <TextInput label={t("mp.new-decision.5e24")} required value={decision()} onInput={(event) => setDecision(event.currentTarget.value)} />
        </FormSheet>
      </WorkspaceSection>
      <ReusedInBrief missionId={props.mission.missionId} workspaceId={props.mission.workspaceId} />
      <WorkspaceSection title={t("mp.progress.1b90")} description={t("mp.derived-from-work-items-nobody-w.2666")}>
        <p class="text-interface">{b().progress.total} work items · {Object.entries(b().progress.byState).map(([state, count]) => `${count} ${state}`).join(" · ") || "none yet"}</p>
      </WorkspaceSection>
      <WorkspaceSection title={t("mp.version-history.91f8")} description={t("mp.every-brief-version-newest-first.ff12")}>
        <ol class="flex flex-col gap-2"><For each={b().history ?? []}>{(entry, index) => {
          const previous = () => (b().history ?? [])[index() + 1];
          const added = () => entry.constraints.filter((item) => !previous()?.constraints.includes(item));
          const removed = () => (previous()?.constraints ?? []).filter((item) => !entry.constraints.includes(item));
          return <li class="rounded-control border border-outline-gray-1 p-3" aria-label={`Brief version ${entry.version}`}>
            <div class="flex flex-wrap items-center gap-2"><Badge variant="outline" theme="blue" label={`Version ${entry.version}`} /><Badge variant="outline" theme="gray" label={entry.change} />
              <span class="text-caption text-ink-gray-6">{entry.createdBy} · {formatDateTime(entry.createdAt)}</span></div>
            <Show when={previous() && previous()!.intent !== entry.intent}><p class="mt-2 text-interface"><span class="text-ink-gray-6">{t("mp.intent-changed.617d")}</span> {entry.intent}</p></Show>
            <Show when={!previous()}><p class="mt-2 text-interface">{entry.intent}</p></Show>
            <For each={added()}>{(item) => <p class="mt-1 text-interface text-ink-green-8">+ {item}</p>}</For>
            <For each={removed()}>{(item) => <p class="mt-1 text-interface text-ink-red-8 line-through">− {item}</p>}</For>
          </li>;
        }}</For></ol>
      </WorkspaceSection>
    </PageStack>}</Show>
  </ScreenRegion>;
}

