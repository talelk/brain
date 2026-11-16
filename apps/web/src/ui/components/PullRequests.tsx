import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import type { GitProvider, PullRequest, PullRequestState } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { createScopedRead } from "../../data/screens";
import { formatDateTime } from "../format";
import { t } from "../../i18n";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

const PROVIDERS: Readonly<Record<GitProvider, string>> = { github: "GitHub", "github-enterprise": "GitHub Enterprise", gitlab: "GitLab", gitea: "Gitea" };
const THEMES: Readonly<Record<PullRequestState, "green" | "blue" | "gray">> = { open: "green", merged: "blue", closed: "gray" };
const stateLabel = (state: PullRequestState): string => t(`pr.state.${state}` as "pr.state.open");

/** Only an address the provider gave over http(s) becomes a link; the Governor stores nothing else, and this keeps the page safe if that ever changed. */
const safeHref = (url: string): string | undefined => (/^https?:\/\//u.test(url) ? url : undefined);

/**
 * The pull requests an approved change opened (#121), on the work item that asked for them and in the approval's own page. Nothing renders
 * when there are none. A record is never edited: the state shown is the newest thing Brain read from the provider, with the time it read it,
 * and "Refresh state" reads it again by hand and adds to the history below. Nothing here changes anything at the provider.
 */
export function PullRequests(props: { resourceId: string; workspaceId: string; kind: "work-item" | "approval"; canRefresh: boolean }): JSX.Element {
  const app = useApp();
  const list = createScopedRead<PullRequest[]>({
    scope: app.scope,
    resource: () => props.resourceId,
    load: async (_scope, signal, resourceId) => {
      const response = await query<Envelope<{ items: PullRequest[] }>>({ queryType: "pullRequests.list", workspaceId: props.workspaceId, resourceId }, signal);
      return { snapshot: response.snapshot.items, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
  });
  const [busy, setBusy] = createSignal("");
  const [error, setError] = createSignal<{ id: string; reason: string } | undefined>();

  async function refresh(record: PullRequest): Promise<void> {
    setBusy(record.pullRequestId); setError(undefined);
    try {
      const result = await app.run("pullRequest.refresh", { pullRequestId: record.pullRequestId });
      if (!result.accepted) setError({ id: record.pullRequestId, reason: result.detail });
      else await list.refresh({ force: true });
    } catch (failure) {
      setError({ id: record.pullRequestId, reason: failure instanceof Error ? failure.message : t("pr.refresh-failed") });
    } finally { setBusy(""); }
  }
  const who = (entry: PullRequest["observations"][number]): string => (entry.source === "opened" ? t("pr.when-opened") : entry.source === "webhook" ? t("pr.reported-by-webhook") : t("pr.checked-by", { name: entry.observedBy ? app.personName(entry.observedBy) : "" }));
  const checks = (record: PullRequest): string => (record.checks ?? []).map((check) => `${check.name} ${t(`pr.check.${check.conclusion}` as "pr.check.success")}`).join(", ");

  return <Show when={(list.state().data ?? []).length > 0}>
    <section class="flex min-w-0 flex-col gap-3" aria-label={t("pr.title")} data-testid="pull-requests">
      <div><h4 class="text-base-medium">{t("pr.title")}</h4><p class="text-caption text-ink-gray-6">{t("pr.explainer")}</p></div>
      <ul class="flex flex-col divide-y divide-outline-gray-1 border-y border-outline-gray-1">
        <For each={list.state().data ?? []}>{(record) => <li class="flex min-w-0 flex-col gap-2 py-3" data-testid="pull-request" data-pull-request={record.pullRequestId}>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Show when={safeHref(record.url)} fallback={<span class="break-words text-interface font-medium text-ink-gray-9">{record.title}</span>}>
              {(href) => <a class="break-words text-interface font-medium text-ink-blue-8 hover:underline" href={href()} target="_blank" rel="noopener noreferrer" data-testid="pull-request-link">{record.title}<span class="sr-only"> {t("pr.opens-in-new-tab")}</span></a>}
            </Show>
            <span data-testid="pull-request-state"><Badge variant="outline" theme={THEMES[record.state]} label={stateLabel(record.state)} /></span>
          </div>
          <p class="text-caption text-ink-gray-6">{t("pr.where", { provider: PROVIDERS[record.provider], number: String(record.number), branch: record.branch, base: record.base })}</p>
          <p class="text-caption text-ink-gray-6">{t("pr.opened-at", { when: formatDateTime(record.openedAt) })} · {t("pr.state-read", { when: formatDateTime(record.stateObservedAt) })}</p>
          <Show when={(record.checks ?? []).length > 0}><p class="text-caption text-ink-gray-6" data-testid="pull-request-checks">{t("pr.checks", { list: checks(record) })}</p></Show>
          <div class="flex flex-wrap items-center gap-2">
            <Show when={props.canRefresh}><Button size="sm" variant="outline" iconLeft="lucide-refresh-cw" disabled={busy() !== ""} onClick={() => void refresh(record)}>{busy() === record.pullRequestId ? t("pr.refreshing") : t("pr.refresh")}</Button></Show>
            <Show when={props.kind === "work-item"}><A class="text-caption text-ink-blue-8 hover:underline" href={`/approvals/${encodeURIComponent(record.approvalId)}`}>{t("pr.see-approval")}</A></Show>
            <Show when={props.kind === "approval" && record.missionId && record.workItemId}><A class="text-caption text-ink-blue-8 hover:underline" href={`/missions/${encodeURIComponent(record.missionId!)}/plan?item=${encodeURIComponent(record.workItemId!)}`}>{t("pr.see-work-item")}</A></Show>
          </div>
          <Show when={error()?.id === record.pullRequestId}><p role="alert" class="text-caption text-ink-red-8" data-testid="pull-request-error">{t("pr.refresh-error", { reason: error()!.reason })}</p></Show>
          <details class="text-caption text-ink-gray-7">
            <summary class="cursor-pointer text-ink-gray-6">{t("pr.history", { n: String(record.observations.length) })}</summary>
            <ol class="mt-1 flex list-none flex-col gap-0.5 p-0" data-testid="pull-request-history">
              <For each={[...record.observations].reverse()}>{(entry) => <li>{t("pr.history-entry", { state: stateLabel(entry.state), when: formatDateTime(entry.observedAt), who: who(entry) })}</li>}</For>
            </ol>
          </details>
        </li>}</For>
      </ul>
    </section>
  </Show>;
}
