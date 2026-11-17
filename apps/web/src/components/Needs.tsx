import { createSignal, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Button, Textarea } from "@talelk/newui-atoms";
import { Collapsible } from "@talelk/newui-molecules";
import type { Approval, Role, TaskSummary } from "@brain/contracts";
import { command, useAction } from "../data/api";
import { t } from "../i18n";
import { ago, show, titleOf } from "../lib/format";
import { roleAtLeast } from "../lib/model";
import { ApprovalView } from "./ApprovalView";
import { Failure, Icon, Keyed, needText, NeedsMark } from "./bits";

/** A task that waits for the person, in the workspace it is in. `approval` is the call to decide, for a task that waits on one. */
export interface NeedsItem {
  readonly task: TaskSummary;
  readonly approval: Approval | null;
  readonly workspaceId: string;
  readonly slug: string;
  readonly workspaceName: string;
  /** What the person is in this workspace: members act, and only an admin decides a change of its files. */
  readonly role: Role;
}

/** A one-line reading of what a call would do: its inputs, as the approver will see them in full below. */
const summaryOf = (approval: Approval): string => {
  const input = approval.subject.input;
  const entries = input !== null && typeof input === "object" && !Array.isArray(input) ? Object.entries(input) : [["input", input] as const];
  return entries.map(([name, value]) => `${name}: ${show(value).replace(/\s+/gu, " ")}`).join(", ");
};

/** The question of an agent, answered where it is shown. */
function Answer(props: { item: NeedsItem; question: string }): JSX.Element {
  const [answer, setAnswer] = createSignal("");
  const send = useAction(() => command("task.answer", { workspaceId: props.item.workspaceId, taskId: props.item.task.id, answer: answer() }));
  return (
    <form class="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void send.run(); }}>
      <p class="t-text text-ink" dir="auto">{props.question}</p>
      <Show when={roleAtLeast(props.item.role, "member")}>
        <Textarea size="md" aria-label={t("need.answer.label")} placeholder={t("need.answer.placeholder")} rows={2} value={answer()} onInput={(event) => setAnswer(event.currentTarget.value)} />
        <Failure error={send.error()} />
        <div><Button type="submit" variant="solid" theme="blue" size="md" loading={send.busy()} disabled={answer().trim() === ""}>{props.item.task.heals ? t("heal.suggest") : t("need.answer.send")}</Button></div>
      </Show>
    </form>
  );
}

function Row(props: { item: NeedsItem; showWorkspace: boolean; open: boolean }): JSX.Element {
  const task = (): TaskSummary => props.item.task;
  const href = (): string => `/w/${props.item.slug}/tasks/${task().rootId}?link=${task().id}`;
  const need = () => task().needs;
  const kind = (): string => { const asked = need(); return task().heals ? t(asked?.kind === "approval" ? "need.heal.fix" : "need.heal.ask", { task: task().heals?.title ?? "" }) : asked ? needText(asked) : t("link.needsYou"); };
  /** What a task that is not an approval or a question says about itself: the check, plan or sign-off to open. */
  const plain = (): "confirm-plan" | "check" | "sign-off" | "judge" | "failed-subtask" => { const asked = need()?.kind; return asked === undefined || asked === "approval" || asked === "answer" ? "check" : asked; };
  const step = (): string | undefined => (task().id === task().rootId ? undefined : titleOf(task()));
  return (
    <li class="border-b border-outline-gray-1 last:border-b-0">
      <Collapsible.Root defaultOpen={props.open}>
        <div class="flex items-start gap-2 px-3 py-2.5">
          <Collapsible.Trigger class="min-w-0 flex-1 text-start" hideIndicator>
            <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span class="inline-flex items-center gap-2 t-small font-semibold text-needs-text"><NeedsMark />{kind()}</span>
              <span class="min-w-0 truncate t-text font-medium text-ink" dir="auto">{task().goalTitle}</span>
              <Show when={step()}><span class="t-small text-ink-3">{step()}</span></Show>
            </span>
            <Show when={props.item.approval}>{(approval) => <span class="mt-0.5 block truncate t-small text-ink-2"><code class="t-code code-ltr">{approval().tool}</code> <code class="t-code code-ltr text-ink-3">{summaryOf(approval())}</code></span>}</Show>
          </Collapsible.Trigger>
          <span class="flex shrink-0 items-center gap-3 pt-0.5 t-small text-ink-3">
            <Show when={props.showWorkspace}><A href={`/w/${props.item.slug}`} class="max-w-40 truncate rounded-control bg-surface-gray-2 px-2 py-0.5 text-ink-2 hover:bg-surface-gray-3 max-sm:hidden">{props.item.workspaceName}</A></Show>
            <span class="max-md:hidden">{ago(task().updatedAt)}</span>
            <A href={href()} class="grid size-7 place-items-center rounded-control text-ink-2 hover:bg-surface-gray-3 focus-visible:focus-ring" aria-label={t("needs.open", { goal: task().goalTitle })}><Icon name="lucide-arrow-up-right" class="size-4 rtl:-scale-x-100" /></A>
          </span>
        </div>
        <Collapsible.Content>
          <div class="px-3 pb-4 ps-8">
            <Show when={props.showWorkspace}><p class="mb-2 t-small text-ink-3 sm:hidden">{props.item.workspaceName}</p></Show>
            <Show when={props.item.approval} fallback={
              <Show when={need()?.kind === "answer" && need()} keyed fallback={
                <div class="flex flex-col items-start gap-3"><p class="t-text text-ink">{t(`need.${plain()}.text`)}</p><Button variant="solid" theme="blue" size="md" route={href()}>{t(`need.${plain()}.open`)}</Button></div>
              }>
                {(asked) => <Answer item={props.item} question={asked.kind === "answer" ? asked.question : ""} />}
              </Show>
            }>
              {(approval) => <ApprovalView approval={approval()} workspaceId={props.item.workspaceId} canDecide={roleAtLeast(props.item.role, approval().tool === "workspace.fix" ? "admin" : "member")} diff="show" href={href()} />}
            </Show>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  );
}

/** What waits for the person, as one list: each row names its goal and the action asked, and opens to decide it where it is shown. */
export function NeedsList(props: { items: readonly NeedsItem[]; showWorkspace?: boolean }): JSX.Element {
  return (
    <ul class="overflow-hidden rounded-card border border-(--needs-line) bg-surface-elevation-1" aria-label={t("today.needs")}>
      <Keyed each={props.items} by={(item) => item.task.id}>
        {(item) => <Row item={item()} showWorkspace={props.showWorkspace ?? false} open={props.items.length <= 3 && (item().approval !== null || item().task.needs?.kind === "answer")} />}
      </Keyed>
    </ul>
  );
}
