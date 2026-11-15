import { createMemo, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Alert, Select, Timeline } from "@talelk/newui-molecules";
import type { Mission, MissionTimeline as MissionTimelineView } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "../components/Domain";
import { t } from "../../i18n";
import { filterTimeline, kindOf, kindsPresent, sourceLink, toolCallsLink } from "./timeline-model";
import { entryWords, KIND_ICON, kindLabel, openLabel } from "./timeline-words";

const ALL = "all";
const linkClass = "inline-flex items-center gap-1 rounded-control text-caption font-medium text-ink-blue-link focus-visible:focus-ring";

/**
 * The mission timeline (spec #90, stories 51 and 52): everything that happened on the mission in one chronological list, oldest first,
 * composed by the Governor from existing records on every read. A person narrows it by kind and by team member (both live in the address,
 * so a filtered view can be shared); each entry opens the record it comes from. It is a different thing from the since-last-visit
 * summary, which only digests what changed since you last looked.
 */
export function MissionTimeline(props: { mission: Mission }): JSX.Element {
  const app = useApp();
  const [search, setSearch] = useSearchParams();
  const read = createScopedRead<MissionTimelineView>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: MissionTimelineView; asOf: string; sourceWatermark: number }>({ queryType: "missions.timeline", workspaceId: scope.workspaceId, resourceId: props.mission.missionId } as never, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
  });
  const kind = () => kindOf(search.kind);
  const member = () => (typeof search.member === "string" ? search.member : "");
  const roleOf = (memberId: string): string => read.state().data?.members.find((entry) => entry.memberId === memberId)?.role ?? memberId;
  const shown = createMemo(() => filterTimeline(read.state().data?.items ?? [], { kind: kind(), member: member() }));
  const filtered = () => kind() !== "" || member() !== "";
  const where = () => ({ workspaceId: app.workspaceId(), missionId: props.mission.missionId });
  const items = () => shown().map((entry) => {
    const words = entryWords(entry, roleOf);
    const link = sourceLink(entry, where());
    const calls = toolCallsLink(entry);
    return {
      id: entry.entryId,
      icon: KIND_ICON[entry.kind],
      tone: words.tone,
      title: <span class="break-words" data-timeline-entry data-kind={entry.kind} data-event={entry.event}>{words.title}</span>,
      description: <span class="flex min-w-0 flex-col gap-1">
        <Show when={words.subject}><span class="break-words text-interface text-ink-gray-8">{words.subject}</span></Show>
        <Show when={words.note}><span class="text-caption text-ink-gray-6">{words.note}</span></Show>
        <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-gray-6">
          <span>{kindLabel(entry.kind)}</span>
          <Show when={entry.actorId}><span>{t("timeline.by", { actor: app.personName(entry.actorId) })}</span></Show>
          <Show when={entry.memberId}><span data-timeline-member={entry.memberId}>{t("timeline.member", { role: roleOf(entry.memberId ?? "") })}</span></Show>
          <A href={link.href} class={linkClass} data-timeline-source={entry.source.kind}>{openLabel(link.label)}<span class="lucide-arrow-right size-3 rtl:rotate-180" aria-hidden="true" /></A>
          <Show when={calls}>{(href) => <A href={href()} class={linkClass} data-timeline-tool-calls>{t("timeline.open.toolCalls", { count: entry.toolCalls ?? 0 })}</A>}</Show>
        </span>
      </span>,
      timestamp: <DateText value={entry.at} />,
    };
  });
  return <WorkspaceSection title={t("timeline.title")} description={t("timeline.description")}>
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh({ force: true })} emptyTitle={t("timeline.empty.title")} emptyDescription={t("timeline.empty.detail")}>
      <div class="flex min-w-0 flex-col gap-4" data-testid="mission-timeline">
        <fieldset class="m-0 flex min-w-0 flex-wrap items-end gap-3 border-0 p-0">
          <legend class="sr-only">{t("timeline.filter.label")}</legend>
          <Select class="w-full sm:w-48" label={t("timeline.filter.kind")} value={kind() || ALL}
            options={[{ value: ALL, label: t("timeline.filter.allKinds") }, ...kindsPresent(read.state().data?.items ?? []).map((entryKind) => ({ value: entryKind, label: kindLabel(entryKind) }))]}
            onValueChange={(value) => setSearch({ kind: !value || value === ALL ? undefined : value }, { replace: true })} />
          <Select class="w-full sm:w-56" label={t("timeline.filter.member")} value={member() || ALL}
            options={[{ value: ALL, label: t("timeline.filter.everyone") }, ...(read.state().data?.members ?? []).map((entry) => ({ value: entry.memberId, label: entry.role }))]}
            onValueChange={(value) => setSearch({ member: !value || value === ALL ? undefined : value }, { replace: true })} />
          <Show when={filtered()}><Button variant="ghost" iconLeft="lucide-x" onClick={() => setSearch({ kind: undefined, member: undefined }, { replace: true })}>{t("timeline.filter.clear")}</Button></Show>
          <span class="ms-auto text-caption text-ink-gray-6" aria-live="polite" data-timeline-count>{t("timeline.filter.shown", { shown: shown().length, total: read.state().data?.items.length ?? 0 })}</span>
        </fieldset>
        <Show when={read.state().data?.truncated}><Alert theme="blue" variant="outline" title={t("timeline.truncated")} /></Show>
        <Show when={shown().length > 0} fallback={<div class="brain-empty-inline"><p class="font-medium">{t("timeline.noMatch.title")}</p><p>{t("timeline.noMatch.detail")}</p></div>}>
          <Timeline items={items()} />
        </Show>
      </div>
    </ScreenRegion>
  </WorkspaceSection>;
}
