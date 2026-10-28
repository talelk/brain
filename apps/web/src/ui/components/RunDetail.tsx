import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, KeyValue, Textarea } from "@talelk/newui-atoms";
import { Alert, Dialog, TabButtons, Timeline } from "@talelk/newui-molecules";
import { DetailHeader, Section } from "@talelk/newui-organisms";
import type { JobSnapshot, PlacementExplanation } from "@brain/contracts";
import { DateText, ScreenRegion } from "../screen-region";
import type { ScreenState } from "../../data/screens";
import { EvidenceList } from "./EvidenceList";
import { PlacementPanel } from "./PlacementPanel";

const TABS = [
  { value: "summary", label: "Summary" },
  { value: "attempts", label: "Attempts" },
  { value: "timeline", label: "Timeline" },
  { value: "evidence", label: "Evidence" },
  { value: "placement", label: "Placement" },
];

const REASON_LABEL: Record<string, string> = {
  READY: "ready for a runner",
  WAITING_FOR_RUNNER: "waiting for a capable runner",
  BLOCKED_BY_POLICY: "blocked by policy",
  WAITING_FOR_APPROVAL: "waiting for an approval",
  INSUFFICIENT_CAPACITY: "runner capacity exhausted",
  WAITING_FOR_RESOURCE: "waiting for a resource",
  BUDGET_EXHAUSTED: "budget exhausted",
  FAIRNESS_DELAY: "fairness delay",
  RUNNER_OFFLINE: "runner offline",
};

/**
 * The one run composition, shared by the Runs list and every deep link
 * (`/jobs/:id`). It exposes cancel and the unknown-outcome reconcile path, and
 * it never offers Retry while an effect's outcome is unknown.
 */
export function RunDetail(props: {
  jobId: string;
  job?: JobSnapshot;
  explanation?: PlacementExplanation;
  state: ScreenState<JobSnapshot>;
  onRefresh: () => void;
  /** Authoritative commands only; each carries its own idempotency key. */
  onCancel: (reason: string) => Promise<void>;
  onReconcile: (reason: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}): JSX.Element {
  const [tab, setTab] = createSignal("summary");
  const [reasonOpen, setReasonOpen] = createSignal<false | "cancel" | "reconcile">(false);
  const [reason, setReason] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const job = () => props.job;
  const unknown = () => job()?.state === "outcome_unknown";

  async function confirm() {
    const kind = reasonOpen();
    if (!kind || reason().trim().length === 0) return;
    setBusy(true);
    try {
      if (kind === "cancel") await props.onCancel(reason().trim());
      else await props.onReconcile(reason().trim());
      setReason(""); setReasonOpen(false);
    } catch (e) {
      setReasonOpen(false);
      throw e;
    } finally { setBusy(false); }
  }

  return (
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Run not found" emptyDescription="It may belong to another workspace, or it was removed." emptyAction={<Button onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <DetailHeader
        title={`Run ${job()?.jobId ?? props.jobId}`}
        headingLevel={2}
        breadcrumbs={[{ label: "Runs", route: undefined }]}
        subtitle={`Run ${job()?.workflowRunId ?? "—"} · v${job()?.version ?? "?"} · config ${job()?.configDigest?.slice(0, 15) ?? "—"}`}
        status={{ label: job()?.state ?? "unknown", theme: job()?.state === "succeeded" ? "green" : job()?.state === "failed" ? "red" : "blue" }}
        actions={[
          ...(unknown() ? [{ label: "Reconcile outcome", onClick: () => { setReasonOpen("reconcile"); setReason(""); } }] : []),
          ...(!["succeeded","failed","cancelled"].includes(job()?.state ?? "") ? [{ label: "Cancel run", onClick: () => { setReasonOpen("cancel"); setReason(""); } }] : []),
        ]}
      />
      <Show when={unknown()}>
        <Alert theme="amber" variant="outline" title="Effect outcome is unknown"
          description="This run's effect may already have applied. Reconcile against the target system before retrying — Retry stays unavailable until the outcome is authoritative." />
      </Show>
      <TabButtons label="Run detail" options={TABS} value={tab()} onValueChange={setTab} />
      <Show when={tab() === "summary"}>
        <Section title="State and queue" surface="card">
          <div class="grid gap-field-gap sm:grid-cols-2">
            <KeyValue label="State" value={<Badge label={job()?.state ?? "—"} />} />
            <KeyValue label="Created" value={<DateText value={job()?.createdAt} />} />
            <KeyValue label="Queue reasons" value={(job()?.queueReasons ?? []).map((r) => REASON_LABEL[r] ?? r).join(", ") || "none"} />
            <KeyValue label="Workspace" value={job()?.workspaceId ?? "—"} />
          </div>
        </Section>
      </Show>
      <Show when={tab() === "summary" && Object.keys(job()?.runOutputs ?? {}).length}>
        <Section title="Structured output" surface="card">
          <For each={Object.entries(job()?.runOutputs ?? {})}>{([step,output]) => <div><h3>{step}</h3><pre class="whitespace-pre-wrap break-words">{JSON.stringify(output,null,2)}</pre></div>}</For>
        </Section>
      </Show>
      <Show when={tab() === "attempts"}>
        <Section title="Attempts" surface="card">
          <Show when={(job()?.attempts.length ?? 0) > 0} fallback={<p>No attempts recorded yet.</p>}>
            <Timeline items={[...(job()?.attempts ?? [])].map((a) => ({
              title: `Attempt ${a.number} on ${a.runnerId}`,
              description: `State: ${a.state}${a.leaseExpiresAt ? ` · lease until ${new Date(a.leaseExpiresAt).toLocaleString()}` : ""}`,
              tone: (a.state === "succeeded" ? "green" : a.state === "failed" ? "red" : "blue") as "green" | "red" | "blue",
              timestamp: <DateText value={a.leaseExpiresAt} />,
            }))} />
          </Show>
        </Section>
      </Show>
      <Show when={tab() === "timeline"}>
        <Section title="Authoritative events" surface="card">
          <Show when={(job()?.attempts.length ?? 0) > 0} fallback={<p>No authoritative events yet for this run.</p>}>
            <Timeline items={[...(job()?.attempts ?? [])].map((a) => ({
              title: `${a.state} — attempt ${a.number}`,
              description: `runner ${a.runnerId}`,
              tone: "gray" as const,
            }))} />
          </Show>
          <For each={job()?.engineEvents ?? []}>{(event) => <div class="border-b border-outline-gray-1 py-2"><strong>{event.kind}</strong><pre class="whitespace-pre-wrap break-words">{JSON.stringify(event.payload,null,2)}</pre></div>}</For>
          <Show when={props.onOpenSession && (job()?.attempts.length ?? 0) > 0}>
            <Button variant="outline" onClick={() => { const first = job()?.attempts[0]; if (first) props.onOpenSession?.(first.attemptId); }}>
              Open live session
            </Button>
          </Show>
        </Section>
      </Show>
      <Show when={tab() === "evidence"}>
        <Section title="Independent evidence" surface="card">
          <EvidenceList bundleDigest={job()?.evidenceDigest} workspaceId={job()?.workspaceId} />
        </Section>
      </Show>
      <Show when={tab() === "placement"}>
        <Section title="Placement explanation" surface="card">
          <PlacementPanel explanation={props.explanation} />
        </Section>
      </Show>

      <Dialog.Root open={reasonOpen() !== false} onOpenChange={(open) => { if (!open) setReasonOpen(false); }}>
        <Dialog.Content size="md">
          <Dialog.Header>
            <Dialog.Title>{reasonOpen() === "reconcile" ? "Reconcile unknown outcome" : "Cancel this run"}</Dialog.Title>
            <Dialog.Description>A named reason is recorded against the exact run and cannot be empty.</Dialog.Description>
          </Dialog.Header>
          <Textarea label="Reason" value={reason()} onInput={(e) => setReason(e.currentTarget.value)} required />
          <Dialog.Footer class="justify-end">
            <Button variant="outline" onClick={() => setReasonOpen(false)} disabled={busy()}>Back</Button>
            <Button onClick={() => void confirm()} loading={busy()} disabled={reason().trim().length === 0}>
              {reasonOpen() === "reconcile" ? "Record reconciliation request" : "Cancel run"}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </ScreenRegion>
  );
}
