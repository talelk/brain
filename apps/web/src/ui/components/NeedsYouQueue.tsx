import { createResource, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, TextInput } from "@talelk/newui-atoms";
import type { ApprovalRequest, AttentionItem, Mission, PlanVersion, WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { approvalQuery } from "../../data/governor";
import { dialogSummary, effectParts, exactJson, plainSentence } from "../approval-text";
import { attentionAction, attentionHref } from "./AttentionDrawer";
import { ApprovalReview, ExpiryCountdown } from "./ApprovalReview";
import { DecisionCard } from "./DecisionCard";
import { SpendCapRaise, TaskFailure } from "./TaskFailure";
import { createScopedRead } from "../../data/screens";
import { DigestValue } from "./DigestValue";
import { isFreshFromServer } from "../screen-region";
import { formatDateTime } from "../format";
import { PlanEstimate } from "../usage/PlanEstimate";
import { t, tn } from "../../i18n";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** One inline action's busy and error state; a success tells the queue to re-read. */
function createRowAction(onChanged: () => void) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (busy()) return;
    setBusy(true); setError("");
    try { await fn(); onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("decision.refused")); } finally { setBusy(false); }
  };
  return { busy, error, act };
}

function NoScope(props: { who: "approver" | "operator" }): JSX.Element {
  return <p class="m-0 text-caption text-ink-gray-7" data-testid="needs-you-no-scope">{props.who === "approver" ? t("decision.noScope.approver") : t("decision.noScope.operator")}</p>;
}

/** The way to the full page of a decision: always the last of the other options, always the same words. */
function DetailsLink(props: { item: AttentionItem; label?: string }): JSX.Element {
  const navigate = useNavigate();
  return <Button size="sm" variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(attentionHref(props.item))}>{props.label ?? t("decision.details")}</Button>;
}

/** Why a card needs a person: the item's own cause, else how long it has waited. */
const whyOf = (item: AttentionItem): string => item.detail ?? t("decision.waitingSince", { when: formatDateTime(item.waitingSince) });

function ApprovalBody(props: { item: AttentionItem; onReviewOpen: (open: boolean) => void }): JSX.Element {
  const app = useApp();
  const [loaded] = createResource(() => props.item.resourceId, async (id) => {
    const response = await approvalQuery(id);
    return { approval: response.snapshot as ApprovalRequest, asOf: response.asOf };
  });
  return <DecisionCard kind={props.item.kind} tier={props.item.tier} title={props.item.title} why={whyOf(props.item)}
    recommended={<Show when={loaded()}>{(view) => {
      const approval = () => view().approval;
      const effect = () => effectParts(approval());
      return <ApprovalReview active={app.canApprove()} requireTwoFactor={app.identity()?.requireTwoFactor} approvalId={approval().approvalId}
        summary={dialogSummary(approval())} requestedBy={app.personName(approval().requestedBy)} expiresAt={approval().subject.expiresAt} asOf={view().asOf}
        targetLabel={`${effect().operation} on ${effect().target}`} exactContent={exactJson(approval())} subjectDigest={approval().subjectDigest} version={approval().version}
        fresh={approval().state === "pending" && isFreshFromServer(approval().subject.expiresAt, view().asOf)}
        createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={app.verifyIdentity} submitDecision={app.submitDecision} checkDecision={app.checkDecision}
        onOpenChange={props.onReviewOpen} />;
    }}</Show>}
    alternatives={<DetailsLink item={props.item} label={t("decision.fullReview")} />}>
    <Show when={loaded()} fallback={<p class="m-0 text-caption text-ink-gray-7">{t("decision.loadingProposal")}</p>}>{(view) => {
      const approval = () => view().approval;
      return <div class="flex min-w-0 flex-col gap-1">
        <p class="m-0 break-words text-interface text-ink-gray-9">{plainSentence(approval())}</p>
        <p class="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-gray-7">
          <span>{t("decision.askedBy", { name: app.personName(approval().requestedBy) })}</span><ExpiryCountdown expiresAt={approval().subject.expiresAt} asOf={view().asOf} />
          <span class="inline-flex flex-wrap items-center gap-1">{t("decision.fingerprint")} <DigestValue value={approval().subjectDigest} label={t("decision.fingerprintLabel")} /></span>
        </p>
        <Show when={!app.canApprove()}><NoScope who="approver" /></Show>
      </div>;
    }}</Show>
  </DecisionCard>;
}

function PlanBody(props: { item: AttentionItem; mission?: Mission; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const row = createRowAction(props.onChanged);
  const [rejecting, setRejecting] = createSignal(false);
  const [reason, setReason] = createSignal("");
  const [plan] = createResource(() => props.item.resourceId, async (id) => (await query<Envelope<PlanVersion>>({ queryType: "plans.get", workspaceId: props.item.workspaceId, resourceId: id })).snapshot);
  const confirm = () => row.act(async () => {
    if (!props.mission) throw new Error(t("decision.missionLoading"));
    const receipt = await app.run("plan.confirm", { planVersionId: props.item.resourceId }, { expectedVersion: props.mission.version });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  const reject = () => row.act(async () => {
    const receipt = await app.run("plan.reject", { planVersionId: props.item.resourceId, reason: reason().trim() });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  return <DecisionCard kind={props.item.kind} tier={props.item.tier} title={props.item.title} why={whyOf(props.item)} error={row.error()}
    recommended={<Show when={app.canDispatch()}><Show when={!rejecting()}>
      <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-check" disabled={row.busy() || !props.mission} loading={row.busy()} onClick={() => void confirm()}>{t("decision.plan.confirm")}</Button></Show></Show>}
    alternatives={<><Show when={app.canDispatch() && !rejecting()}><Button size="sm" variant="outline" onClick={() => setRejecting(true)}>{t("decision.plan.reject")}</Button></Show><DetailsLink item={props.item} label={t("decision.plan.open")} /></>}>
    <Show when={plan()}>{(version) => <p class="m-0 break-words text-interface text-ink-gray-8">
      <Show when={version().summary}>{(summary) => <>{summary()} </>}</Show>
      {tn("decision.plan.tasks", version().tasks.length)}: {version().tasks.slice(0, 3).map((task) => task.title).join(", ")}{version().tasks.length > 3 ? t("decision.plan.andMore") : ""}.
    </p>}</Show>
    <PlanEstimate planVersionId={props.item.resourceId} compact />
    <Show when={!app.canDispatch()}><NoScope who="operator" /></Show>
    <Show when={app.canDispatch() && rejecting()}>
      <div class="flex min-w-0 flex-col gap-2">
        <TextInput label={t("decision.plan.whyNot")} value={reason()} onInput={(event) => setReason(event.currentTarget.value)} />
        <div class="flex flex-wrap gap-2">
          <Button size="sm" variant="solid" theme="red" disabled={!reason().trim() || row.busy()} loading={row.busy()} onClick={() => void reject()}>{t("decision.plan.rejectThis")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>{t("decision.cancel")}</Button>
        </div>
      </div>
    </Show>
  </DecisionCard>;
}

function ParkedBody(props: { item: AttentionItem; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const row = createRowAction(props.onChanged);
  // The task itself says why it stopped (failure class, the one fix, its spend); read with everything else on the live store.
  const task = createScopedRead<WorkItem>({
    scope: app.scope, live: true,
    load: async (scope, signal) => {
      const response = await query<Envelope<WorkItem>>({ queryType: "workItems.get", workspaceId: props.item.workspaceId || scope.workspaceId, resourceId: props.item.resourceId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const overBudget = () => task.state().data?.remedy === "park-budget";
  const [dropping, setDropping] = createSignal(false);
  /** The work item's current version is read at the moment of the click, so a stale row never overwrites newer work. */
  const move = (state: "ready" | "abandoned") => row.act(async () => {
    const item = (await query<Envelope<WorkItem>>({ queryType: "workItems.get", workspaceId: props.item.workspaceId, resourceId: props.item.resourceId })).snapshot;
    const receipt = await app.run("workItem.transition", { workItemId: item.workItemId, state }, { expectedVersion: item.version });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  return <DecisionCard kind={props.item.kind} tier={props.item.tier} title={props.item.title} why={whyOf(props.item)} error={row.error()}
    recommended={<Show when={app.canDispatch()}><Show when={overBudget() && task.state().data} fallback={<Button size="sm" variant="solid" theme="blue" iconLeft="lucide-rotate-ccw" disabled={row.busy()} onClick={() => void move("ready")}>{t("decision.retry")}</Button>}>
      {(item) => <SpendCapRaise compact item={item()} onRaised={props.onChanged} />}</Show></Show>}
    alternatives={<><Show when={app.canDispatch()}><Show when={!dropping()} fallback={<>
      <Button size="sm" variant="solid" theme="red" iconLeft="lucide-trash-2" disabled={row.busy()} onClick={() => void move("abandoned")}>{t("decision.drop.confirm")}</Button>
      <Button size="sm" variant="ghost" onClick={() => setDropping(false)}>{t("decision.drop.keep")}</Button>
    </>}><Button size="sm" variant="outline" iconLeft="lucide-trash-2" disabled={row.busy()} onClick={() => setDropping(true)}>{t("decision.drop")}</Button></Show></Show>
      <DetailsLink item={props.item} label={t("decision.parked.details")} /></>}>
    <Show when={task.state().data?.failureClass ? task.state().data : undefined}>{(item) => <TaskFailure item={item()} />}</Show>
    <Show when={!app.canDispatch()}><NoScope who="operator" /></Show>
  </DecisionCard>;
}

/**
 * A step Brain lost contact with that may have changed something outside: never retried by itself. "Treat as failed" always works;
 * "Retry" is offered only when the Governor says a second run is harmless.
 */
function UnknownBody(props: { item: AttentionItem; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const row = createRowAction(props.onChanged);
  const settle = (resolution: "fail" | "retry") => row.act(async () => {
    const receipt = await app.run("job.reconcile", { jobId: props.item.resourceId, reason: resolution === "fail" ? "Treated as failed by a person" : "Retried by a person: the step only reads", resolution }, { expectedVersion: props.item.version ?? 1 });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  return <DecisionCard kind={props.item.kind} tier={props.item.tier} title={props.item.title} why={whyOf(props.item)} error={row.error()}
    recommended={<Show when={app.canDispatch()}>
      <Show when={props.item.safeToRetry} fallback={<Button size="sm" variant="solid" theme="red" iconLeft="lucide-circle-x" disabled={row.busy()} data-testid="unknown-fail" onClick={() => void settle("fail")}>{t("decision.unknown.fail")}</Button>}>
        <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-rotate-ccw" disabled={row.busy()} data-testid="unknown-retry" onClick={() => void settle("retry")}>{t("decision.retry")}</Button></Show></Show>}
    alternatives={<><Show when={app.canDispatch() && props.item.safeToRetry}><Button size="sm" variant="outline" iconLeft="lucide-circle-x" disabled={row.busy()} data-testid="unknown-fail" onClick={() => void settle("fail")}>{t("decision.unknown.fail")}</Button></Show>
      <DetailsLink item={props.item} label={t("decision.unknown.details")} /></>}>
    <Show when={!app.canDispatch()}><NoScope who="operator" /></Show>
  </DecisionCard>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A budget pause, settled on Today (backlog 36): the item says which limit was reached and offers one-click raises. A click is a
 * mission.budget.set of the whole current budget plus the preset (read at the moment of the click, so a stale row never overwrites a
 * newer limit), then mission.resume; both are audited with the person's name.
 */
function BudgetBody(props: { item: AttentionItem; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const row = createRowAction(props.onChanged);
  const limits = () => props.item.limits ?? [];
  const raise = (extra: { wallMs?: number; microUsd?: number; tokens?: number }) => row.act(async () => {
    const current = (await query<Envelope<Mission>>({ queryType: "missions.get", workspaceId: props.item.workspaceId, resourceId: props.item.resourceId })).snapshot;
    const { budget, usage } = current;
    const next = {
      ...budget,
      ...(extra.wallMs !== undefined ? { maxWallClockMs: Math.max(budget.maxWallClockMs ?? 0, usage.activeMs) + extra.wallMs } : {}),
      ...(extra.microUsd !== undefined ? { maxMicroUsd: Math.max(budget.maxMicroUsd ?? 0, usage.settledMicroUsd + usage.reservedMicroUsd) + extra.microUsd } : {}),
      ...(extra.tokens !== undefined ? { maxTokens: Math.max(budget.maxTokens ?? 0, usage.settledTokens + usage.reservedTokens) + extra.tokens } : {}),
    };
    const set = await app.run("mission.budget.set", { missionId: current.missionId, budget: next }, { expectedVersion: current.version });
    if (!set.accepted) throw new Error(set.detail);
    const fresh = (await query<Envelope<Mission>>({ queryType: "missions.get", workspaceId: props.item.workspaceId, resourceId: props.item.resourceId })).snapshot;
    const resumed = await app.run("mission.resume", { missionId: fresh.missionId }, { expectedVersion: fresh.version });
    if (!resumed.accepted) throw new Error(resumed.detail);
  });
  const resume = () => row.act(async () => {
    const current = (await query<Envelope<Mission>>({ queryType: "missions.get", workspaceId: props.item.workspaceId, resourceId: props.item.resourceId })).snapshot;
    const resumed = await app.run("mission.resume", { missionId: current.missionId }, { expectedVersion: current.version });
    if (!resumed.accepted) throw new Error(resumed.detail);
  });
  const preset = (label: string, extra: Parameters<typeof raise>[0], testId: string, recommended = false) =>
    <Button size="sm" variant={recommended ? "solid" : "outline"} theme={recommended ? "blue" : "gray"} iconLeft="lucide-play" disabled={row.busy()} loading={row.busy()} data-testid={testId} onClick={() => void raise(extra)}>{label}</Button>;
  return <DecisionCard kind={props.item.kind} tier={props.item.tier} title={props.item.title} why={whyOf(props.item)} error={row.error()}
    recommended={<Show when={app.canDispatch()}>
      <Show when={limits().length === 0}><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-play" disabled={row.busy()} loading={row.busy()} data-testid="budget-resume" onClick={() => void resume()}>{t("decision.budget.resume")}</Button></Show>
      <Show when={limits().includes("time")}>{preset(t("decision.budget.add30min"), { wallMs: 30 * MINUTE }, "budget-add-30min", true)}</Show>
      <Show when={!limits().includes("time") && limits().includes("money")}>{preset(t("decision.budget.add1usd"), { microUsd: 1_000_000 }, "budget-add-1usd", true)}</Show>
      <Show when={!limits().includes("time") && !limits().includes("money") && limits().includes("tokens")}>{preset(t("decision.budget.addTokens"), { tokens: 200_000 }, "budget-add-tokens", true)}</Show></Show>}
    alternatives={<><Show when={app.canDispatch()}>
      <Show when={limits().includes("time")}>{preset(t("decision.budget.add2h"), { wallMs: 2 * HOUR }, "budget-add-2h")}</Show>
      <Show when={limits().includes("money")}>{limits().includes("time") ? preset(t("decision.budget.add1usd"), { microUsd: 1_000_000 }, "budget-add-1usd") : null}{preset(t("decision.budget.add5usd"), { microUsd: 5_000_000 }, "budget-add-5usd")}</Show>
      <Show when={limits().includes("tokens") && (limits().includes("time") || limits().includes("money"))}>{preset(t("decision.budget.addTokens"), { tokens: 200_000 }, "budget-add-tokens")}</Show></Show>
      <DetailsLink item={props.item} label={limits().includes("workspace cap") ? t("decision.budget.raiseCap") : t("decision.details")} /></>}>
    <Show when={!app.canDispatch()}><NoScope who="operator" /></Show>
  </DecisionCard>;
}

function VerdictBody(props: { item: AttentionItem; mission?: Mission; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const row = createRowAction(props.onChanged);
  const [confirming, setConfirming] = createSignal(false);
  const close = () => row.act(async () => {
    if (!props.mission) throw new Error(t("decision.missionLoading"));
    const receipt = await app.run("mission.close", { missionId: props.mission.missionId, outcome: "achieved" }, { expectedVersion: props.mission.version });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  return <DecisionCard kind={props.item.kind} tier={props.item.tier} title={props.item.title} why={whyOf(props.item)} error={row.error()}
    recommended={<Show when={app.canDispatch()}><Show when={!confirming()} fallback={
      <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-badge-check" disabled={row.busy() || !props.mission} loading={row.busy()} onClick={() => void close()}>{t("decision.verdict.confirmed")}</Button>}>
      <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-badge-check" onClick={() => setConfirming(true)}>{t("decision.verdict.signOff")}</Button></Show></Show>}
    alternatives={<><Show when={app.canDispatch() && confirming()}><Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t("decision.verdict.notYet")}</Button></Show>
      <DetailsLink item={props.item} label={t("decision.verdict.review")} /></>}>
    <Show when={!app.canDispatch()}><NoScope who="operator" /></Show>
  </DecisionCard>;
}

/** Every other kind (needs attention, a failed schedule, a routed finding, a ready result): one recommended step that opens the page that owns it. */
function OpenBody(props: { item: AttentionItem }): JSX.Element {
  const navigate = useNavigate();
  return <DecisionCard kind={props.item.kind} tier={props.item.tier} title={props.item.title} why={whyOf(props.item)}
    recommended={<Button size="sm" variant="solid" theme="blue" iconRight="lucide-arrow-right" onClick={() => void navigate(attentionHref(props.item))}>{attentionAction(props.item)}</Button>} />;
}

/**
 * The "Needs you" queue (Today and Missions): the attention items in their fixed tiers, each decidable
 * where it stands and each rendered by the one decision card. Inline actions are the existing commands and
 * the existing approval review (exact digest, step-up, recoverable decision), so scopes and authentication
 * are unchanged; a person without the scope still sees the item and is told who can act.
 */
export function NeedsYouQueue(props: { items: readonly AttentionItem[]; missions: readonly Mission[]; onChanged: () => void }): JSX.Element {
  /** While a review dialog is open the list holds still, so a re-read never pulls the decided item (and its confirmation) away. */
  const [frozen, setFrozen] = createSignal<readonly AttentionItem[]>();
  const reviewOpen = (open: boolean) => { if (open) setFrozen(props.items); else { setFrozen(undefined); props.onChanged(); } };
  const mission = (item: AttentionItem) => props.missions.find((candidate) => candidate.missionId === (item.missionId ?? item.resourceId));
  return <ul class="m-0 flex min-w-0 list-none flex-col gap-3 p-0" aria-label={t("decision.queue")} data-testid="needs-you">
    <For each={frozen() ?? props.items}>{(item) => <li class="min-w-0">
      {item.kind === "approval" ? <ApprovalBody item={item} onReviewOpen={reviewOpen} />
        : item.kind === "plan-proposal" ? <PlanBody item={item} mission={mission(item)} onChanged={props.onChanged} />
        : item.kind === "budget-pause" ? <BudgetBody item={item} onChanged={props.onChanged} />
        : item.kind === "outcome-unknown" ? <UnknownBody item={item} onChanged={props.onChanged} />
        : item.kind === "parked" ? <ParkedBody item={item} onChanged={props.onChanged} />
        : item.kind === "verdict-ready" ? <VerdictBody item={item} mission={mission(item)} onChanged={props.onChanged} />
        : <OpenBody item={item} />}
    </li>}</For>
  </ul>;
}
