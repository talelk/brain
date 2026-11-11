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
      <div role="img" aria-label={`Approvals: ${rows().map((row) => `${row.count} ${row.label.toLowerCase()}`).join(", ")}`} class="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-surface-gray-3">
        <For each={rows()}>{(row) => <span class={`h-full ${row.fill}`} style={{ width: `${(row.count / total()) * 100}%` }} />}</For>
      </div>
      <ul class="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-7" aria-hidden="true">
        <For each={rows()}>{(row) => <li class="inline-flex items-center gap-1"><StatusIcon state={row.key === "decided" ? "ready" : row.key} theme={row.theme} />{row.label} {row.count}</li>}</For>
      </ul>
    </div>
  </Show>;
}

/** Who asked and when it lapses, one line. */
function AskLine(props: { approval: ApprovalRequest; asOf?: string }): JSX.Element {
  return <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-interface text-ink-gray-7">
    <span>Asked by {useApp().personName(props.approval.requestedBy)}</span>
    <Show when={props.approval.state === "pending"} fallback={<span>Expiry <DateText value={props.approval.subject.expiresAt} asOf={props.asOf} /></span>}>
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
  const entries = () => Object.entries(props.approval.subject.effectBounds ?? {});
  return <section class="border-b border-outline-gray-1 py-3" aria-label="Declared effect bounds">
    <h3 class="text-base-medium text-ink-gray-9">Declared bounds</h3>
    <p class="mt-1 text-interface text-ink-gray-6">Only these limits are authorized. The pinned operation, input, target and digests remain binding.</p>
    <Show when={entries().length} fallback={<p class="mt-2 text-interface text-ink-gray-7">No additional effect bounds are declared.</p>}>
      <dl class="mt-3 grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2"><For each={entries()}>{([key, value]) => <Fact label={key} value={typeof value === "string" ? value : JSON.stringify(value)} />}</For></dl>
    </Show>
  </section>;
}

function ApprovalFacts(props: { approval: ApprovalRequest; asOf?: string }): JSX.Element {
  const effect = () => effectParts(props.approval);
  return <dl class="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 border-y border-outline-gray-1 py-3 md:grid-cols-3">
    <Fact label="Workspace" value={workspaceLabel(props.approval)} />
    <Fact label="Current record" value={`Version ${props.approval.version}`} />
    <Fact label="Expires" value={<DateText value={props.approval.subject.expiresAt} asOf={props.asOf} />} wide class="md:col-span-1" />
    <Fact label="Target / environment" value={`${effect().target} / ${effect().environment ?? "No environment declared"}`} wide />
    <Fact label="Requester" value={useApp().personName(props.approval.requestedBy)} wide />
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
  const current = () => visible().find((approval) => approval.approvalId === selected());
  return <BrainPage title="Approvals" description="Review one exact proposed effect at a time, with its target, evidence limits and expiry beside the decision."
    actions={<Button variant="outline" iconLeft="lucide-refresh-cw" onClick={props.onRefresh}>Refresh</Button>}>
    <PageStack>
      <FilterBar query={{ value: query(), placeholder: "Search action, target, requester, or approval…", onInput: (value) => { setQuery(value); setSelected(undefined); setPage(1); } }} resultCount={visible().length}
        tabs={{ label: "Approval state", value: view(), options: [{ value: "pending", label: "Pending" }, { value: "decided", label: "Decided" }, { value: "expired", label: "Expired" }, { value: "all", label: "All" }], onValueChange: (value) => { setView(value); setSelected(undefined); setPage(1); } }}
        chips={query() ? [{ label: `Search: ${query()}`, onRemove: () => setQuery("") }] : []} onClearAll={query() ? () => setQuery("") : undefined} />
      <ApprovalMix approvals={props.approvals} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No approvals awaiting review" emptyDescription="Nothing is waiting on your decision." onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={42} minStartSize={32} maxStartSize={58} active={current() ? "end" : "start"} start={<section aria-label="Approvals"><WorkspaceSection title="Decision inbox" description="Expiring first. Each proposal requires its own exact review.">
          <Show when={visible().length} fallback={<EmptyState size="sm" icon="lucide-filter" title="No approvals in this view" description="Choose another state or clear the search to see other authorized proposals." />}>
            <div class="brain-queue"><For each={paged()}>{(approval) => {
              const effect = effectParts(approval);
              return <QueueRow label={`Review: ${approval.approvalId}`} title={`${effect.operation} on ${effect.target}`}
                description={`By ${app.personName(approval.requestedBy)} · ${workspaceLabel(approval)}`}
                icon="lucide-shield-check" tone={approval.state === "pending" ? "amber" : "gray"} selected={current()?.approvalId === approval.approvalId}
                eyebrow="Exact effect review" meta={approval.state === "pending" ? <ExpiryCountdown expiresAt={approval.subject.expiresAt} asOf={props.asOf} /> : <span>Expiry <RelativeTime value={approval.subject.expiresAt} /></span>}
                trailing={<StatusBadge kind="approval" status={approval.state} />} onClick={() => setSelected(approval.approvalId)} />;
            }}</For></div>
            <Show when={pageCount() > 1}><Pagination.Root aria-label="Decision inbox pagination" class="mt-3 flex-wrap items-center justify-between gap-3 border-t border-outline-gray-1 pt-3" count={visible().length} pageSize={INBOX_PAGE_SIZE} page={currentPage()} onPageChange={setPage}>
              <Pagination.Range />
              <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
            </Pagination.Root></Show>
          </Show>
        </WorkspaceSection></section>} end={<Show when={current()} keyed fallback={<EmptyState size="sm" icon="lucide-shield-check" title="Select a proposal to review" description="The action sentence, exact bounds, target and decision control will appear here." />}>{(approval) => {
          const effect = effectParts(approval);
          return <div class="flex min-w-0 flex-col gap-4">
            <Button size="sm" variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={() => setSelected(undefined)}>Back to approvals</Button>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2"><StatusBadge kind="approval" status={approval.state} /></div>
              <h2 class="mt-2 break-words [overflow-wrap:anywhere] text-section text-ink-gray-9">{plainSentence(approval)}</h2>
              <div class="mt-1"><AskLine approval={approval} asOf={props.asOf} /></div>
            </div>
            <div class="flex min-w-0 flex-wrap items-center gap-2"><ApprovalReview active={props.active} requireTwoFactor={props.requireTwoFactor} approvalId={approval.approvalId}
              summary={dialogSummary(approval)} requestedBy={app.personName(approval.requestedBy)} expiresAt={approval.subject.expiresAt} asOf={props.asOf}
              targetLabel={`${effect.operation} on ${effect.target}`} exactContent={exactJson(approval)} subjectDigest={approval.subjectDigest} version={approval.version}
              fresh={props.state.canMutate && approval.state === "pending" && isFreshFromServer(approval.subject.expiresAt, props.state.asOf ?? props.asOf)}
              createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
              <Button variant="outline" iconRight="lucide-arrow-right" onClick={() => props.onOpen(approval.approvalId)}>Full review & history</Button></div>
            <p class="text-interface text-ink-gray-7">Approving authorizes only this proposal, not its execution or independent verification.</p>
            <ApprovalFacts approval={approval} asOf={props.asOf} />
            <EffectBounds approval={approval} />
            <TechnicalDetails label="Exact details"><DigestValue value={approval.subjectDigest} label="Subject digest" /><pre class="brain-readable mt-3 max-w-full min-w-0 overflow-auto whitespace-pre-wrap break-all text-caption">{exactJson(approval)}</pre></TechnicalDetails>
          </div>;
        }}</Show>} />
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
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
  return <BrainPage title="Approval review" description="Review the exact change, evidence and authority before recording a recoverable decision."
    breadcrumbs={[{ label: "Approvals" }, { label: "Approval review" }]}
    actions={<><Button variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Back to approvals</Button><Show when={props.active && approval()?.state === "pending"}><Button variant="outline" theme="red" onClick={() => setRevokeOpen(true)}>Revoke</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Approval not found"
      emptyDescription="It was decided, revoked, or belongs to a workspace you cannot read. Cached details were cleared."
      emptyAction={<Button variant="outline" onClick={props.onBack}>Back to approvals</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <header class="min-w-0">
          <div class="flex flex-wrap items-center gap-2"><StatusBadge kind="approval" status={approval()?.state ?? "unknown"} /></div>
          <h2 class="mt-2 break-words [overflow-wrap:anywhere] text-section text-ink-gray-9">{plainSentence(approval())}</h2>
          <Show when={approval()}>{(a) => <div class="mt-1"><AskLine approval={a()} asOf={props.asOf} /></div>}</Show>
        </header>
        <Show when={!fresh() && approval()?.state === "pending"}><Alert theme="red" variant="outline" title="This proposal cannot be approved" description="It expired, changed, or could not be freshly revalidated. Review the current proposal or ask for a new one." /></Show>
        <Show when={approval()?.state === "expired"}><Alert theme="amber" variant="outline" title="This proposal expired" description="No new decision can be recorded. Ask the requester for a new exact proposal with a fresh expiry." /></Show>
        <div class="flex min-w-0 flex-wrap items-center gap-3">
          <ApprovalReview requireTwoFactor={props.requireTwoFactor} active={props.active} approvalId={approval()?.approvalId ?? ""} targetLabel={`${effect().operation} on ${effect().target}`}
            summary={dialogSummary(approval())} requestedBy={approval() ? app.personName(approval()!.requestedBy) : undefined} expiresAt={approval()?.subject.expiresAt} asOf={props.asOf}
            exactContent={exactJson(approval())} subjectDigest={approval()?.subjectDigest ?? ""} version={approval()?.version ?? 0} fresh={fresh()}
            createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
          <p class="min-w-0 text-caption text-ink-gray-6">Approve, reject or request changes in the review. If the response is lost, check the original decision; never dispatch a new effect to recover it.</p>
        </div>
        <div class="brain-run-layout">
          <div class="brain-detail-stack">
            <WorkspaceSection title="What will happen" description="Authority applies to this operation and no other target.">
              <PlainSummary icon="lucide-shield-check">{approval()?.state === "approved" ? "Decision recorded. Execution, effect observation and independent verification remain separate." : approval()?.state === "pending" ? "Awaiting human review. Viewing this page authorizes no effect." : "This proposal is closed to new decisions."}</PlainSummary>
              <ApprovalFacts approval={approval()!} asOf={props.asOf} />
              <A class="inline-flex items-center gap-1 text-interface text-ink-blue-8 hover:underline" href={`/w/${encodeURIComponent(approval()?.subject.workspaceId ?? "")}/live`}><span class="lucide-radio size-3.5" aria-hidden="true" />Open workspace Live</A>
            </WorkspaceSection>
            <EffectBounds approval={approval()!} />
          </div>
          <div class="brain-detail-stack lg:col-start-1">
            <WorkspaceSection title="Decision history" description="The audit trail remains distinct from the current effect state.">
              <Show when={props.history.length} fallback={<p class="text-interface text-ink-gray-7">No prior decisions recorded for this approval.</p>}>
                <ol class="min-w-0 divide-y divide-outline-gray-1 border-y border-outline-gray-1"><For each={props.history}>{(entry) => <li class="grid min-w-0 gap-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-4">
                  <div class="min-w-0"><p class="break-words [overflow-wrap:anywhere] text-interface font-medium text-ink-gray-9">{entry.action}</p><p class="mt-0.5 break-words [overflow-wrap:anywhere] text-caption text-ink-gray-6">{app.personName(entry.actorId)}</p></div>
                  <div class="text-caption text-ink-gray-6 sm:text-end"><DateText value={entry.occurredAt} /></div>
                </li>}</For></ol>
              </Show>
            </WorkspaceSection>
            <DisclosureCard label="Exact details"><div class="min-w-0">
              <dl class="grid min-w-0 gap-3 sm:grid-cols-2">
                <Fact label="Pinned tool" value={effect().tool} />
                <Fact label="Target precondition" value={effect().precondition ? <DigestValue value={effect().precondition!} label="Target precondition" /> : "No precondition digest declared"} />
                <Fact label="Required identity evidence" value={props.requireTwoFactor ? "Six-digit authenticator code bound to this exact subject." : "One-use evidence bound to this session and the exact subject digest."} wide class="max-sm:col-span-1" />
                <Fact label="Independent completion evidence" value="No completion verdict is attached to this approval; a recorded decision is not execution or verification." wide class="max-sm:col-span-1" />
                <Fact label="Subject digest" value={<DigestValue value={approval()?.subjectDigest ?? ""} label="Subject digest" />} wide class="max-sm:col-span-1" />
                <Fact label="Configuration digest" value={<DigestValue value={approval()?.subject.configDigest ?? ""} label="Configuration digest" />} />
                <Fact label="Policy digest" value={<DigestValue value={approval()?.subject.policyDigest ?? ""} label="Policy digest" />} />
                <Fact label="Artifact digest" value={<DigestValue value={approval()?.subject.artifactDigest ?? ""} label="Artifact digest" />} wide class="max-sm:col-span-1" />
              </dl>
              <pre class="brain-readable mt-4 max-h-[28rem] max-w-full min-w-0 overflow-auto whitespace-pre-wrap break-all text-caption">{exactJson(approval())}</pre>
            </div></DisclosureCard>
          </div>
        </div>
      </PageStack>
      <ReasonDialog open={revokeOpen()} onClose={() => setRevokeOpen(false)}
        title="Revoke this approval" description="A named reason is required; the approval stops being approvable for everyone."
        reason={revokeReason()} onReason={setRevokeReason} cancelLabel="Back" confirmLabel="Revoke approval" tone="red"
        onConfirm={(value) => { void props.onRevoke(value); setRevokeOpen(false); }} />
    </ScreenRegion>
  </BrainPage>;
}
