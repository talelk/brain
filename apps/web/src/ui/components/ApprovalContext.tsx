import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import type { ApprovalRequest } from "@brain/contracts";
import { t } from "../../i18n";
import { missionHref } from "../mission-links";

/** One diff line's look: added lines green, the file and hunk headers quiet. */
function lineTone(line: string): string {
  if (line.startsWith("+++") || line.startsWith("@@")) return "bg-surface-blue-1 text-ink-blue-8";
  if (line.startsWith("+")) return "bg-surface-green-2 text-ink-green-9";
  if (line.startsWith("-")) return "bg-surface-red-2 text-ink-red-9";
  return "text-ink-gray-8";
}

/** The files an approval would commit, as a unified diff (never JSON). The block scrolls on its own so a long line never widens the page. */
export function ChangeDiff(props: { change: NonNullable<NonNullable<ApprovalRequest["context"]>["change"]> }): JSX.Element {
  return <section class="flex min-w-0 flex-col gap-2" data-approval-change aria-label={t("approval.ctx.change")}>
    <h3 class="text-base-medium text-ink-gray-9">{t("approval.ctx.change")}</h3>
    <ul class="m-0 flex list-none flex-col gap-0.5 p-0" data-approval-files>
      <For each={props.change.files}>{(file) => <li class="min-w-0 break-words [overflow-wrap:anywhere] text-interface text-ink-gray-9"><span class="font-medium">{file.path}</span> <span class="text-caption text-ink-gray-6">{t("approval.ctx.file-lines", { lines: String(file.lines) })}</span></li>}</For>
    </ul>
    <pre class="brain-exec-log m-0 max-h-80 max-w-full min-w-0 overflow-auto rounded-control border border-outline-gray-1 bg-surface-gray-1 p-3 text-caption" tabindex="0" data-approval-diff>
      <For each={props.change.diff.split("\n")}>{(line) => <span class={`block whitespace-pre ${lineTone(line)}`}>{line || " "}</span>}</For>
    </pre>
    <p class="m-0 text-caption text-ink-gray-6">{t("approval.ctx.change-note")}</p>
  </section>;
}

/** What undoes the change, as the pinned Tool document declares it; its absence is said, never left out. */
export function RollbackLine(props: { rollback?: { declared: boolean; action?: string | undefined } | undefined }): JSX.Element {
  return <Show when={props.rollback?.declared} fallback={<p class="m-0 text-interface text-ink-gray-7" data-approval-rollback="none">{t("approval.ctx.rollback-none")}</p>}>
    <div class="min-w-0" data-approval-rollback="declared">
      <p class="m-0 break-words [overflow-wrap:anywhere] text-interface text-ink-gray-9">{t("approval.ctx.rollback", { action: props.rollback?.action ?? "" })}</p>
      <p class="m-0 mt-0.5 text-caption text-ink-gray-6">{t("approval.ctx.rollback-note")}</p>
    </div>
  </Show>;
}

/**
 * What an approval is about beyond the effect itself: the mission, task and run it was asked for, the change as a diff, and the rollback.
 * Read beside the approval, never part of what the decision binds (ADR 0048).
 */
export function ApprovalContextBlock(props: { approval: ApprovalRequest }): JSX.Element {
  const context = () => props.approval.context;
  const workspaceId = () => props.approval.subject.workspaceId;
  return <div class="flex min-w-0 flex-col gap-3" data-approval-context>
    <dl class="m-0 grid min-w-0 gap-3 sm:grid-cols-3" aria-label={t("approval.ctx.belongs")}>
      <div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("approval.ctx.mission")}</dt>
        <dd class="m-0 mt-0.5 min-w-0 break-words [overflow-wrap:anywhere] text-interface font-medium text-ink-gray-9" data-approval-mission>
          <Show when={context()?.mission} fallback={<span class="font-normal text-ink-gray-7">{t("approval.ctx.no-mission")}</span>}>{(mission) => <A class="text-ink-blue-8 hover:underline" href={missionHref(workspaceId(), mission().missionId, "plan")}>{mission().title}</A>}</Show></dd></div>
      <Show when={context()?.workItem}>{(item) => <div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("approval.ctx.task")}</dt>
        <dd class="m-0 mt-0.5 min-w-0 break-words [overflow-wrap:anywhere] text-interface font-medium text-ink-gray-9" data-approval-task>
          <Show when={context()?.mission} fallback={item().title}>{(mission) => <A class="text-ink-blue-8 hover:underline" href={`/missions/${encodeURIComponent(mission().missionId)}/plan?w=${encodeURIComponent(workspaceId())}&item=${encodeURIComponent(item().workItemId)}`}>{item().title}</A>}</Show></dd></div>}</Show>
      <Show when={context()?.runId}>{(runId) => <div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("approval.ctx.run")}</dt>
        <dd class="m-0 mt-0.5 min-w-0 break-words [overflow-wrap:anywhere] text-interface text-ink-gray-9" data-approval-run><A class="text-ink-blue-8 hover:underline" href={`/runs/${encodeURIComponent(runId())}`}>{runId()}</A></dd></div>}</Show>
    </dl>
    <Show when={context()?.change}>{(change) => <ChangeDiff change={change()} />}</Show>
    <RollbackLine rollback={context()?.rollback} />
  </div>;
}
