import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Textarea } from "@talelk/newui-atoms";
import type { WorkItem, WorkItemComment } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { ScreenRegion } from "../screen-region";
import { FormSheet } from "./BrainForm";
import { formatDateTime } from "../format";
import { t } from "../../i18n";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** A session's machine principal is named `agent:<mission>:<member>` (ADR 0032): a person reads the member, never the id. */
function memberOf(authorId: string): string { return authorId.slice(authorId.lastIndexOf(":") + 1); }

/**
 * The comment thread of one work item (#100): who said what and when, corrections beside what they correct, and for a person's
 * comment where it stands with the team member serving the task. A comment is a note for the team; it never approves or changes anything.
 */
export function WorkItemComments(props: { item: WorkItem }): JSX.Element {
  const app = useApp();
  const thread = createScopedRead<WorkItemComment[]>({
    scope: app.scope,
    resource: () => props.item.workItemId,
    load: async (scope, signal, workItemId) => {
      const response = await query<Envelope<{ items: WorkItemComment[] }>>({ queryType: "workItemComments.list", workspaceId: scope.workspaceId, resourceId: workItemId }, signal);
      return { snapshot: response.snapshot.items, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (list) => list.length === 0,
  });
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal("");
  const [correcting, setCorrecting] = createSignal<WorkItemComment | undefined>();
  const [error, setError] = createSignal("");
  const corrected = createMemo(() => new Set((thread.state().data ?? []).flatMap((entry) => (entry.correctionOf ? [entry.correctionOf] : []))));
  const mine = (entry: WorkItemComment) => entry.authorId === app.identity()?.actor.actorId;

  const author = (entry: WorkItemComment) => (entry.authorKind === "agent" ? t("plan.team-member-name.c101", { name: memberOf(entry.authorId) }) : app.personName(entry.authorId));
  const target = (entry: WorkItemComment) => (entry.recipient?.memberId ?? t("plan.the-mission-coordinator.c102"));
  const delivery = (entry: WorkItemComment): string | undefined => {
    switch (entry.delivery) {
      case "pending": return t("plan.reaches-its-next-session.c103", { to: target(entry) });
      case "delivered-live": return t("plan.sent-to-a-running-session.c104", { to: target(entry) });
      case "delivered-at-session-start": return t("plan.reached-when-its-session-start.c105", { to: target(entry) });
      case "superseded": return t("plan.replaced-by-a-correction-before.c106");
      default: return undefined;
    }
  };

  const begin = (entry?: WorkItemComment) => { setCorrecting(entry); setText(entry?.text ?? ""); setError(""); setOpen(true); };
  async function submit(): Promise<void> {
    const body = text().trim();
    if (!body) return;
    try {
      const result = await app.run("workItem.comment", { workItemId: props.item.workItemId, text: body, ...(correcting() ? { correctionOf: correcting()!.commentId } : {}) });
      if (!result.accepted) { setError(result.detail || t("plan.the-comment-was-not-saved.c107")); return; }
      setOpen(false);
      await thread.refresh({ force: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("plan.the-comment-was-not-saved.c107"));
    }
  }

  return <section class="flex min-w-0 flex-col gap-3" aria-label={t("plan.comments.c108")}>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div><h4 class="text-base-medium">{t("plan.comments.c108")}</h4><p class="text-caption text-ink-gray-6">{t("plan.a-comment-reaches-the-team-membe.c109")}</p></div>
      <Button variant="outline" iconLeft="lucide-message-square" onClick={() => begin()}>{t("plan.add-comment.7d37")}</Button>
    </div>
    <ScreenRegion state={thread.state()} onRetry={() => void thread.refresh({ force: true })} emptyTitle={t("plan.no-comments-yet.c10a")} emptyDescription={t("plan.write-a-note-for-whoever-is-doin.c10b")}>
      <ul class="flex flex-col divide-y divide-outline-gray-1 border-y border-outline-gray-1" aria-label={t("plan.comments.c108")}>
        <For each={thread.state().data ?? []}>{(entry) => <li class="flex min-w-0 flex-col gap-1 py-3" data-testid="work-item-comment">
          <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-gray-6">
            <span class="text-ink-gray-9">{author(entry)}</span><span>{formatDateTime(entry.createdAt)}</span>
            <Show when={entry.correctionOf}><Badge variant="outline" theme="blue" label={t("plan.corrects-an-earlier-comment.c10c")} /></Show>
            <Show when={corrected().has(entry.commentId)}><Badge variant="outline" theme="gray" label={t("plan.corrected-below.c10d")} /></Show>
          </p>
          <p classList={{ "break-words text-interface text-ink-gray-9": true, "text-ink-gray-6 line-through": corrected().has(entry.commentId) }}>{entry.text}</p>
          <Show when={delivery(entry)}>{(line) => <p class="text-caption text-ink-gray-6">{line()}</p>}</Show>
          <Show when={mine(entry) && !corrected().has(entry.commentId)}>
            <div><Button size="sm" variant="ghost" iconLeft="lucide-pencil" onClick={() => begin(entry)}>{t("plan.correct-this-comment.c10e")}</Button></div>
          </Show>
        </li>}</For>
      </ul>
    </ScreenRegion>
    <FormSheet open={open()} onClose={() => setOpen(false)} title={correcting() ? t("plan.correct-a-comment.c10f") : t("plan.add-a-comment.3e18")} centered
      description={t("plan.a-comment-is-sent-to-the-team-me.c110")} submit={correcting() ? t("plan.save-the-correction.c111") : t("plan.add-comment.7d37")} icon="lucide-message-square"
      error={error()} errorTitle={t("plan.the-comment-was-not-saved.c107")} disabled={!text().trim()} onSubmit={submit}>
      <Textarea label={t("plan.comment.153d")} required value={text()} onInput={(event) => setText(event.currentTarget.value)} />
    </FormSheet>
  </section>;
}
