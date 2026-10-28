import { PaneLayout } from "@talelk/newui-templates";
import type { JSX } from "solid-js";
import { Show, createEffect, createSignal } from "solid-js";
import { Badge, Button, KeyValue, Textarea } from "@talelk/newui-atoms";
import { Alert, Dialog, Timeline } from "@talelk/newui-molecules";
import { DataTable, DetailHeader, Section } from "@talelk/newui-organisms";
import type { ApprovalRequest } from "@brain/contracts";
import { ScreenRegion, DateText, isFreshFromServer } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { ApprovalReview } from "../ui/components/ApprovalReview";
import type { ApprovalIntent, ApprovalOutcome } from "../ui/approval-controller";

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
  const rows = () => props.approvals.map((approval) => ({
    id: approval.approvalId,
    target: typeof approval.subject === "object" && approval.subject !== null && "target" in approval.subject
      ? String((approval.subject as { target: { targetId?: string; environmentId?: string } }).target?.targetId ?? "") +
        String((approval.subject as { target: { environmentId?: string } }).target?.environmentId ?? "")
      : "record",
    action: String((approval.subject as { operation?: string } | undefined)?.operation ?? "effect"),
    state: approval.state,
    expires: new Date(approval.subject.expiresAt).toLocaleString(),
    version: String(approval.version),
  }));

  const [selected,setSelected] = createSignal<string | undefined>();
  createEffect(() => { if (selected() === undefined && props.approvals.length) setSelected(props.approvals[0]!.approvalId); });
  const current = () => props.approvals.find((approval) => approval.approvalId === selected());
  return <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No approvals awaiting review" emptyDescription="Nothing is waiting on your decision." onRetry={props.onRefresh}>
    <PaneLayout active={current() ? "end" : "start"} start={<Section title="Approvals awaiting review" surface="card">
      <DataTable title="Approvals" selectable hideSearch rows={rows()} columns={[
        {id:"action",header:"Action",accessorKey:"action"},{id:"target",header:"Target",accessorKey:"target"},{id:"state",header:"State",accessorKey:"state"},
      ]} actionLabel="Inspect" onRowsAction={(ids) => setSelected(ids[0] ?? "")} />
    </Section>} end={<Show when={current()} keyed fallback={<p>Select an approval to inspect its exact effect.</p>}>{(approval) => <Section title="Exact approval review" surface="card">
      <Button variant="ghost" onClick={() => setSelected("")}>Back to approvals</Button>
      <KeyValue label="Approval" value={approval.approvalId} />
      <Badge label={approval.state} /><pre class="whitespace-pre-wrap break-words">{JSON.stringify(approval.subject,null,2)}</pre>
      <ApprovalReview active={props.active} requireTwoFactor={props.requireTwoFactor} approvalId={approval.approvalId}
        targetLabel={String(approval.subject.operation)} exactContent={JSON.stringify(approval.subject,null,2)} subjectDigest={approval.subjectDigest} version={approval.version}
        fresh={!props.state.error && approval.state === "pending" && isFreshFromServer(approval.subject.expiresAt,props.state.asOf ?? props.asOf)}
        createIdempotencyKey={() => `web-${crypto.randomUUID()}`} verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
      <Button variant="outline" onClick={() => props.onOpen(approval.approvalId)}>Open approval history</Button>
    </Section>}</Show>} />
  </ScreenRegion>;
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
            <KeyValue label="Subject digest" value={<code class="break-all">{approval()?.subjectDigest}</code>} orientation="vertical" />
            <KeyValue label="Version" value={String(approval()?.version ?? "—")} />
            <KeyValue label="Expires" value={<DateText value={approval()?.subject.expiresAt} asOf={props.asOf} />} />
            <KeyValue label="Requester" value={approval()?.requestedBy ?? "—"} />
            <KeyValue label="Required evidence" value={props.requireTwoFactor ? "A six-digit authenticator code plus the exact subject digest." : "One-use evidence bound to this session and the exact subject digest."} />
          </div>
          <Show when={!fresh()}><Alert theme="red" variant="outline" title="This proposal is no longer valid" description="Expired approvals cannot be approved. Review the current proposal or ask for a new one." /></Show>
          <details class="rounded-card border border-outline-gray-2 p-card-pad">
            <summary class="cursor-pointer text-base-medium">Exact proposed content</summary>
            <pre class="whitespace-pre-wrap break-words pt-field text-caption">{exact()}</pre>
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
