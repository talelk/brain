import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import type { BadgeTheme } from "@talelk/newui-atoms";
import type { Delegation, Mission } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { delegationsRead } from "../../data/engine";
import { ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "../components/Domain";
import { ActionFeedback } from "../components/ActionFeedback";
import { digestTag, formatDateTime } from "../format";
import { t, tn } from "../../i18n";
import { MISSION_DEPTH_LIMIT, STATUS_KEY, canAccept, delegationStatus, evidenceVerdictKey, type DelegationStatus } from "./delegation-model";

const STATUS_THEME: Readonly<Record<DelegationStatus, BadgeTheme>> = { working: "blue", "to-review": "amber", accepted: "green", rejected: "red", failed: "red" };

/** The delegations of a mission in one read, shared by the tab, the tab's label and the work item's panel. */
export function createDelegations(missionId: () => string) {
  const app = useApp();
  return createScopedRead<{ items: Delegation[] }>({
    scope: app.scope, live: true,
    load: (scope, signal) => delegationsRead(scope.workspaceId, missionId(), signal),
    isEmpty: (data) => data.items.length === 0,
  });
}

function Card(props: { item: Delegation; onDecided: () => void }): JSX.Element {
  const app = useApp();
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  const status = () => delegationStatus(props.item);
  const decide = async (decision: "accepted" | "rejected"): Promise<void> => {
    const digest = props.item.evidence?.digest;
    if (!digest || busy()) return;
    setBusy(true); setProblem("");
    try {
      const result = await app.run("delegation.review", { delegationId: props.item.delegationId, decision, evidenceDigest: digest });
      if (!result.accepted) setProblem(result.detail);
      props.onDecided();
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : t("delegations.refused")); } finally { setBusy(false); }
  };
  return <article class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-gray-2 bg-surface-white p-4" aria-label={props.item.task} data-delegation={props.item.delegationId} data-status={status()}>
    <div class="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <h3 class="m-0 min-w-0 break-words text-base-medium text-ink-gray-9">{props.item.task}</h3>
      <Badge variant="outline" theme={STATUS_THEME[status()]} label={t(STATUS_KEY[status()])} />
    </div>
    <p class="m-0 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-6">
      <span>{t("delegations.from", { task: props.item.workItemTitle })}</span>
      <span>{t("delegations.level", { depth: props.item.depth, max: MISSION_DEPTH_LIMIT })}</span>
      <Show when={props.item.memberId}><span>{t("delegations.member", { member: props.item.memberId ?? "" })}</span></Show>
      <span>{t("delegations.handed", { when: formatDateTime(props.item.createdAt) })}</span>
    </p>
    <Show when={status() === "working"}><p class="m-0 text-interface text-ink-gray-7">{props.item.run.state === "pending" ? t("delegations.pending") : t("delegations.working")}</p></Show>
    <Show when={props.item.run.state === "failed"}>
      <div class="flex min-w-0 flex-col gap-1 rounded-control border border-outline-red-2 bg-surface-red-1 p-3" role="note" data-delegation-failure>
        <p class="m-0 text-interface font-medium text-ink-red-4">{t("delegations.failed.title")}</p>
        <p class="m-0 break-words text-interface text-ink-gray-8">{props.item.run.failure ?? t("delegations.failed.noreason")}</p>
        <p class="m-0 text-caption text-ink-gray-7">{t("delegations.failed.told")}</p>
      </div>
    </Show>
    <Show when={props.item.run.state === "succeeded"}>
      <div class="flex min-w-0 flex-col gap-1">
        <h4 class="m-0 text-interface font-medium text-ink-gray-8">{t("delegations.result")}</h4>
        <p class="m-0 text-caption text-ink-gray-6">{t("delegations.result.claim")}</p>
        <pre class="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-gray-1 p-3 text-interface text-ink-gray-9" data-delegation-result>{props.item.run.result ?? t("delegations.result.none")}</pre>
      </div>
    </Show>
    <Show when={props.item.evidence}>{(evidence) => <p class="m-0 text-interface text-ink-gray-7" data-delegation-evidence>
      {t("delegations.evidence", { digest: digestTag(evidence().digest) })} {t(evidenceVerdictKey(evidence()))}
    </p>}</Show>
    <Show when={status() === "to-review"}>
      <Show when={props.item.review.possible} fallback={<p class="m-0 text-interface text-ink-gray-7" data-delegation-cannot>{props.item.review.reason ?? t("delegations.cannot")}</p>}>
        <div class="flex min-w-0 flex-col gap-2 border-t border-outline-gray-1 pt-3">
          <p class="m-0 text-interface text-ink-gray-8">{t("delegations.decide")}</p>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-check" loading={busy()} disabled={busy() || !canAccept(props.item)} onClick={() => void decide("accepted")}>{t("delegations.accept")}</Button>
            <Button size="sm" variant="outline" theme="red" iconLeft="lucide-x" loading={busy()} disabled={busy()} onClick={() => void decide("rejected")}>{t("delegations.reject")}</Button>
          </div>
          <Show when={!canAccept(props.item)}><p class="m-0 text-caption text-ink-gray-6" data-delegation-accept-needs>{t("delegations.accept.needs")}</p></Show>
          <ActionFeedback message={problem()} tone="error" title={t("delegations.refused")} />
        </div>
      </Show>
    </Show>
    <Show when={props.item.state !== "active"}>
      <p class="m-0 text-interface text-ink-gray-7" data-delegation-decided>{t(props.item.state === "accepted" ? "delegations.decided.accepted" : "delegations.decided.rejected", { who: app.personName(props.item.reviewerId), when: formatDateTime(props.item.reviewedAt) })}</p>
    </Show>
    <p class="m-0"><A class="text-caption text-ink-blue-link underline focus-visible:focus-ring" href={`/sessions/${encodeURIComponent(props.item.childSessionId)}`}>{t("delegations.open-session")}</A></p>
  </article>;
}

/**
 * Delegated work (ADR 0049): the sub-tasks sessions of this mission handed to child sessions, how each child's own run stands, what it handed back and what it could
 * not do, and the review a person who did not start the delegation decides. `?item=` narrows it to one task's delegations. Nothing here starts or stops a child.
 */
export function MissionDelegations(props: { mission: Mission; onChanged?: () => void }): JSX.Element {
  const [search, setSearch] = useSearchParams();
  const read = createDelegations(() => props.mission.missionId);
  const item = () => (typeof search.item === "string" ? search.item : "");
  const shown = () => (read.state().data?.items ?? []).filter((entry) => !item() || entry.workItemId === item());
  const waiting = () => (read.state().data?.items ?? []).filter((entry) => delegationStatus(entry) === "to-review" && entry.review.possible).length;
  return <WorkspaceSection title={t("delegations.title")} description={t("delegations.description")}>
    <ScreenRegion state={read.state()} onRetry={() => void read.refresh({ force: true })} emptyTitle={t("delegations.empty.title")} emptyDescription={t("delegations.empty.description")}>
      <div class="flex min-w-0 flex-col gap-3" data-delegations>
        <p class="m-0 text-interface text-ink-gray-7" role="status">{waiting() > 0 ? tn("delegations.waiting", waiting()) : t("delegations.none-waiting")}</p>
        <Show when={item()}>
          <p class="m-0 flex flex-wrap items-center gap-2 text-interface text-ink-gray-7">{t("delegations.filtered")}<Button size="sm" variant="ghost" onClick={() => setSearch({ item: undefined }, { replace: true })}>{t("delegations.show-all")}</Button></p>
        </Show>
        <For each={shown()}>{(entry) => <Card item={entry} onDecided={() => { void read.refresh({ force: true }); props.onChanged?.(); }} />}</For>
      </div>
    </ScreenRegion>
  </WorkspaceSection>;
}
