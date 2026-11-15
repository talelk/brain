import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import type { WorkItem } from "@brain/contracts";
import { StatusBadge } from "../components/StatusBadge";
import { formatUsd } from "../format";
import { t } from "../../i18n";

/**
 * A task's place in its tree (#131): the task it is part of, and its subtasks with how many are done and what they and the task cost together.
 * Subtasks are the same work items the board shows, opened from here; nothing is listed twice on the board.
 */
export function Subtasks(props: { item: WorkItem; items: readonly WorkItem[]; onOpen: (item: WorkItem) => void }): JSX.Element {
  const parent = () => props.items.find((other) => other.workItemId === props.item.parentId);
  const children = () => props.items.filter((other) => other.parentId === props.item.workItemId);
  return <Show when={parent() || children().length > 0}>
    <div class="flex flex-col gap-2 border-b border-outline-gray-1 pb-3" data-testid="work-subtasks-panel">
      <Show when={parent()}>{(up) => <p class="flex flex-wrap items-center gap-2 text-interface text-ink-gray-7">
        <span class="lucide-corner-down-right size-4 text-ink-gray-6" aria-hidden="true" />{t("work.part-of")}
        <Button size="sm" variant="ghost" onClick={() => props.onOpen(up())}>{up().title}</Button></p>}</Show>
      <Show when={props.item.subtasks}>{(sub) => <>
        <h4 class="text-base-medium">{t("work.subtasks")}</h4>
        <p class="text-interface text-ink-gray-7" data-testid="work-subtasks-progress">{t("work.subtasks-progress", { done: sub().done, total: sub().total })}</p>
        <ul class="flex flex-col divide-y divide-outline-gray-1 rounded-card border border-outline-gray-1" aria-label={t("work.subtasks")}>
          <For each={children()}>{(child) => <li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => props.onOpen(child)}>{child.title}</Button><StatusBadge kind="workItem" status={child.state} /></li>}</For>
        </ul>
        <p class="text-caption text-ink-gray-6" data-testid="work-subtasks-cost">{t("work.subtasks-cost", { amount: formatUsd(sub().settledMicroUsd + sub().reservedMicroUsd) })}</p>
        <p class="text-caption text-ink-gray-6">{t("work.subtasks-hint")}</p>
      </>}</Show>
    </div>
  </Show>;
}
