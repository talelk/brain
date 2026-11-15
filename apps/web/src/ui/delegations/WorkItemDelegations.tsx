import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Badge } from "@talelk/newui-atoms";
import type { BadgeTheme } from "@talelk/newui-atoms";
import type { WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { WorkspaceSection } from "../components/Domain";
import { missionHref } from "../mission-links";
import { t, tn } from "../../i18n";
import { createDelegations } from "./MissionDelegations";
import { STATUS_KEY, delegationStatus, type DelegationStatus } from "./delegation-model";

const THEME: Readonly<Record<DelegationStatus, BadgeTheme>> = { working: "blue", "to-review": "amber", accepted: "green", rejected: "red", failed: "red" };

/**
 * What this task handed to child sessions, one line each with where it stands, and the way to the screen where a result is reviewed.
 * It says nothing when the task delegated nothing.
 */
export function WorkItemDelegations(props: { item: WorkItem }): JSX.Element {
  const app = useApp();
  const read = createDelegations(() => props.item.missionId);
  const mine = () => (read.state().data?.items ?? []).filter((entry) => entry.workItemId === props.item.workItemId);
  const waiting = () => mine().filter((entry) => delegationStatus(entry) === "to-review").length;
  const href = () => `${missionHref(app.workspaceId(), props.item.missionId, "delegations")}&item=${encodeURIComponent(props.item.workItemId)}`;
  return <Show when={mine().length > 0}>
    <WorkspaceSection title={t("delegations.workitem.title")} description={tn("delegations.workitem.line", mine().length)}>
      <div class="flex min-w-0 flex-col gap-2" data-work-item-delegations>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <For each={mine()}>{(entry) => <li class="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span class="min-w-0 break-words text-interface text-ink-gray-9">{entry.task}</span>
            <Badge variant="outline" theme={THEME[delegationStatus(entry)]} label={t(STATUS_KEY[delegationStatus(entry)])} />
          </li>}</For>
        </ul>
        <p class="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-interface">
          <A class="text-ink-blue-link underline focus-visible:focus-ring" href={href()}>{waiting() > 0 ? tn("delegations.workitem.review", waiting()) : t("delegations.workitem.open")}</A>
        </p>
      </div>
    </WorkspaceSection>
  </Show>;
}
