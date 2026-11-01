import { PaneLayout } from "@talelk/newui-templates";
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button, KeyValue } from "@talelk/newui-atoms";
import { Alert, Timeline } from "@talelk/newui-molecules";
import { DetailHeader, FilterBar } from "@talelk/newui-organisms";
import type { ApprovalRequest } from "@brain/contracts";
import { BrainPage, KeyValueGrid, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { statusHeaderTheme, statusLabel, StatusBadge } from "../ui/components/StatusBadge";
import { DigestValue } from "../ui/components/DigestValue";
import { ScreenRegion, DateText, RelativeTime, isFreshFromServer } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { ApprovalReview } from "../ui/components/ApprovalReview";
import type { ApprovalIntent, ApprovalOutcome } from "../ui/approval-controller";
import { ReasonDialog } from "../ui/components/ReasonDialog";
import { DisclosureCard, RefreshButton } from "../ui/components/primitives";
import { DetailAside, EmptyPreview, QueueRow, WorkspaceSection } from "../ui/components/Domain";

const workspaceLabel = (approval: ApprovalRequest) => approval.subject.workspaceId;
const effectParts = (approval?: ApprovalRequest) => ({
  operation: approval?.subject.operation ?? "Requested effect",
  target: approval?.subject.target.targetId ?? "Declared record",
  environment: approval?.subject.target.environmentId,
  tool: approval?.subject.tool?.id ?? "Declared capability",
  precondition: approval?.subject.target.preconditionDigest,
});
const exactJson = (approval?: ApprovalRequest) => JSON.stringify(approval?.subject ?? null, null, 2);

function EffectBounds(props: { approval: ApprovalRequest }): JSX.Element {
  const entries = () => Object.entries(props.approval.subject.effectBounds ?? {});
  return <div class="border-y border-outline-gray-1 py-4">
    <h3 class="text-base-medium text-ink-gray-9">What changes</h3>
    <p class="mt-1 text-interface text-ink-gray-6">These are the exact declared bounds of the proposed effect. No broader action is authorized.</p>
    <Show when={entries().length} fallback={<p class="mt-3 text-interface text-ink-gray-7">No additional effect bounds are declared; the operation, tool, input, target and pinned digests still bind this decision.</p>}>
      <dl class="mt-3 grid gap-3 sm:grid-cols-2"><For each={entries()}>{([key, value]) => <div class="min-w-0"><dt class="text-caption text-ink-gray-6">{key}</dt><dd class="mt-1 break-words text-interface text-ink-gray-9">{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>}</For></dl>
    </Show>
  </div>;
}

function ApprovalFacts(props: { approval: ApprovalRequest; asOf?: string }): JSX.Element {
  const effect = () => effectParts(props.approval);
  return <KeyValueGrid items={[
    { label: "Workspace", value: workspaceLabel(props.approval) },
    { label: "Target / environment", value: `${effect().target} / ${effect().environment ?? "No environment declared"}` },
    { label: "Pinned tool", value: effect().tool },
    { label: "Requester", value: props.approval.requestedBy },
    { label: "Expires", value: <DateText value={props.approval.subject.expiresAt} asOf={props.asOf} /> },
    { label: "Current record", value: `Version ${props.approval.version}` },
  ]} />;
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
  const [query, setQuery] = createSignal("");
  const [view, setView] = createSignal("pending");
  const [selected, setSelected] = createSignal<string>();
  const visible = () => props.approvals.filter((approval) => {
    const effect = effectParts(approval);
    const stateMatches = view() === "all" || (view() === "decided" ? ["approved", "rejected", "revoked"].includes(approval.state) : approval.state === view());
    return stateMatches && `${approval.approvalId} ${effect.operation} ${effect.target} ${approval.requestedBy}`.toLowerCase().includes(query().toLowerCase());
  }).sort((a, b) => Date.parse(a.subject.expiresAt) - Date.parse(b.subject.expiresAt));
  const current = () => visible().find((approval) => approval.approvalId === selected());
  return <BrainPage title="Approvals" description="Review one exact proposed effect at a time, with its target, evidence limits and expiry beside the decision."
    actions={<RefreshButton onClick={props.onRefresh} label="Refresh" />}>
    <PageStack>
      <FilterBar query={{ value: query(), placeholder: "Search action, target, requester, or approval…", onInput: (value) => { setQuery(value); setSelected(undefined); } }} resultCount={visible().length}
        tabs={{ label: "Approval state", value: view(), options: [{ value: "pending", label: "Pending" }, { value: "decided", label: "Decided" }, { value: "expired", label: "Expired" }, { value: "all", label: "All" }], onValueChange: (value) => { setView(value); setSelected(undefined); } }}
        chips={query() ? [{ label: `Search: ${query()}`, onRemove: () => setQuery("") }] : []} onClearAll={query() ? () => setQuery("") : undefined} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No approvals awaiting review" emptyDescription="Nothing is waiting on your decision." onRetry={props.onRefresh}>
        <PaneLayout class="brain-list-detail" startSize={46} minStartSize={32} maxStartSize={62} active={current() ? "end" : "start"} start={<section aria-label="Approvals"><WorkspaceSection title="Decision inbox" description="Expiring proposals appear first. Bulk production approval is intentionally unavailable.">
          <Show when={visible().length} fallback={<EmptyPreview icon="lucide-filter" title="No approvals in this view" description="Choose another state or clear the search to see other authorized proposals." />}>
            <div class="brain-queue"><For each={visible()}>{(approval) => {
              const effect = effectParts(approval);
              return <QueueRow label={`Review: ${approval.approvalId}`} title={`${effect.operation} on ${effect.target}`}
                description={`Requested by ${approval.requestedBy} · ${workspaceLabel(approval)}${effect.environment ? ` · ${effect.environment}` : ""}`}
                icon="lucide-shield-check" tone={approval.state === "pending" ? "amber" : "gray"} selected={current()?.approvalId === approval.approvalId}
                eyebrow={`${effect.tool} · exact effect review`} meta={<span>Expires <RelativeTime value={approval.subject.expiresAt} /></span>}
                trailing={<StatusBadge kind="approval" status={approval.state} />} onClick={() => setSelected(approval.approvalId)} />;
            }}</For></div>
          </Show>
        </WorkspaceSection></section>} end={<Show when={current()} keyed fallback={<EmptyPreview icon="lucide-shield-check" title="Select a proposal to review" description="The action sentence, exact bounds, target and decision control will appear here." />}>{(approval) => {
          const effect = effectParts(approval);
          return <PageStack>
            <Button size="lg" variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={() => setSelected(undefined)}>Back to approvals</Button>
            <div><StatusBadge kind="approval" status={approval.state} /><h2 class="mt-3 text-section text-ink-gray-9">{effect.operation} on {effect.target}</h2><p class="mt-2 text-interface text-ink-gray-7">Approval authorizes only this exact proposal. It does not mean the effect has executed or been independently verified.</p></div>
            <ApprovalFacts approval={approval} asOf={props.asOf} />
            <EffectBounds approval={approval} />
            <Alert theme="blue" variant="outline" title="Evidence is evaluated, not assumed" description="The approval read model supplies the pinned artifact and configuration references. It does not supply an independent completion verdict; inspect linked evidence before authorizing when required." />
            <div class="flex flex-wrap gap-2"><ApprovalReview active={props.active} requireTwoFactor={props.requireTwoFactor} approvalId={approval.approvalId}
              targetLabel={`${effect.operation} on ${effect.target}`} exactContent={exactJson(approval)} subjectDigest={approval.subjectDigest} version={approval.version}
              fresh={props.state.canMutate && approval.state === "pending" && isFreshFromServer(approval.subject.expiresAt, props.state.asOf ?? props.asOf)}
              createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
              <Button size="lg" variant="outline" iconRight="lucide-arrow-right" onClick={() => props.onOpen(approval.approvalId)}>Full review & history</Button></div>
            <TechnicalDetails label="Canonical subject and digest"><DigestValue value={approval.subjectDigest} label="Subject digest" /><pre class="brain-readable mt-3 whitespace-pre-wrap text-caption">{exactJson(approval)}</pre></TechnicalDetails>
          </PageStack>;
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
  const [revokeReason, setRevokeReason] = createSignal("");
  const [revokeOpen, setRevokeOpen] = createSignal(false);
  const approval = () => props.approval;
  const effect = () => effectParts(approval());
  const fresh = () => props.state.canMutate && approval()?.state === "pending" && isFreshFromServer(approval()?.subject.expiresAt, props.state.asOf ?? props.asOf);
  return <BrainPage title="Approval review" description="Understand the exact change first; record a recoverable decision only after reviewing its current target and bounds."
    breadcrumbs={[{ label: "Approvals" }, { label: "Approval review" }]}
    actions={<><Button size="lg" variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Back to approvals</Button><Show when={props.active && approval()?.state === "pending"}><Button size="lg" variant="outline" theme="red" onClick={() => setRevokeOpen(true)}>Revoke</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Approval not found"
      emptyDescription="It was decided, revoked, or belongs to a workspace you cannot read. Cached details were cleared."
      emptyAction={<Button size="md" variant="outline" onClick={props.onBack}>Back to approvals</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <DetailHeader title={`${effect().operation} on ${effect().target}`} headingLevel={2}
          subtitle={`Requested by ${approval()?.requestedBy ?? "—"} · ${approval() ? workspaceLabel(approval()!) : "workspace"}`}
          status={{ label: statusLabel("approval", approval()?.state ?? "unknown"), theme: statusHeaderTheme("approval", approval()?.state ?? "unknown") }} />
        <Show when={!fresh() && approval()?.state === "pending"}><Alert theme="red" variant="outline" title="This proposal cannot be approved" description="It expired, changed, or could not be freshly revalidated. Review the current proposal or ask for a new one." /></Show>
        <div class="brain-run-layout">
          <div class="brain-detail-stack">
            <WorkspaceSection title="Effect and impact" description="The human decision applies to this operation and no other target.">
              <p class="brain-prose text-section text-ink-gray-9">Approve will <strong>{effect().operation}</strong> on <strong>{effect().target}</strong>{effect().environment ? <> in <strong>{effect().environment}</strong></> : ""}.</p>
              <p class="brain-prose text-interface text-ink-gray-7">The pinned tool, input, artifact, policy and configuration bind the decision. Recording approval does not report an applied effect or verified completion.</p>
              <ApprovalFacts approval={approval()!} asOf={props.asOf} />
            </WorkspaceSection>
            <EffectBounds approval={approval()!} />
            <WorkspaceSection title="Precondition and evidence" description="Authority and proof remain separate stages.">
              <div class="grid gap-4 sm:grid-cols-2"><KeyValue label="Target precondition" value={effect().precondition ? <DigestValue value={effect().precondition!} label="Target precondition" /> : "No precondition digest declared"} orientation="vertical" /><KeyValue label="Independent completion evidence" value="No completion verdict is attached to an approval; a recorded decision is not an execution or verification receipt." orientation="vertical" /></div>
            </WorkspaceSection>
            <WorkspaceSection title="Decision history" description="The audit trail remains distinct from the current effect state.">
              <Show when={props.history.length} fallback={<p class="text-interface text-ink-gray-7">No prior decisions recorded for this approval.</p>}>
                <Timeline items={props.history.map((entry) => ({ title: entry.action, description: entry.actorId, timestamp: <DateText value={entry.occurredAt} />, tone: "gray" as const }))} />
              </Show>
            </WorkspaceSection>
            <DisclosureCard label="Advanced technical details"><div class="pt-3"><DigestValue value={approval()?.subjectDigest ?? ""} label="Subject digest" /><p class="mt-3 break-all text-caption">Configuration {approval()?.subject.configDigest} · policy {approval()?.subject.policyDigest} · artifact {approval()?.subject.artifactDigest}</p><pre class="brain-readable mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap text-caption">{exactJson(approval())}</pre></div></DisclosureCard>
          </div>
          <DetailAside title="Decision" description="One exact subject, one recoverable request." sticky>
            <div class="border-y border-outline-gray-1 py-4"><StatusBadge kind="approval" status={approval()?.state ?? "unknown"} /><p class="mt-3 text-interface text-ink-gray-7">{approval()?.state === "approved" ? "Decision recorded. Awaiting execution, effect observation and independent verification are separate states." : approval()?.state === "pending" ? "Awaiting human review. No effect is authorized by viewing this page." : "This proposal is closed to new decisions."}</p></div>
            <KeyValue label="Expires" value={<DateText value={approval()?.subject.expiresAt} asOf={props.asOf} />} orientation="vertical" />
            <KeyValue label="Required identity evidence" value={props.requireTwoFactor ? "Six-digit authenticator code bound to this exact subject." : "One-use evidence bound to this session and the exact subject digest."} orientation="vertical" />
            <ApprovalReview requireTwoFactor={props.requireTwoFactor} active={props.active} approvalId={approval()?.approvalId ?? ""} targetLabel={`${effect().operation} on ${effect().target}`}
              exactContent={exactJson(approval())} subjectDigest={approval()?.subjectDigest ?? ""} version={approval()?.version ?? 0} fresh={fresh()}
              createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
            <p class="text-caption text-ink-gray-6">If the response is lost, check the original decision. Never dispatch a new effect to recover an uncertain response.</p>
          </DetailAside>
        </div>
      </PageStack>
      <ReasonDialog open={revokeOpen()} onClose={() => setRevokeOpen(false)}
        title="Revoke this approval" description="A named reason is required; the approval stops being approvable for everyone."
        reason={revokeReason()} onReason={setRevokeReason} cancelLabel="Back" confirmLabel="Revoke approval" tone="red"
        onConfirm={(value) => { void props.onRevoke(value); setRevokeOpen(false); }} />
    </ScreenRegion>
  </BrainPage>;
}
