import { PaneLayout } from "@talelk/newui-templates";
import type { JSX } from "solid-js";
import { Show, createSignal } from "solid-js";
import { Button, KeyValue } from "@talelk/newui-atoms";
import { Alert, Timeline } from "@talelk/newui-molecules";
import { DetailHeader, FilterBar, Section } from "@talelk/newui-organisms";
import type { ApprovalRequest } from "@brain/contracts";
import { BrainPage, KeyValueGrid, PageStack } from "../ui/components/PageLayout";
import { RecordCollection } from "../ui/components/RecordCollection";
import { statusHeaderTheme, statusLabel, StatusBadge } from "../ui/components/StatusBadge";
import { DigestValue } from "../ui/components/DigestValue";
import { ScreenRegion, DateText, isFreshFromServer } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { ApprovalReview } from "../ui/components/ApprovalReview";
import type { ApprovalIntent, ApprovalOutcome } from "../ui/approval-controller";
import { formatDateTime } from "../ui/format";
import { ReasonDialog } from "../ui/components/ReasonDialog";
import { RefreshButton } from "../ui/components/primitives";
import { DisclosureCard } from "../ui/components/primitives";

const workspaceLabel = (approval: ApprovalRequest) => "workspaceId" in approval ? String(approval.workspaceId) : "Authorized workspace";
const effectParts = (approval?: ApprovalRequest) => {
  const subject = (approval?.subject ?? {}) as { operation?: string; target?: { targetId?: string; environmentId?: string }; toolDigest?: string };
  return { subject, operation: subject.operation ?? "Requested effect", target: subject.target?.targetId ?? "Declared record", environment: subject.target?.environmentId };
};

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
  const [selected, setSelected] = createSignal<string>();
  const visible = () => props.approvals.filter((approval) => {
    const effect = effectParts(approval);
    return `${approval.approvalId} ${effect.operation} ${effect.target}`.toLowerCase().includes(query().toLowerCase());
  });
  const current = () => props.approvals.find((approval) => approval.approvalId === selected());
  const rows = () => visible().map((approval) => {
    const effect = effectParts(approval);
    return { id: approval.approvalId, approval: approval.approvalId, action: effect.operation,
      target: `${effect.target}${effect.environment ? ` · ${effect.environment}` : ""}`,
      workspace: workspaceLabel(approval), requester: approval.requestedBy, state: approval.state,
      expires: formatDateTime(approval.subject.expiresAt) };
  });
  return <BrainPage title="Approvals" description="Understand the exact effect, target, evidence, and expiry before making a decision."
    actions={<RefreshButton onClick={props.onRefresh} label="Refresh" />}>
    <PageStack>
      <FilterBar query={{ value: query(), placeholder: "Find an approval, action, or target…", onInput: setQuery }} resultCount={visible().length}
        chips={query() ? [{ label: `Search: ${query()}`, onRemove: () => setQuery("") }] : []} onClearAll={query() ? () => setQuery("") : undefined} />
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No approvals awaiting review" emptyDescription="Nothing is waiting on your decision." onRetry={props.onRefresh}>
        <PaneLayout active={current() ? "end" : "start"} start={<Section title="Review queue" description="Each decision applies to one exact proposal." surface="card">
          <RecordCollection title="Approvals" rows={rows()} columns={[
            { id: "action", header: "Action", accessorKey: "action", meta: { mobile: "title" } },
            { id: "approval", header: "Approval", accessorKey: "approval", meta: { mobile: "subtitle" } },
            { id: "target", header: "Target", accessorKey: "target", meta: { mobile: "meta" } },
            { id: "workspace", header: "Workspace", accessorKey: "workspace", meta: { mobile: "meta" } },
            { id: "requester", header: "Requester", accessorKey: "requester", meta: { mobile: "meta" } },
            { id: "state", header: "State", accessorKey: "state", meta: { mobile: "status" }, cell: (context) => <StatusBadge status={context.row.original.state} /> },
            { id: "expires", header: "Expires", accessorKey: "expires", meta: { mobile: "meta" } },
          ]} openLabel="Review" onOpen={setSelected} emptyTitle="No approvals match" />
        </Section>} end={<Show when={current()} keyed fallback={<p class="text-interface text-ink-gray-7">Select an approval to inspect its exact effect.</p>}>{(approval) => {
          const effect = effectParts(approval);
          return <Section title="Review this effect" surface="card"><PageStack>
            <Button size="lg" variant="ghost" iconLeft="lucide-arrow-left" class="self-start" onClick={() => setSelected(undefined)}>Back to approvals</Button>
            <div><StatusBadge status={approval.state} /><h3 class="mt-3 text-section text-ink-gray-9">{effect.operation} on {effect.target}</h3><p class="mt-1 text-interface text-ink-gray-7">Requested by {approval.requestedBy} · expires <DateText value={approval.subject.expiresAt} asOf={props.asOf} /></p></div>
            <KeyValueGrid items={[
              { label: "Workspace", value: workspaceLabel(approval) },
              { label: "Target / environment", value: `${effect.target} / ${effect.environment ?? "—"}` },
              { label: "Required evidence", value: props.requireTwoFactor ? "Authenticator code and exact subject" : "One-use session evidence and exact subject" },
            ]} />
            <DisclosureCard label="Exact proposal and digest" open><div class="pt-3"><DigestValue value={approval.subjectDigest} label="Subject digest" /><pre class="brain-readable whitespace-pre-wrap pt-3 text-caption">{JSON.stringify(approval.subject, null, 2)}</pre></div></DisclosureCard>
            <ApprovalReview active={props.active} requireTwoFactor={props.requireTwoFactor} approvalId={approval.approvalId}
              targetLabel={effect.operation} exactContent={JSON.stringify(approval.subject, null, 2)} subjectDigest={approval.subjectDigest} version={approval.version}
              fresh={!props.state.error && approval.state === "pending" && isFreshFromServer(approval.subject.expiresAt, props.state.asOf ?? props.asOf)}
              createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
            <Button size="lg" variant="outline" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpen(approval.approvalId)}>Open approval history</Button>
          </PageStack></Section>;
        }}</Show>} />
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}

export function ApprovalDetailScreen(props: {
  approval?: ApprovalRequest;
  state: ScreenState<ApprovalRequest>;
  asOf?: string;
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
  const exact = () => JSON.stringify(approval()?.subject ?? null, null, 2);
  const fresh = () => isFreshFromServer(approval()?.subject.expiresAt, props.state.asOf ?? props.asOf);
  return <BrainPage title="Approval review" description="Authorize one exact proposal with strong identity evidence and recoverable decision status."
    breadcrumbs={[{ label: "Approvals" }, { label: "Approval review" }]}
    actions={<><Button size="lg" variant="outline" iconLeft="lucide-arrow-left" onClick={props.onBack}>Back to approvals</Button><Button size="lg" variant="outline" theme="red" onClick={() => setRevokeOpen(true)}>Revoke</Button></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Approval not found"
      emptyDescription="It was decided, revoked, or belongs to a workspace you cannot read. Cached details were cleared."
      emptyAction={<Button size="md" variant="outline" onClick={props.onBack}>Back to approvals</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <DetailHeader title={`${effect().operation} on ${effect().target}`} headingLevel={2}
          subtitle={`${approval()?.approvalId ?? "Approval"} · requested by ${approval()?.requestedBy ?? "—"}`}
          status={{ label: statusLabel("approval", approval()?.state ?? "unknown"), theme: statusHeaderTheme("approval", approval()?.state ?? "unknown") }} />
        <Section title="Exact effect" description="Review every fact below before approving or rejecting this proposal." surface="card"><PageStack>
          <p class="text-base-medium text-ink-gray-9">Approve will {effect().operation} on <strong>{effect().target}</strong>{effect().environment ? ` in ${effect().environment}` : ""}{fresh() ? " while the proposal is still valid." : " — this proposal has expired or changed."}</p>
          <div class="grid gap-field-gap sm:grid-cols-2 lg:grid-cols-3">
            <KeyValue label="Target / environment" value={`${effect().target} / ${effect().environment ?? "—"}`} />
            <KeyValue label="Workspace" value={approval() ? workspaceLabel(approval()!) : "—"} />
            <KeyValue label="Version" value={String(approval()?.version ?? "—")} />
            <KeyValue label="Expires" value={<DateText value={approval()?.subject.expiresAt} asOf={props.asOf} />} />
            <KeyValue label="Requester" value={approval()?.requestedBy ?? "—"} />
            <KeyValue label="Required evidence" value={props.requireTwoFactor ? "Six-digit authenticator code plus exact subject digest." : "One-use evidence bound to this session and the exact subject digest."} />
          </div>
          <Show when={!fresh()}><Alert theme="red" variant="outline" title="This proposal is no longer valid" description="Expired approvals cannot be approved. Review the current proposal or ask for a new one." /></Show>
          <DisclosureCard label="Exact proposal, policy inputs, and digest" open><div class="pt-3"><DigestValue value={approval()?.subjectDigest ?? ""} label="Subject digest" /><pre class="brain-readable whitespace-pre-wrap pt-3 text-caption">{exact()}</pre></div></DisclosureCard>
          <ApprovalReview requireTwoFactor={props.requireTwoFactor} active approvalId={approval()?.approvalId ?? ""} targetLabel={`${effect().operation} on ${effect().target}`}
            exactContent={exact()} subjectDigest={approval()?.subjectDigest ?? ""} version={approval()?.version ?? 0} fresh={fresh()}
            createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
        </PageStack></Section>
        <Section title="Decision history" surface="card"><Show when={props.history.length} fallback={<p class="text-interface text-ink-gray-7">No prior decisions recorded for this approval.</p>}>
          <Timeline items={props.history.map((entry) => ({ title: entry.action, description: entry.actorId, timestamp: <DateText value={entry.occurredAt} />, tone: "gray" as const }))} />
        </Show></Section>
      </PageStack>
      <ReasonDialog open={revokeOpen()} onClose={() => setRevokeOpen(false)}
        title="Revoke this approval" description="A named reason is required; the approval stops being approvable for everyone."
        reason={revokeReason()} onReason={setRevokeReason} cancelLabel="Back" confirmLabel="Revoke approval" tone="red"
        onConfirm={(value) => { void props.onRevoke(value); setRevokeOpen(false); }} />
    </ScreenRegion>
  </BrainPage>;
}
