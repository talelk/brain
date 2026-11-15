import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Badge } from "@talelk/newui-atoms";
import type { ActivityProfile, UsageView } from "@brain/contracts";
import { t } from "../../i18n";
import { formatRelative, formatTokens, formatUsd } from "../format";
import { agentHref, memberHref, missionHref } from "../mission-links";
import { WorkspaceSection } from "./Domain";

type Status = ActivityProfile["status"]["state"];
const STATUS_THEME: Record<Status, "green" | "gray" | "amber" | "red"> = { working: "green", idle: "gray", waiting: "amber", failing: "red" };
const STATUS_LABEL = { working: "agents.status.working", idle: "agents.status.idle", waiting: "agents.status.waiting", failing: "agents.status.failing" } as const;
const SESSION_LABEL = { starting: "agent.session.starting", running: "agent.session.running", waiting: "agent.session.waiting", stopping: "agent.session.stopping", stopped: "agent.session.stopped", failed: "agent.session.failed" } as const;
const SESSION_THEME = { starting: "blue", running: "green", waiting: "amber", stopping: "amber", stopped: "gray", failed: "red" } as const;

/** What an agent or member is doing, as a badge. The status is derived by the Governor from session records on every read. */
export function ActivityBadge(props: { status: Status }): JSX.Element {
  return <span class="inline-flex" data-testid="activity-status" data-status={props.status}><Badge variant="subtle" theme={STATUS_THEME[props.status]} label={t(STATUS_LABEL[props.status])} /></span>;
}

/** One number with the words that define it: no figure is shown without what it counts. */
function Figure(props: { label: string; value: string; definition: string; testid: string }): JSX.Element {
  return <div class="flex min-w-0 flex-col gap-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3" data-testid={props.testid}>
    <span class="text-caption font-medium text-ink-gray-7">{props.label}</span>
    <span class="min-w-0 break-words text-heading tabular-nums text-ink-gray-9" data-testid={`${props.testid}-value`}>{props.value}</span>
    <span class="text-caption text-ink-gray-7" data-testid={`${props.testid}-definition`}>{props.definition}</span>
  </div>;
}

/**
 * The shared body of the agent page and the team-member panel (#113): status with its reason and definition, the figures of the last 30 days
 * (verified rate, sessions, cost) each beside its definition, the top failure classes and the recent runs. Every figure is the Governor's:
 * status and rates come from `agents.profile` / `members.profile`, cost from `usage.agent` / `usage.member`; the browser only formats them.
 */
export function AgentActivity(props: { profile: ActivityProfile; usage?: UsageView | undefined; costDefinition: string; workspaceId: string; missions?: ReadonlyMap<string, string> }): JSX.Element {
  const rate = () => props.profile.metrics.find((metric) => metric.id === "verified-rate");
  const cost = () => props.usage?.usage;
  const tokens = () => (cost() ? cost()!.inputTokens + cost()!.outputTokens + cost()!.cachedInputTokens : 0);
  return <>
    <WorkspaceSection title={t("agent.section.status")}>
      <div class="flex min-w-0 flex-col gap-1" data-testid="activity-status-block">
        <div class="flex flex-wrap items-center gap-2"><ActivityBadge status={props.profile.status.state} /><span class="min-w-0 break-words text-interface text-ink-gray-9" data-testid="activity-reason">{props.profile.status.reason}</span>
          <Show when={props.profile.status.since}>{(since) => <span class="text-caption text-ink-gray-6">{t("agent.status.since", { when: formatRelative(since()) })}</span>}</Show></div>
        <p class="m-0 text-caption text-ink-gray-7" data-testid="activity-status-definition">{props.profile.status.definition}</p>
      </div>
    </WorkspaceSection>
    <WorkspaceSection title={t("agent.section.figures", { days: props.profile.window.days })}>
      <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Show when={rate()}>{(metric) => <Figure testid="figure-verified" label={t("agent.figure.verified")}
          value={metric().value !== undefined ? t("agent.figure.verified.value", { percent: `${Math.round(metric().value! * 100)}%`, verified: metric().numerator, judged: metric().denominator }) : t("agent.figure.verified.none")}
          definition={metric().definition} />}</Show>
        <Figure testid="figure-sessions" label={t("agent.figure.sessions")} value={t("agent.figure.sessions.value", { live: props.profile.sessions.live, total: props.profile.sessions.total })} definition={t("agent.figure.sessions.definition")} />
        <Figure testid="figure-cost" label={t("agent.figure.cost")} value={cost() ? t("agent.figure.cost.value", { cost: formatUsd(cost()!.settledMicroUsd), tokens: formatTokens(tokens()) }) : "…"} definition={props.costDefinition} />
      </div>
    </WorkspaceSection>
    <WorkspaceSection title={t("agent.section.failures")}>
      <div class="flex min-w-0 flex-col gap-2" data-testid="failure-classes">
        <Show when={props.profile.failureClasses.items.length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7">{t("agent.failures.none")}</p>}>
          <ul class="m-0 flex list-none flex-col gap-1 p-0"><For each={props.profile.failureClasses.items}>{(item) => <li class="text-interface text-ink-gray-9" data-testid="failure-class" data-code={item.code}>{t("agent.failures.line", { count: item.count, label: item.label })}</li>}</For></ul>
        </Show>
        <p class="m-0 text-caption text-ink-gray-7">{props.profile.failureClasses.definition}</p>
      </div>
    </WorkspaceSection>
    <WorkspaceSection title={t("agent.section.runs")}>
      <Show when={props.profile.recentRuns.length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7" data-testid="recent-runs-none">{t("agent.runs.none")}</p>}>
        <ul class="m-0 flex list-none flex-col divide-y divide-outline-gray-1 p-0" data-testid="recent-runs"><For each={props.profile.recentRuns}>{(run) => <li class="flex min-w-0 flex-col gap-1 py-2 first:pt-0 last:pb-0" data-testid="recent-run" data-state={run.state}>
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="subtle" theme={SESSION_THEME[run.state]} label={t(SESSION_LABEL[run.state])} />
            <span class="min-w-0 break-words text-interface font-medium text-ink-gray-9">{run.task || run.sessionId}</span>
            <span class="text-caption text-ink-gray-6">{formatRelative(run.updatedAt)}</span>
          </div>
          <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption">
            <Show when={run.jobId}>{(jobId) => <A class="text-ink-blue-link underline focus-visible:focus-ring" href={`/runs/${encodeURIComponent(jobId())}`} data-testid="recent-run-open">{t("agent.run.open")}</A>}</Show>
            <Show when={run.missionId}>{(missionId) => <A class="text-ink-blue-link underline focus-visible:focus-ring" href={missionHref(props.workspaceId, missionId())}>{props.missions?.get(missionId()) ?? t("agent.run.mission")}</A>}</Show>
            <Show when={run.missionId && run.memberId}><A class="text-ink-blue-link underline focus-visible:focus-ring" href={memberHref(props.workspaceId, run.missionId!, run.memberId!)} data-testid="recent-run-member">{t("agent.run.member", { name: run.memberId! })}</A></Show>
          </div>
        </li>}</For></ul>
      </Show>
    </WorkspaceSection>
  </>;
}

/** The agent definitions a member of a mission was charged to, as links to their pages. */
export function AgentLinks(props: { workspaceId: string; agentIds: readonly string[] }): JSX.Element {
  return <For each={props.agentIds}>{(id) => <A class="text-ink-blue-link underline focus-visible:focus-ring" href={agentHref(props.workspaceId, id)} data-testid="member-agent-link">{t("member.agent.open", { name: id })}</A>}</For>;
}
