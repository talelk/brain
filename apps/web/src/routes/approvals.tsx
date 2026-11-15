import { PaneLayout } from "@talelk/newui-templates";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { For, Show, createSignal } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Alert, Pagination, EmptyState } from "@talelk/newui-molecules";
import { FilterBar } from "@talelk/newui-organisms";
import type { ApprovalRequest } from "@brain/contracts";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { DigestValue } from "../ui/components/DigestValue";
import { ScreenRegion, DateText, RelativeTime, isFreshFromServer } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { ApprovalReview, ExpiryCountdown } from "../ui/components/ApprovalReview";
import { dialogSummary, effectParts, exactJson, plainSentence } from "../ui/approval-text";
import { StatusIcon } from "../ui/viz/StatusIcon";
import { PlainSummary } from "../ui/viz/PlainSummary";
import type { ApprovalIntent, ApprovalOutcome } from "../ui/approval-controller";
import { ReasonDialog } from "../ui/components/ReasonDialog";
import { DisclosureCard } from "../ui/components/primitives";
import { QueueRow, WorkspaceSection } from "../ui/components/Domain";
import { DecisionCard } from "../ui/components/DecisionCard";
import { PullRequests } from "../ui/components/PullRequests";
import { ApprovalContextBlock } from "../ui/components/ApprovalContext";
import { t } from "../i18n";
import { useApp } from "../ui/app-context";
const workspaceLabel = (approval: ApprovalRequest) => approval.subject.workspaceId;
const INBOX_PAGE_SIZE = 25;
const isDecided = (state: string) => ["approved", "rejected", "revoked"].includes(state);
const MIX = [
  { key: "pending", label: "Pending", theme: "amber" as const, fill: "bg-surface-amber-6" },
  { key: "decided", label: "Decided", theme: "blue" as const, fill: "bg-surface-blue-7" },
  { key: "expired", label: "Expired", theme: "gray" as const, fill: "bg-surface-gray-5" },
];
/** Pending / decided / expired split of the inbox, with a text legend. */
function ApprovalMix(props: { approvals: ApprovalRequest[] }): JSX.Element {
  const rows = () => MIX.map((row) => ({ ...row, count: props.approvals.filter((a) => row.key === "decided" ? isDecided(a.state) : a.state === row.key).length })).filter((row) => row.count > 0);
  const total = () => rows().reduce((sum, row) => sum + row.count, 0);
  return <Show when={total() > 0}>
    <div class="flex min-w-0 flex-col gap-2">
      {/* One segment says nothing a legend does not: the bar only appears when there is a split to show. */}
      <Show when={rows().length > 1}><div role="img" aria-label={`Approvals: ${rows().map((row) => `${row.count} ${row.label.toLowerCase()}`).join(", ")}`} class="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-gray-3">
        <For each={rows()}>{(row) => <span class={`h-full ${row.fill}`} style={{ width: `${(row.count / total()) * 100}%` }} />}</For>
      </div></Show>
      <ul class="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-7" aria-hidden={rows().length > 1}>
        <For each={rows()}>{(row) => <li class="inline-flex items-center gap-1"><StatusIcon state={row.key === "decided" ? "ready" : row.key} theme={row.theme} />{row.label} {row.count}</li>}</For>
      </ul>
    </div>
  </Show>;
}

/** Who asked and when it lapses, one line. */
function AskLine(props: { approval: ApprovalRequest; asOf?: string }): JSX.Element {
  return <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-interface text-ink-gray-7">
    <span>Asked by {useApp().personName(props.approval.requestedBy)}</span>
    <Show when={props.approval.state === "pending"} fallback={<span>{t("mp.expiry.ba8f")} <DateText value={props.approval.subject.expiresAt} asOf={props.asOf} /></span>}>
      <ExpiryCountdown expiresAt={props.approval.subject.expiresAt} asOf={props.asOf} />
    </Show>
  </p>;
}

function Fact(props: { label: string; value: JSX.Element; wide?: boolean; class?: string }): JSX.Element {
  return <div class={`min-w-0 ${props.wide ? "col-span-2" : ""} ${props.class ?? ""}`}>
    <dt class="text-caption text-ink-gray-6">{props.label}</dt>
    <dd class="mt-0.5 min-w-0 break-words [overflow-wrap:anywhere] text-interface font-medium text-ink-gray-9">{props.value}</dd>
  </div>;
}

function EffectBounds(props: { approval: ApprovalRequest }): JSX.Element {
  // The files an approval would commit are shown as a diff beside it, so their JSON is not repeated here (the exact details keep it).
  const entries = () => Object.entries(props.approval.subject.effectBounds ?? {}).filter(([key]) => !(key === "arguments" && props.approval.context?.change));
  return <section class="border-b border-outline-gray-1 py-3" aria-label={t("mp.declared-effect-bounds.68b7")}>
    <h3 class="text-base-medium text-ink-gray-9">{t("mp.declared-bounds.cfcd")}</h3>
    <p class="mt-1 text-interface text-ink-gray-6">{t("mp.only-these-limits-are-authorized.36a8")}</p>
    <Show when={entries().length} fallback={<p class="mt-2 text-interface text-ink-gray-7">{t("mp.no-additional-effect-bounds-are.915b")}</p>}>
      <dl class="mt-3 grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2"><For each={entries()}>{([key, value]) => <Fact label={key} value={typeof value === "string" ? value : JSON.stringify(value)} />}</For></dl>
    </Show>
  </section>;
}

function ApprovalFacts(props: { approval: ApprovalRequest; asOf?: string }): JSX.Element {
  const effect = () => effectParts(props.approval);
  return <dl class="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 border-y border-outline-gray-1 py-3 md:grid-cols-3">
    <Fact label={t("mp.workspace.4ca0")} value={workspaceLabel(props.approval)} />
    <Fact label={t("mp.current-record.78ea")} value={`Version ${props.approval.version}`} />
    <Fact label={t("mp.expires.a99b")} value={<DateText value={props.approval.subject.expiresAt} asOf={props.asOf} />} wide class="md:col-span-1" />
    <Fact label={t("mp.target-environment.04aa")} value={`${effect().target} / ${effect().environment ?? "No environment declared"}`} wide />
    <Fact label={t("mp.requester.bcdf")} value={useApp().personName(props.approval.requestedBy)} wide />
  </dl>;
}

export function ApprovalsScreen(props: {
  approvals: ApprovalRequest[];
  state: ScreenState<ApprovalRequest[]>;
  asOf?: string;
  active: boolean;
  onRefresh: () => void;
  onOpen: (approvalId: string) => void;
  requireTwoFactor?: boolean;
  verifyIdentity: (approvalId: string, subjectDigest: string, code: string) => Promise<string>;
  submitDecision: (intent: ApprovalIntent, stepUpEvidenceId: string) => Promise<ApprovalOutcome>;
  checkDecision: (intent: ApprovalIntent) => Promise<ApprovalOutcome>;
}): JSX.Element {
  const app = useApp();
  const [query, setQuery] = createSignal("");
  const [view, setView] = createSignal("pending");
  const [selected, setSelected] = createSignal<string>();
  const [page, setPage] = createSignal(1);
  const visible = () => props.approvals.filter((approval) => {
    const effect = effectParts(approval);
    const stateMatches = view() === "all" || (view() === "decided" ? ["approved", "rejected", "revoked"].includes(approval.state) : approval.state === view());
    return stateMatches && `${approval.approvalId} ${effect.operation} ${effect.target} ${approval.requestedBy}`.toLowerCase().includes(query().toLowerCase());
  }).sort((a, b) => {
    // Urgency: pending first, soonest expiry first; closed proposals follow, newest expiry first.
    const pa = a.state === "pending" ? 0 : 1, pb = b.state === "pending" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const delta = Date.parse(a.subject.expiresAt) - Date.parse(b.subject.expiresAt);
    return pa === 0 ? delta : -delta;
  });
  const pageCount = () => Math.max(1, Math.ceil(visible().length / INBOX_PAGE_SIZE));
  const currentPage = () => Math.min(page(), pageCount());
  const paged = () => visible().slice((currentPage() - 1) * INBOX_PAGE_SIZE, currentPage() * INBOX_PAGE_SIZE);
  // A decided approval leaves the Pending list at once (the page re-reads when a command is sent), but the one being read stays open, so the person sees what was recorded.
  const current = () => visible().find((approval) => approval.approvalId === selected()) ?? props.approvals.find((approval) => approval.approvalId === selected());
  return <BrainPage title={t("mp.approvals.deb9")} description={t("mp.review-one-exact-proposed-effect.cdeb")}
   >
    <PageStack>
      <FilterBar query={{ value: query(), placeholder: t("mp.search-action-target-requester-o.0fb4"), onInput: (value) => { setQuery(value); setSelected(undefined); setPage(1); } }} resultCount={visible().length}
        tabs={{ label: t("mp.approval-state.69f0"), value: view(), options: [{ value: "pending", label: t("mp.pending.96f6") }, { value: "decided", label: t("mp.decided.5561") }, { value: "expired", label: t("mp.expired.a689") }, { value: "all", label: t("mp.all.6a72") }], onValueChange: (value) => { setView(value); setSelected(undefined); setPage(1); } }}
        chips={query() ? [{ label: `Search: ${query()}`, onRemove: () => setQuery("") }] : []} onClearAll={query() ? () => setQuery("") : undefined} />
      <ApprovalMix approvals={props.approvals} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle={t("mp.no-approvals-awaiting-review.37b7")} emptyDescription={t("mp.nothing-is-waiting-on-your-decis.ff20")} onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={42} minStartSize={32} maxStartSize={58} active={current() ? "end" : "start"} start={<section aria-label={t("mp.approvals.deb9")}><WorkspaceSection title={t("mp.decision-inbox.c26b")} description={t("mp.expiring-first-each-proposal-req.e692")}>
          <Show when={visible().length} fallback={<EmptyState size="sm" icon="lucide-filter" title={t("mp.no-approvals-in-this-view.f24b")} description={t("mp.choose-another-state-or-clear-th.408f")} />}>
            <div class="brain-queue"><For each={paged()}>{(approval) => {
              const effect = effectParts(approval);
              return <QueueRow label={`Review: ${approval.approvalId}`} title={`${effect.operation} on ${effect.target}`}
                description={`By ${app.personName(approval.requestedBy)} · ${workspaceLabel(approval)}`}
                icon="lucide-shield-check" tone={approval.state === "pending" ? "amber" : "gray"} selected={current()?.approvalId === approval.approvalId}
                eyebrow={t("mp.exact-effect-review.1322")} meta={approval.state === "pending" ? <ExpiryCountdown expiresAt={approval.subject.expiresAt} asOf={props.asOf} /> : <span>{t("mp.expiry.ba8f")} <RelativeTime value={approval.subject.expiresAt} /></span>}
                trailing={<StatusBadge kind="approval" status={approval.state} />} onClick={() => setSelected(approval.approvalId)} />;
            }}</For></div>
            <Show when={pageCount() > 1}><Pagination.Root aria-label={t("mp.decision-inbox-pagination.3976")} class="mt-3 flex-wrap items-center justify-between gap-3 border-t border-outline-gray-1 pt-3" count={visible().length} pageSize={INBOX_PAGE_SIZE} page={currentPage()} onPageChange={setPage}>
              <Pagination.Range />
              <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
            </Pagination.Root></Show>
          </Show>
        </WorkspaceSection></section>} end={<Show when={current()?.approvalId} keyed fallback={<EmptyState size="sm" icon="lucide-shield-check" title={t("mp.select-a-proposal-to-review.c7ef")} description={t("mp.the-action-sentence-exact-bounds.5dde")} />}>{(_approvalId) => {
          // The review keeps its place (and its dialog) while the approval is re-read; only another approval replaces it.
          const approval = () => current()!;
          const effect = () => effectParts(approval());
          return <div class="flex min-w-0 flex-col gap-4">
            <Button size="sm" variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={() => setSelected(undefined)}>{t("mp.back-to-approvals.8cd8")}</Button>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2"><StatusBadge kind="approval" status={approval().state} /></div>
              <h2 class="mt-2 break-words [overflow-wrap:anywhere] text-section text-ink-gray-9">{effectSummary(approval()) ?? plainSentence(approval())}</h2>
              <div class="mt-1"><AskLine approval={approval()} asOf={props.asOf} /></div>
            </div>
            <div class="flex min-w-0 flex-wrap items-center gap-2"><ApprovalReview active={props.active} requireTwoFactor={props.requireTwoFactor} approvalId={approval().approvalId} context={<ApprovalContextBlock approval={approval()} />}
              summary={dialogSummary(approval())} requestedBy={app.personName(approval().requestedBy)} expiresAt={approval().subject.expiresAt} asOf={props.asOf}
              targetLabel={`${effect().operation} on ${effect().target}`} exactContent={exactJson(approval())} subjectDigest={approval().subjectDigest} version={approval().version}
              fresh={props.state.canMutate && approval().state === "pending" && isFreshFromServer(approval().subject.expiresAt, props.state.asOf ?? props.asOf)}
              createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
              <Button variant="outline" iconRight="lucide-arrow-right" onClick={() => props.onOpen(approval().approvalId)}>{t("mp.full-review-history.88d6")}</Button></div>
            <p class="text-interface text-ink-gray-7">{t("mp.approving-authorizes-only-this-p.e094")}</p>
            <ApprovalContextBlock approval={approval()} />
            <ApprovalFacts approval={approval()} asOf={props.asOf} />
            <EffectBounds approval={approval()} />
            <TechnicalDetails label={t("mp.exact-details.c992")}><DigestValue value={approval().subjectDigest} label={t("mp.subject-digest.0300")} /><pre class="brain-readable mt-3 max-w-full min-w-0 overflow-auto whitespace-pre-wrap break-all text-caption">{exactJson(approval())}</pre></TechnicalDetails>
          </div>;
        }}</Show>} />
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}

/** What the requester told Brain this effect is, in their own words; the arguments are the exact input the tool will get. */
const effectSummary = (approval?: ApprovalRequest): string | undefined => {
  const said = approval?.subject.effectBounds?.["summary"];
  return typeof said === "string" && said.trim() ? said : undefined;
};
const effectArguments = (approval?: ApprovalRequest): [string, string][] => {
  const given = approval?.subject.effectBounds?.["arguments"];
  if (given === null || typeof given !== "object" || Array.isArray(given)) return [];
  return Object.entries(given).map(([key, value]): [string, string] => [key, typeof value === "string" ? value : JSON.stringify(value)]);
};

/**
 * The one card a phone needs for an effect: what will happen in plain words, the exact target, what it is given, who asked and when it
 * lapses, and two buttons. Approve and Deny both open the exact review (note, identity step-up, recoverable decision); nothing runs
 * before that decision is recorded.
 */
function EffectDecisionCard(props: { approval: ApprovalRequest; asOf?: string; review: JSX.Element }): JSX.Element {
  const app = useApp();
  const effect = () => effectParts(props.approval);
  const given = () => effectArguments(props.approval);
  return <DecisionCard kind="approval" tier={props.approval.state === "pending" ? 1 : 5} title={effectSummary(props.approval) ?? plainSentence(props.approval)}
    why={t("approval.card.asked", { name: app.personName(props.approval.requestedBy) })}
    recommended={props.review}>
    <div class="flex min-w-0 flex-col gap-3" data-approval-card={props.approval.state}>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-interface text-ink-gray-7">
        <StatusBadge kind="approval" status={props.approval.state} />
        <Show when={props.approval.state === "pending"} fallback={<span>{t("approval.card.state", { state: props.approval.state })}</span>}><ExpiryCountdown expiresAt={props.approval.subject.expiresAt} asOf={props.asOf} /></Show>
      </div>
      <dl class="m-0 grid min-w-0 gap-3">
        <div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("approval.card.what")}</dt><dd class="m-0 mt-0.5 break-words [overflow-wrap:anywhere] text-interface font-medium text-ink-gray-9" data-approval-what>{plainSentence(props.approval)}</dd></div>
        <div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("approval.card.target")}</dt><dd class="m-0 mt-0.5 break-words [overflow-wrap:anywhere] text-interface font-medium text-ink-gray-9" data-approval-target>{effect().environment ? t("approval.card.targetIn", { target: effect().target, environment: effect().environment ?? "" }) : effect().target}</dd></div>
        <div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("approval.card.workspace")}</dt><dd class="m-0 mt-0.5 break-words text-interface text-ink-gray-9">{workspaceLabel(props.approval)}</dd></div>
        <Show when={given().length > 0 && !props.approval.context?.change}><div class="min-w-0"><dt class="text-caption text-ink-gray-6">{t("approval.card.arguments")}</dt>
          <dd class="m-0 mt-0.5"><ul class="m-0 flex list-none flex-col gap-1 p-0" data-approval-arguments><For each={given()}>{([key, value]) => <li class="min-w-0 break-words [overflow-wrap:anywhere] text-interface text-ink-gray-9"><span class="text-ink-gray-6">{key}:</span> {value}</li>}</For></ul></dd></div></Show>
      </dl>
      <ApprovalContextBlock approval={props.approval} />
      <p class="m-0 text-caption text-ink-gray-6">{t("approval.card.once")}</p>
    </div>
  </DecisionCard>;
}

export function ApprovalDetailScreen(props: {
  approval?: ApprovalRequest;
  state: ScreenState<ApprovalRequest>;
  asOf?: string;
  active: boolean;
  onRefresh: () => void;
  onBack: () => void;
  history: { id: string; action: string; actorId: string; occurredAt: string }[];
  onRevoke: (reason: string) => Promise<void>;
  requireTwoFactor?: boolean;
  verifyIdentity: (approvalId: string, subjectDigest: string, code: string) => Promise<string>;
  submitDecision: (intent: ApprovalIntent, stepUpEvidenceId: string) => Promise<ApprovalOutcome>;
  checkDecision: (intent: ApprovalIntent) => Promise<ApprovalOutcome>;
}): JSX.Element {
  const app = useApp();
  const [revokeReason, setRevokeReason] = createSignal("");
  const [revokeOpen, setRevokeOpen] = createSignal(false);
  const approval = () => props.approval;
  const effect = () => effectParts(approval());
  const fresh = () => props.state.canMutate && approval()?.state === "pending" && isFreshFromServer(approval()?.subject.expiresAt, props.state.asOf ?? props.asOf);
  return <BrainPage title={t("mp.approval-review.a287")} description={t("mp.review-the-exact-change-evidence.a0c1")}
    breadcrumbs={[{ label: t("mp.approvals.deb9") }, { label: t("mp.approval-review.a287") }]}
    actions={<><Button variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>{t("mp.back-to-approvals.8cd8")}</Button><Show when={props.active && approval()?.state === "pending"}><Button variant="outline" theme="red" onClick={() => setRevokeOpen(true)}>{t("mp.revoke.0be7")}</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle={t("mp.approval-not-found.26c4")}
      emptyDescription={t("mp.it-was-decided-revoked-or-belong.f785")}
      emptyAction={<Button variant="outline" onClick={props.onBack}>{t("mp.back-to-approvals.8cd8")}</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <Show when={approval()}>{(current) => <EffectDecisionCard approval={current()} asOf={props.asOf}
          review={<ApprovalReview triggers="decision" requireTwoFactor={props.requireTwoFactor} active={props.active} approvalId={current().approvalId} context={<ApprovalContextBlock approval={current()} />} targetLabel={`${effect().operation} on ${effect().target}`}
            summary={dialogSummary(current())} requestedBy={app.personName(current().requestedBy)} expiresAt={current().subject.expiresAt} asOf={props.asOf}
            exactContent={exactJson(current())} subjectDigest={current().subjectDigest} version={current().version} fresh={fresh()}
            createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />} />}</Show>
        <Show when={!fresh() && approval()?.state === "pending"}><Alert theme="red" variant="outline" title={t("mp.this-proposal-cannot-be-approved.8ecb")} description={t("mp.it-expired-changed-or-could-not.dc77")} /></Show>
        <Show when={approval()?.state === "expired"}><Alert theme="amber" variant="outline" title={t("mp.this-proposal-expired.29bc")} description={t("mp.no-new-decision-can-be-recorded.f3c2")} /></Show>
        <p class="m-0 min-w-0 text-caption text-ink-gray-6">Approve, reject or request changes in the review. If the response is lost, check the original decision; never dispatch a new effect to recover it.</p>
        <div class="brain-run-layout">
          <div class="brain-detail-stack">
            <WorkspaceSection title={t("mp.what-will-happen.0361")} description={t("mp.authority-applies-to-this-operat.30ae")}>
              <PlainSummary icon="lucide-shield-check">{approval()?.state === "approved" ? "Decision recorded. Execution, effect observation and independent verification remain separate." : approval()?.state === "pending" ? t("mp.awaiting-human-review-viewing-th.d151") : t("mp.this-proposal-is-closed-to-new-d.ed04")}</PlainSummary>
              <ApprovalFacts approval={approval()!} asOf={props.asOf} />
              <A class="inline-flex items-center gap-1 text-interface text-ink-blue-8 hover:underline" href={`/w/${encodeURIComponent(approval()?.subject.workspaceId ?? "")}/live`}><span class="lucide-radio size-3.5" aria-hidden="true" />{t("mp.open-workspace-live.0b21")}</A>
            </WorkspaceSection>
            <EffectBounds approval={approval()!} />
          </div>
          <div class="brain-detail-stack lg:col-start-1">
            <Show when={approval()}>{(current) => <PullRequests resourceId={current().approvalId} workspaceId={current().subject.workspaceId} kind="approval" canRefresh={app.canDispatch() && current().subject.workspaceId === app.scope().workspaceId} />}</Show>
            <WorkspaceSection title={t("mp.decision-history.6286")} description={t("mp.the-audit-trail-remains-distinct.c088")}>
              <Show when={props.history.length} fallback={<p class="text-interface text-ink-gray-7">{t("mp.no-prior-decisions-recorded-for.bc04")}</p>}>
                <ol class="min-w-0 divide-y divide-outline-gray-1 border-y border-outline-gray-1"><For each={props.history}>{(entry) => <li class="grid min-w-0 gap-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-4">
                  <div class="min-w-0"><p class="break-words [overflow-wrap:anywhere] text-interface font-medium text-ink-gray-9">{entry.action}</p><p class="mt-0.5 break-words [overflow-wrap:anywhere] text-caption text-ink-gray-6">{app.personName(entry.actorId)}</p></div>
                  <div class="text-caption text-ink-gray-6 sm:text-end"><DateText value={entry.occurredAt} /></div>
                </li>}</For></ol>
              </Show>
            </WorkspaceSection>
            <DisclosureCard label={t("mp.exact-details.c992")}><div class="min-w-0">
              <dl class="grid min-w-0 gap-3 sm:grid-cols-2">
                <Fact label={t("mp.pinned-tool.7ddb")} value={effect().tool} />
                <Fact label={t("mp.target-precondition.c669")} value={effect().precondition ? <DigestValue value={effect().precondition!} label={t("mp.target-precondition.c669")} /> : "No precondition digest declared"} />
                <Fact label={t("mp.required-identity-evidence.952a")} value={props.requireTwoFactor ? t("mp.six-digit-authenticator-code-bou.497d") : t("mp.one-use-evidence-bound-to-this-s.8791")} wide class="max-sm:col-span-1" />
                <Fact label={t("mp.independent-completion-evidence.df7f")} value="No completion verdict is attached to this approval; a recorded decision is not execution or verification." wide class="max-sm:col-span-1" />
                <Fact label={t("mp.subject-digest.0300")} value={<DigestValue value={approval()?.subjectDigest ?? ""} label={t("mp.subject-digest.0300")} />} wide class="max-sm:col-span-1" />
                <Fact label={t("mp.configuration-digest.ab8b")} value={<DigestValue value={approval()?.subject.configDigest ?? ""} label={t("mp.configuration-digest.ab8b")} />} />
                <Fact label={t("mp.policy-digest.945d")} value={<DigestValue value={approval()?.subject.policyDigest ?? ""} label={t("mp.policy-digest.945d")} />} />
                <Fact label={t("mp.artifact-digest.2a12")} value={<DigestValue value={approval()?.subject.artifactDigest ?? ""} label={t("mp.artifact-digest.2a12")} />} wide class="max-sm:col-span-1" />
              </dl>
              <pre class="brain-readable mt-4 max-h-[28rem] max-w-full min-w-0 overflow-auto whitespace-pre-wrap break-all text-caption">{exactJson(approval())}</pre>
            </div></DisclosureCard>
          </div>
        </div>
      </PageStack>
      <ReasonDialog open={revokeOpen()} onClose={() => setRevokeOpen(false)}
        title={t("mp.revoke-this-approval.0f58")} description={t("mp.a-named-reason-is-required-the-a.ce32")}
        reason={revokeReason()} onReason={setRevokeReason} cancelLabel={t("mp.back.b52b")} confirmLabel={t("mp.revoke-approval.5d6a")} tone="red"
        onConfirm={(value) => { void props.onRevoke(value); setRevokeOpen(false); }} />
    </ScreenRegion>
  </BrainPage>;
}
