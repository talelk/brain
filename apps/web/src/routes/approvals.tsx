import { PaneLayout } from "@talelk/newui-templates";
import type { JSX } from "solid-js";
import { Show, createSignal } from "solid-js";
import { Button, KeyValue, Textarea } from "@talelk/newui-atoms";
import { Alert, Dialog, Timeline } from "@talelk/newui-molecules";
import { DetailHeader, Section } from "@talelk/newui-organisms";
import type { ApprovalRequest } from "@brain/contracts";
import { PageIntro, KeyValueGrid } from "../ui/components/PageLayout";
import { RecordCollection } from "../ui/components/RecordCollection";
import { StatusBadge } from "../ui/components/StatusBadge";
import { DigestValue } from "../ui/components/DigestValue";
import { ScreenRegion, DateText, isFreshFromServer } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { ApprovalReview } from "../ui/components/ApprovalReview";
import type { ApprovalIntent, ApprovalOutcome } from "../ui/approval-controller";

const workspaceLabel = (approval: ApprovalRequest) => "workspaceId" in approval ? String(approval.workspaceId) : "Authorized workspace";

/**
 * The approvals list. Rows are read-only until the exact-review dialog is open:
 * a bulk action can never approve production effects.
 */
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
  const rows = () => props.approvals.map((approval) => {
    const subject = approval.subject as { operation?: string; target?: { targetId?: string; environmentId?: string } };
    return { id: approval.approvalId, approval: approval.approvalId, action: subject.operation ?? "Requested effect",
      target: `${subject.target?.targetId ?? "Declared record"}${subject.target?.environmentId ? ` · ${subject.target.environmentId}` : ""}`,
      workspace: workspaceLabel(approval), requester: approval.requestedBy, state: approval.state,
      expires: new Date(approval.subject.expiresAt).toLocaleString() };
  });
  const [selected,setSelected] = createSignal<string | undefined>();
  const current = () => props.approvals.find((approval) => approval.approvalId === selected());
  return <div class="brain-detail-stack"><PageIntro title="Decision queue" description="Understand the effect, target and expiry before authorizing an exact proposal." />
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No approvals awaiting review" emptyDescription="Nothing is waiting on your decision." onRetry={props.onRefresh}>
      <PaneLayout active={current() ? "end" : "start"} start={<Section title="Review queue" surface="card">
        <RecordCollection title="Approvals" rows={rows()} columns={[
          {id:"action",header:"Action",accessorKey:"action"},{id:"approval",header:"Approval",accessorKey:"approval"},{id:"target",header:"Target",accessorKey:"target"},
          {id:"workspace",header:"Workspace",accessorKey:"workspace"},{id:"requester",header:"Requester",accessorKey:"requester"},
          {id:"state",header:"State",accessorKey:"state"},{id:"expires",header:"Expires",accessorKey:"expires"},
        ]} openLabel="Review" onOpen={(id) => setSelected(id)} />
      </Section>} end={<Show when={current()} keyed fallback={<p>Select an approval to inspect its exact effect.</p>}>{(approval) => {
        const subject = approval.subject as { operation?: string; target?: { targetId?: string; environmentId?: string } };
        return <Section title="Review this effect" surface="card"><div class="brain-detail-stack">
          <Button variant="ghost" class="min-h-11 self-start" onClick={() => setSelected(undefined)}>Back to approvals</Button>
          <div><StatusBadge status={approval.state} /><h3 class="mt-2 text-base-medium">{subject.operation ?? "Requested effect"} on {subject.target?.targetId ?? "the declared record"}</h3><p class="text-base text-ink-gray-7">Requested by {approval.requestedBy} · expires <DateText value={approval.subject.expiresAt} asOf={props.asOf} /></p></div>
          <KeyValueGrid items={[{ label: "Workspace", value: workspaceLabel(approval) }, { label: "Target / environment", value: `${subject.target?.targetId ?? "—"} / ${subject.target?.environmentId ?? "—"}` }, { label: "Evidence", value: props.requireTwoFactor ? "Authenticator code and exact subject" : "One-use session evidence and exact subject" }]} />
          <details><summary class="cursor-pointer text-base-medium">Exact proposal and digest</summary><div class="pt-2"><DigestValue value={approval.subjectDigest} label="Subject digest" /><pre class="brain-readable whitespace-pre-wrap pt-2 text-caption">{JSON.stringify(approval.subject,null,2)}</pre></div></details>
          <ApprovalReview active={props.active} requireTwoFactor={props.requireTwoFactor} approvalId={approval.approvalId}
            targetLabel={String(approval.subject.operation)} exactContent={JSON.stringify(approval.subject,null,2)} subjectDigest={approval.subjectDigest} version={approval.version}
            fresh={!props.state.error && approval.state === "pending" && isFreshFromServer(approval.subject.expiresAt,props.state.asOf ?? props.asOf)}
            createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
          <Button variant="outline" class="min-h-11 self-start" onClick={() => props.onOpen(approval.approvalId)}>Open approval history</Button>
        </div></Section>;
      }}</Show>} />
    </ScreenRegion>
  </div>;
}

/**
 * The dedicated approval review screen (`/approvals/:id`).
 *
 * The main action sentence names the effect, the target/environment, the exact
 * content digest, the expiry and the required evidence — before any button is
 * enabled. Recovery reuses the captured idempotency key against the
 * decision-status endpoint.
 */
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
  const subject = () => (approval()?.subject ?? {}) as { operation?: string; target?: { targetId?: string; environmentId?: string }; toolDigest?: string };
  const exact = () => JSON.stringify(approval()?.subject ?? null, null, 2);
  const fresh = () => isFreshFromServer(approval()?.subject.expiresAt, props.state.asOf ?? props.asOf);

  return (
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Approval not found"
      emptyDescription="It was decided, revoked, or it belongs to a workspace you cannot read. Cached details were cleared."
      emptyAction={<Button onClick={props.onBack}>Back to approvals</Button>} onRetry={props.onRefresh}>
      <DetailHeader title="Authorize this effect" headingLevel={2}
        breadcrumbs={[{ label: "Approvals" }]}
        subtitle={approval()?.approvalId}
        status={{ label: approval()?.state ?? "unknown", theme: approval()?.state === "pending" ? "blue" : "gray" }}
        actions={[{ label: "Back to approvals", onClick: props.onBack }, { label: "Revoke", onClick: () => setRevokeOpen(true) }]} />

      <Section surface="card" title="Exact effect">
        <div class="flex flex-col gap-field-gap">
          <p class="text-base-medium text-ink-gray-9">
            Approve will {subject().operation ?? "execute"} on{" "}
            <strong>{subject().target?.targetId ?? "the declared target"}</strong>
            {subject().target?.environmentId ? ` in ${String(subject().target?.environmentId)}` : ""}
            {fresh() ? " while the proposal is still valid." : " — this proposal has expired or changed."}
          </p>
          <div class="grid gap-field-gap sm:grid-cols-2">
            <KeyValue label="Target / environment" value={`${subject().target?.targetId ?? "—"} / ${subject().target?.environmentId ?? "—"}`} />
            <KeyValue label="Workspace" value={approval() ? workspaceLabel(approval()!) : "—"} />
            <KeyValue label="Version" value={String(approval()?.version ?? "—")} />
            <KeyValue label="Expires" value={<DateText value={approval()?.subject.expiresAt} asOf={props.asOf} />} />
            <KeyValue label="Requester" value={approval()?.requestedBy ?? "—"} />
            <KeyValue label="Required evidence" value={props.requireTwoFactor ? "A six-digit authenticator code plus the exact subject digest." : "One-use evidence bound to this session and the exact subject digest."} />
          </div>
          <Show when={!fresh()}><Alert theme="red" variant="outline" title="This proposal is no longer valid" description="Expired approvals cannot be approved. Review the current proposal or ask for a new one." /></Show>
          <details class="rounded-card border border-outline-gray-2 p-card-pad">
            <summary class="cursor-pointer text-base-medium">Exact proposal, policy inputs and digest</summary>
            <div class="pt-field"><DigestValue value={approval()?.subjectDigest ?? ""} label="Subject digest" /></div>
            <pre class="brain-readable whitespace-pre-wrap pt-field text-caption">{exact()}</pre>
          </details>
          <ApprovalReview requireTwoFactor={props.requireTwoFactor} active approvalId={approval()?.approvalId ?? ""} targetLabel={`${subject().operation ?? "effect"} on ${subject().target?.targetId ?? "record"}`}
            exactContent={exact()} subjectDigest={approval()?.subjectDigest ?? ""} version={approval()?.version ?? 0} fresh={fresh()}
            createIdempotencyKey={() => `web-${crypto.randomUUID()}`}
            verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
        </div>
      </Section>

      <Section title="Decision history" surface="card">
        <Show when={props.history.length} fallback={<p>No prior decisions recorded for this approval.</p>}>
          <Timeline items={props.history.map((entry) => ({
            title: entry.action, description: entry.actorId, timestamp: <DateText value={entry.occurredAt} />, tone: "gray" as const,
          }))} />
        </Show>
      </Section>

      <Dialog.Root open={revokeOpen()} onOpenChange={setRevokeOpen}>
        <Dialog.Content size="md">
          <Dialog.Header>
            <Dialog.Title>Revoke this approval</Dialog.Title>
            <Dialog.Description>A named reason is required; the approval stops being approvable for everyone.</Dialog.Description>
          </Dialog.Header>
          <Textarea label="Reason" value={revokeReason()} onInput={(e) => setRevokeReason(e.currentTarget.value)} />
          <Dialog.Footer class="justify-end">
            <Button variant="outline" onClick={() => setRevokeOpen(false)}>Back</Button>
            <Button theme="red" disabled={revokeReason().trim().length === 0} onClick={() => { void props.onRevoke(revokeReason().trim()); setRevokeOpen(false); }}>Revoke approval</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </ScreenRegion>
  );
}
