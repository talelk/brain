import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
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

  return (
    <Section title="Approvals awaiting review" description="Each review shows the exact action, target, content, expiry and required evidence before anything can be approved." surface="card">
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No approvals awaiting review"
        emptyDescription="Nothing is waiting on your decision right now."
        emptyAction={<Button onClick={props.onRefresh}>Check again</Button>} onRetry={props.onRefresh}>
        <DataTable title="Approvals" selectable hideSearch rows={rows()} columns={[
          { id: "action", header: "Action", accessorKey: "action" },
          { id: "target", header: "Target", accessorKey: "target" },
          { id: "state", header: "State", accessorKey: "state" },
          { id: "version", header: "Version", accessorKey: "version" },
          { id: "expires", header: "Expires", accessorKey: "expires" },
        ]} caption={`${props.approvals.length} pending`} actionLabel="Open" onRowsAction={(ids) => props.onOpen(ids[0] ?? "")} />

        <div class="flex flex-col gap-field-gap pt-field">
          <For each={props.approvals}>{(approval) => (
            <article class="flex flex-col gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
              <div class="flex flex-wrap items-center gap-control-gap">
                <Badge theme={approval.state === "pending" ? "amber" : approval.state === "approved" ? "green" : "gray"} label={approval.state} />
                <code class="text-caption">{approval.approvalId}</code>
                <span class="text-caption text-ink-gray-7">v{approval.version} · expires <DateText value={approval.subject.expiresAt} asOf={props.asOf} /></span>
              </div>
              <ApprovalReview active={props.active} approvalId={approval.approvalId}
                targetLabel={`${String((approval.subject as { operation?: string } | undefined)?.operation ?? "effect")} on ${String((approval.subject as { target?: { targetId?: string } } | undefined)?.target?.targetId ?? "record")}`}
                exactContent={JSON.stringify(approval.subject, null, 2)} subjectDigest={approval.subjectDigest} version={approval.version}
                /* Freshness is decided against the server clock, never the browser's. */
                fresh={!props.state.error && approval.state === "pending" && isFreshFromServer(approval.subject.expiresAt, props.state.asOf ?? props.asOf)}
                createIdempotencyKey={() => `web-${crypto.randomUUID()}`}
                verifyIdentity={props.verifyIdentity} submitDecision={props.submitDecision} checkDecision={props.checkDecision} />
            </article>
          )}</For>
        </div>
      </ScreenRegion>
    </Section>
  );
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
            <KeyValue label="Required evidence" value="A six-digit authenticator code plus the exact subject digest." />
          </div>
          <Show when={!fresh()}><Alert theme="red" variant="outline" title="This proposal is no longer valid" description="Expired approvals cannot be approved. Review the current proposal or ask for a new one." /></Show>
          <details class="rounded-card border border-outline-gray-2 p-card-pad">
            <summary class="cursor-pointer text-base-medium">Exact proposed content</summary>
            <pre class="whitespace-pre-wrap break-words pt-field text-caption">{exact()}</pre>
          </details>
          <ApprovalReview active approvalId={approval()?.approvalId ?? ""} targetLabel={`${subject().operation ?? "effect"} on ${subject().target?.targetId ?? "record"}`}
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
