import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button } from "@talelk/newui-atoms";
import type { ActivityProfile, Mission, TeamMember, UsageView } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../screen-region";
import { t } from "../../i18n";
import { WorkspaceSection } from "./Domain";
import { AgentActivity, AgentLinks } from "./AgentActivity";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };
const TASK_THEME = { backlog: "gray", ready: "blue", "in-progress": "green", blocked: "amber", review: "blue", done: "green", abandoned: "gray" } as const;

/**
 * One team member of a mission (#113): its status now, its sessions' recent runs, its tasks, verified rate, failure classes and spend in this
 * mission. Status and rates are `members.profile` (worked out from session, verdict and failure records on every read, never stored); spend is
 * `usage.member`, the ledger's own figure. The member's agent definition links to its page.
 */
export function MemberPanel(props: { mission: Mission; member: TeamMember; onClose: () => void }): JSX.Element {
  const app = useApp();
  const key = () => `${props.mission.missionId}:${props.member.memberId}`;
  const read = createScopedRead<{ profile: ActivityProfile; usage: UsageView }>({
    scope: app.scope, resource: key, live: true,
    load: async (scope, signal) => {
      const [profile, usage] = await Promise.all([
        query<Envelope<ActivityProfile>>({ queryType: "members.profile", workspaceId: scope.workspaceId, resourceId: key() }, signal),
        query<Envelope<UsageView>>({ queryType: "usage.member", workspaceId: scope.workspaceId, resourceId: key() }, signal),
      ]);
      return { snapshot: { profile: profile.snapshot, usage: usage.snapshot }, asOf: profile.asOf, sourceWatermark: profile.sourceWatermark };
    },
  });
  return <section class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-blue-2 bg-surface-elevation-1 p-4" aria-label={t("member.panel.title", { role: props.member.role, member: props.member.memberId })} data-testid="member-panel" data-member={props.member.memberId}>
    <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div class="flex min-w-0 flex-col gap-1">
        <h3 class="m-0 min-w-0 break-words text-base-medium text-ink-gray-9">{t("member.panel.title", { role: props.member.role, member: props.member.memberId })}</h3>
        <p class="m-0 text-caption text-ink-gray-7">{t("member.panel.description")}</p>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption"><AgentLinks workspaceId={app.workspaceId()} agentIds={[props.member.agentId]} /></div>
      </div>
      <Button size="sm" variant="outline" iconLeft="lucide-x" onClick={props.onClose} data-testid="member-panel-close">{t("member.panel.close")}</Button>
    </div>
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh({ force: true })} emptyTitle={t("member.panel.missing")} emptyDescription="">
      <Show when={read.state().data}>{(view) => <div class="flex min-w-0 flex-col gap-3">
        <AgentActivity profile={view().profile} usage={view().usage} costDefinition={t("agent.figure.cost.member.definition")} workspaceId={app.workspaceId()} missions={new Map([[props.mission.missionId, props.mission.title]])} />
        <WorkspaceSection title={t("member.section.tasks")}>
          <Show when={(view().profile.tasks ?? []).length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7" data-testid="member-tasks-none">{t("member.tasks.none")}</p>}>
            <ul class="m-0 flex list-none flex-col gap-1 p-0" data-testid="member-tasks"><For each={view().profile.tasks}>{(task) => <li class="flex min-w-0 flex-wrap items-center gap-2 text-interface text-ink-gray-9" data-testid="member-task">
              <Badge variant="subtle" theme={TASK_THEME[task.state]} label={task.state} />
              <span class="min-w-0 break-words">{task.title}</span>
              <Show when={task.parked}><Badge variant="outline" theme="amber" label={t("member.task.parked")} /></Show>
            </li>}</For></ul>
          </Show>
        </WorkspaceSection>
      </div>}</Show>
    </ScreenRegion>
  </section>;
}
