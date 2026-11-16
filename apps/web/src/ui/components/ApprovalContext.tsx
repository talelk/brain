import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import type { ApprovalRequest } from "@brain/contracts";
import { t } from "../../i18n";
import { missionHref } from "../mission-links";
import { useApp } from "../app-context";

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

/** True when deciding this approval needs the person's authenticator code: the server requires it everywhere, or its risk tier does (elevated and above). */
export function approvalNeedsCode(approval: ApprovalRequest, requireTwoFactor: boolean | undefined): boolean {
  return Boolean(requireTwoFactor) || approval.subject.risk?.requires.stepUp === true;
}

/** True when this person is one of those who already approved: a critical request waits for a different one, so there is nothing for them to decide. */
export function approvedByYou(approval: ApprovalRequest, actorId: string | undefined): boolean {
  return actorId !== undefined && (approval.approvedBy ?? []).includes(actorId);
}

const TIER_TONE = { low: "bg-surface-gray-2 text-ink-gray-8", elevated: "bg-surface-amber-2 text-ink-amber-9", high: "bg-surface-red-2 text-ink-red-9", critical: "bg-surface-red-3 text-ink-red-9" } as const;

/**
 * The risk tier of the approval with the reasons the Governor computed it from, and what the tier asks of the decision. The tier is bound
 * by the approval's digest (ADR 0076); every change still needs its own approval.
 */
export function RiskBlock(props: { approval: ApprovalRequest }): JSX.Element {
  const app = useApp();
  const risk = () => props.approval.subject.risk;
  const approvedBy = () => props.approval.approvedBy ?? [];
  const youApproved = () => approvedByYou(props.approval, app.identity()?.actor.actorId);
  return <Show when={risk()}>{(r) => <section class="flex min-w-0 flex-col gap-1.5" data-approval-risk={r().tier} aria-label={t("approval.risk.title")}>
    <div class="flex flex-wrap items-center gap-2">
      <span class={`inline-flex items-center rounded-full px-2 py-0.5 text-caption font-medium ${TIER_TONE[r().tier]}`} data-approval-risk-tier>{t(`approval.risk.${r().tier}`)}</span>
      <Show when={r().requires.stepUp}><span class="text-interface text-ink-gray-8" data-approval-risk-stepup>{t("approval.risk.stepup")}</span></Show>
      <details class="min-w-0 open:basis-full" data-approval-risk-details>
        <summary class="cursor-pointer text-caption text-ink-blue-8">{t("approval.risk.reasons")}</summary>
        <ul class="m-0 mt-1 flex list-none flex-col gap-0.5 p-0" data-approval-risk-reasons aria-label={t("approval.risk.reasons")}>
          <For each={r().reasons}>{(reason) => <li class="min-w-0 break-words [overflow-wrap:anywhere] text-caption text-ink-gray-7" data-risk-reason={reason.code}>{reason.fact}</li>}</For>
        </ul>
        <p class="m-0 mt-1 text-caption text-ink-gray-6">{t("approval.risk.own-effect")}</p>
      </details>
    </div>
    <Show when={r().requires.secondApprover}><p class="m-0 text-interface text-ink-gray-8" data-approval-risk-second>{t("approval.risk.second")}</p></Show>
    <Show when={r().requires.secondApprover && props.approval.state === "pending" && approvedBy().length > 0}>
      <p class="m-0 text-interface font-medium text-ink-gray-9" data-approval-risk-progress>{youApproved() ? t("approval.risk.you-approved") : t("approval.risk.first-done", { who: approvedBy().map((id) => app.personName(id)).join(", ") })}</p>
    </Show>
  </section>}</Show>;
}

/**
 * What an approval is about beyond the effect itself: the mission, task and run it was asked for, the change as a diff, and the rollback.
 * Read beside the approval, never part of what the decision binds (ADR 0049).
 */
export function ApprovalContextBlock(props: { approval: ApprovalRequest; /** The card names a low tier in its "why" line instead. */ chipOnlyWhenLow?: boolean }): JSX.Element {
  const context = () => props.approval.context;
  const workspaceId = () => props.approval.subject.workspaceId;
  return <div class="flex min-w-0 flex-col gap-3" data-approval-context>
    <Show when={!(props.chipOnlyWhenLow && props.approval.subject.risk?.tier === "low")}><RiskBlock approval={props.approval} /></Show>
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
