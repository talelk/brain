import { createResource, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import type { ApprovalRequest, AttentionItem, Mission, PlanVersion, WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { approvalQuery } from "../../data/governor";
import { dialogSummary, effectParts, exactJson, plainSentence } from "../approval-text";
import { attentionAction, attentionHref, KIND_ICON, TIER_TONE } from "./AttentionDrawer";
import { ApprovalReview, ExpiryCountdown } from "./ApprovalReview";
import { DigestValue } from "./DigestValue";
import { IconTile } from "./primitives";
import { isFreshFromServer } from "../screen-region";
import { formatDateTime } from "../format";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** One inline action's busy and error state; a success tells the queue to re-read. */
function createRowAction(onChanged: () => void) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (busy()) return;
    setBusy(true); setError("");
    try { await fn(); onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The action was refused."); } finally { setBusy(false); }
  };
  return { busy, error, act };
}

function NoScope(props: { who: string }): JSX.Element {
  return <p class="text-caption text-ink-gray-7" data-testid="needs-you-no-scope">You can see this, but only {props.who} can decide it. Open it to read the details.</p>;
}

function ApprovalBody(props: { item: AttentionItem; onReviewOpen: (open: boolean) => void }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [loaded] = createResource(() => props.item.resourceId, async (id) => {
    const response = await approvalQuery(id);
    return { approval: response.snapshot as ApprovalRequest, asOf: response.asOf };
  });
  return <Show when={loaded()} fallback={<p class="text-caption text-ink-gray-7">Loading the exact proposal.</p>}>{(view) => {
    const approval = () => view().approval;
    const effect = () => effectParts(approval());
    return <div class="flex min-w-0 flex-col gap-2">
      <p class="m-0 break-words text-interface text-ink-gray-9">{plainSentence(approval())}</p>
      <p class="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-gray-7">
        <span>Asked by {app.personName(approval().requestedBy)}</span><ExpiryCountdown expiresAt={approval().subject.expiresAt} asOf={view().asOf} />
        <DigestValue value={approval().subjectDigest} label="Subject digest" />
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <ApprovalReview active={app.canApprove()} requireTwoFactor={app.identity()?.requireTwoFactor} approvalId={approval().approvalId}
          summary={dialogSummary(approval())} requestedBy={app.personName(approval().requestedBy)} expiresAt={approval().subject.expiresAt} asOf={view().asOf}
          targetLabel={`${effect().operation} on ${effect().target}`} exactContent={exactJson(approval())} subjectDigest={approval().subjectDigest} version={approval().version}
          fresh={approval().state === "pending" && isFreshFromServer(approval().subject.expiresAt, view().asOf)}
          createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={app.verifyIdentity} submitDecision={app.submitDecision} checkDecision={app.checkDecision}
          onOpenChange={props.onReviewOpen} />
        <Button variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(attentionHref(props.item))}>Full review and history</Button>
      </div>
      <Show when={!app.canApprove()}><NoScope who="an approver" /></Show>
    </div>;
  }}</Show>;
}

function PlanBody(props: { item: AttentionItem; mission?: Mission; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const row = createRowAction(props.onChanged);
  const [rejecting, setRejecting] = createSignal(false);
  const [reason, setReason] = createSignal("");
  const [plan] = createResource(() => props.item.resourceId, async (id) => (await query<Envelope<PlanVersion>>({ queryType: "plans.get", workspaceId: props.item.workspaceId, resourceId: id })).snapshot);
  const confirm = () => row.act(async () => {
    if (!props.mission) throw new Error("The mission is still loading.");
    const receipt = await app.run("plan.confirm", { planVersionId: props.item.resourceId }, { expectedVersion: props.mission.version });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  const reject = () => row.act(async () => {
    const receipt = await app.run("plan.reject", { planVersionId: props.item.resourceId, reason: reason().trim() });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  return <div class="flex min-w-0 flex-col gap-2">
    <Show when={plan()}>{(version) => <p class="m-0 break-words text-interface text-ink-gray-8">
      <Show when={version().summary}>{(summary) => <>{summary()} </>}</Show>
      {version().tasks.length} {version().tasks.length === 1 ? "task" : "tasks"}: {version().tasks.slice(0, 3).map((task) => task.title).join(", ")}{version().tasks.length > 3 ? ", and more" : ""}.
    </p>}</Show>
    <Show when={app.canDispatch()} fallback={<NoScope who="an operator" />}>
      <Show when={!rejecting()} fallback={<div class="flex min-w-0 flex-col gap-2">
        <TextInput label="Why not this plan?" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} />
        <div class="flex flex-wrap gap-2">
          <Button size="sm" variant="solid" theme="red" disabled={!reason().trim() || row.busy()} loading={row.busy()} onClick={() => void reject()}>Reject this plan</Button>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
        </div></div>}>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-check" disabled={row.busy() || !props.mission} loading={row.busy()} onClick={() => void confirm()}>Confirm this plan</Button>
          <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>Reject</Button>
          <Button size="sm" variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(attentionHref(props.item))}>Open the plan</Button>
        </div>
      </Show>
    </Show>
    <Show when={row.error()}><p role="alert" class="text-caption text-ink-red-7">{row.error()}</p></Show>
  </div>;
}

function ParkedBody(props: { item: AttentionItem; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const row = createRowAction(props.onChanged);
  const [dropping, setDropping] = createSignal(false);
  /** The work item's current version is read at the moment of the click, so a stale row never overwrites newer work. */
  const move = (state: "ready" | "abandoned") => row.act(async () => {
    const item = (await query<Envelope<WorkItem>>({ queryType: "workItems.get", workspaceId: props.item.workspaceId, resourceId: props.item.resourceId })).snapshot;
    const receipt = await app.run("workItem.transition", { workItemId: item.workItemId, state }, { expectedVersion: item.version });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  return <div class="flex min-w-0 flex-col gap-2">
    <Show when={app.canDispatch()} fallback={<NoScope who="an operator" />}>
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-rotate-ccw" disabled={row.busy()} onClick={() => void move("ready")}>Retry</Button>
        <Show when={!dropping()} fallback={<>
          <Button size="sm" variant="solid" theme="red" iconLeft="lucide-trash-2" disabled={row.busy()} onClick={() => void move("abandoned")}>Confirm drop</Button>
          <Button size="sm" variant="ghost" onClick={() => setDropping(false)}>Keep it</Button>
        </>}><Button size="sm" variant="outline" iconLeft="lucide-trash-2" disabled={row.busy()} onClick={() => setDropping(true)}>Drop</Button></Show>
        <Button size="sm" variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(attentionHref(props.item))}>Open the work</Button>
      </div>
    </Show>
    <Show when={row.error()}><p role="alert" class="text-caption text-ink-red-7">{row.error()}</p></Show>
  </div>;
}

function VerdictBody(props: { item: AttentionItem; mission?: Mission; onChanged: () => void }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const row = createRowAction(props.onChanged);
  const [confirming, setConfirming] = createSignal(false);
  const close = () => row.act(async () => {
    if (!props.mission) throw new Error("The mission is still loading.");
    const receipt = await app.run("mission.close", { missionId: props.mission.missionId, outcome: "achieved" }, { expectedVersion: props.mission.version });
    if (!receipt.accepted) throw new Error(receipt.detail);
  });
  return <div class="flex min-w-0 flex-col gap-2">
    <Show when={app.canDispatch()} fallback={<NoScope who="an operator" />}>
      <div class="flex flex-wrap items-center gap-2">
        <Show when={!confirming()} fallback={<>
          <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-badge-check" disabled={row.busy() || !props.mission} loading={row.busy()} onClick={() => void close()}>Yes, the goal is achieved</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Not yet</Button>
        </>}><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-badge-check" onClick={() => setConfirming(true)}>Sign off and close</Button></Show>
        <Button size="sm" variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(attentionHref(props.item))}>Review the verdict</Button>
      </div>
    </Show>
    <Show when={row.error()}><p role="alert" class="text-caption text-ink-red-7">{row.error()}</p></Show>
  </div>;
}

/**
 * The "Needs you" queue on Today (#51): the attention items in their fixed tiers,
 * each decidable where it stands. Inline actions are the existing commands and the
 * existing approval review (exact digest, step-up, recoverable decision), so scopes
 * and authentication are unchanged; a person without the scope still sees the item
 * and is told who can act.
 */
export function NeedsYouQueue(props: { items: readonly AttentionItem[]; missions: readonly Mission[]; onChanged: () => void }): JSX.Element {
  const navigate = useNavigate();
  /** While a review dialog is open the list holds still, so a poll never pulls the decided item (and its confirmation) away. */
  const [frozen, setFrozen] = createSignal<readonly AttentionItem[]>();
  const reviewOpen = (open: boolean) => { if (open) setFrozen(props.items); else { setFrozen(undefined); props.onChanged(); } };
  const mission = (item: AttentionItem) => props.missions.find((candidate) => candidate.missionId === (item.missionId ?? item.resourceId));
  return <ul class="m-0 flex min-w-0 list-none flex-col gap-3 p-0" aria-label="Needs you" data-testid="needs-you">
    <For each={frozen() ?? props.items}>{(item) => <li class="flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-2 p-3 sm:p-4" data-testid="needs-you-item" data-kind={item.kind}>
      <div class="flex min-w-0 items-start gap-3">
        <IconTile icon={KIND_ICON[item.kind]} tone={TIER_TONE[item.tier] ?? "gray"} />
        <div class="min-w-0 flex-1">
          <p class="m-0 text-caption font-medium uppercase tracking-wide text-ink-gray-6">{item.kind.replace("-", " ")}</p>
          <h3 class="m-0 break-words text-base-medium text-ink-gray-9">{item.title}</h3>
          <p class="m-0 mt-0.5 break-words text-interface text-ink-gray-7">{item.detail ?? `Waiting since ${formatDateTime(item.waitingSince)}`}</p>
        </div>
        <Badge variant="outline" theme={TIER_TONE[item.tier] ?? "gray"} label={`Tier ${item.tier}`} />
      </div>
      <div class="ps-0 sm:ps-[3.25rem]">
        {item.kind === "approval" ? <ApprovalBody item={item} onReviewOpen={reviewOpen} />
          : item.kind === "plan-proposal" ? <PlanBody item={item} mission={mission(item)} onChanged={props.onChanged} />
          : item.kind === "parked" ? <ParkedBody item={item} onChanged={props.onChanged} />
          : item.kind === "verdict-ready" ? <VerdictBody item={item} mission={mission(item)} onChanged={props.onChanged} />
          : <Button size="sm" variant="outline" iconRight="lucide-arrow-right" onClick={() => void navigate(attentionHref(item))}>{attentionAction(item)}</Button>}
      </div>
    </li>}</For>
  </ul>;
}
