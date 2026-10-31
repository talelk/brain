import { A } from "@solidjs/router";
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button, KeyValue } from "@talelk/newui-atoms";
import { Alert, TabButtons, Timeline } from "@talelk/newui-molecules";
import { DetailHeader, Section } from "@talelk/newui-organisms";
import type { JobSnapshot, PlacementExplanation } from "@brain/contracts";
import { DateText, ScreenRegion } from "../screen-region";
import type { ScreenState } from "../../data/screens";
import { EvidenceList } from "./EvidenceList";
import { PlacementPanel } from "./PlacementPanel";
import { ArtifactContent } from "./ArtifactContent";
import { formatDateTime, queueReasonLabel } from "../format";
import { StatusBadge, statusHeaderTheme } from "./StatusBadge";
import { StructuredOutputView } from "./StructuredOutputView";
import { BrainPage, PageStack, TechnicalDetails } from "./PageLayout";
import { ReasonDialog } from "./ReasonDialog";
import { RefreshButton } from "./primitives";

const TABS = [
  { value: "summary", label: "Summary" }, { value: "attempts", label: "Attempts" },
  { value: "timeline", label: "Timeline" }, { value: "evidence", label: "Evidence" }, { value: "placement", label: "Placement" },
];

export function RunDetail(props: {
  jobId: string;
  job?: JobSnapshot;
  explanation?: PlacementExplanation;
  state: ScreenState<JobSnapshot>;
  onRefresh: () => void;
  onCancel: (reason: string) => Promise<void>;
  onReconcile: (reason: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}): JSX.Element {
  const [tab, setTab] = createSignal("summary");
  const [reasonOpen, setReasonOpen] = createSignal<false | "cancel" | "reconcile">(false);
  const [reason, setReason] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const job = () => props.job;
  const state = () => job()?.workflowState ?? job()?.state;
  const unknown = () => job()?.state === "outcome_unknown";
  async function confirm() {
    const kind = reasonOpen();
    if (!kind || !reason().trim()) return;
    setBusy(true);
    try {
      if (kind === "cancel") await props.onCancel(reason().trim());
      else await props.onReconcile(reason().trim());
      setReason(""); setReasonOpen(false);
    } finally { setBusy(false); }
  }
  return <BrainPage title="Run detail" description="Follow progress, review the result, and inspect independent evidence and placement."
    breadcrumbs={[{ label: "Activity" }, { label: "Run detail" }]}
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={unknown()}><Button size="lg" variant="solid" theme="blue" onClick={() => { setReasonOpen("reconcile"); setReason(""); }}>Reconcile outcome</Button></Show><Show when={!["succeeded", "failed", "cancelled"].includes(state() ?? "")}><Button size="lg" variant="outline" theme="red" onClick={() => { setReasonOpen("cancel"); setReason(""); }}>Cancel run</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Run not found" emptyDescription="It may belong to another workspace, or it was removed." emptyAction={<Button size="lg" onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <DetailHeader title={job()?.workflowTitle ?? "Task run"} headingLevel={2}
          subtitle={job()?.origin ? "A run connected to an originating work item." : "Authoritative execution and verification detail."}
          status={{ label: state() === "succeeded" ? job()?.workflowState ? "Completed and verified" : "Step completed" : (state() ?? "unknown").replaceAll("_", " "), theme: statusHeaderTheme("job", state() ?? "") }} />
        <Show when={unknown()}><Alert theme="amber" variant="outline" title="Effect outcome is unknown" description="The effect may already have applied. Reconcile against the target system before retrying; Retry stays unavailable." /></Show>
        <Show when={job()?.origin}>{(origin) => <A class="inline-flex w-fit items-center gap-2 rounded-control text-interface font-medium text-ink-blue-link focus-visible:focus-ring" href={origin().kind === "work-item" ? `/w/${job()?.workspaceId}/board?card=${encodeURIComponent(origin().id)}` : origin().kind === "ticket" ? `/tickets/${origin().id}` : `/incidents/${origin().id}`}><span class="lucide-arrow-left size-4" aria-hidden="true" />Back to originating work item</A>}</Show>
        <TechnicalDetails label="Technical references"><p class="break-all">Run {job()?.workflowRunId ?? props.jobId} · step {job()?.jobId} · version {job()?.version} · configuration {job()?.configDigest}</p></TechnicalDetails>
        <TabButtons label="Run detail" options={TABS} value={tab()} onValueChange={setTab} />
        <Show when={tab() === "summary"}><PageStack>
          <Section title="Progress" surface="card"><div class="grid gap-field-gap sm:grid-cols-2">
            <KeyValue label="State" value={<StatusBadge kind="job" status={state() ?? "unknown"} label={state() ?? "—"} />} />
            <KeyValue label="Created" value={<DateText value={job()?.createdAt} />} />
            <KeyValue label="Queue reasons" value={queueReasonLabel(job()?.queueReasons ?? [])} />
            <KeyValue label="Workspace" value={job()?.workspaceId ?? "—"} />
          </div></Section>
          <Show when={Object.keys(job()?.runOutputs ?? {}).length}>
            <Section title="Structured output" description="Readable values with exact JSON available on demand." surface="card"><div class="flex flex-col gap-5">
              <For each={Object.entries(job()?.runOutputs ?? {}).filter(([step]) => step !== "validate")}>{([step, output]) => <div><h3 class="mb-2 text-base-medium">{step === "respond" ? "Result" : step.replaceAll("-", " ")}</h3><StructuredOutputView value={output} /></div>}</For>
            </div></Section>
          </Show>
          <Show when={(job()?.engineEvents ?? []).some((event) => event.kind === "artifact")}>
            <Section title="Run artifacts" surface="card"><div class="flex flex-col gap-3"><For each={(job()?.engineEvents ?? []).filter((event) => event.kind === "artifact")}>{(event) => <ArtifactContent artifact={"artifact" in event.payload ? event.payload.artifact : undefined} compact />}</For></div></Section>
          </Show>
        </PageStack></Show>
        <Show when={tab() === "attempts"}><Section title="Attempts" surface="card">
          <Show when={(job()?.attempts.length ?? 0) > 0} fallback={<p class="brain-empty-inline">No attempts recorded yet.</p>}><Timeline items={[...(job()?.attempts ?? [])].map((attempt) => ({
            title: `Attempt ${attempt.number} on ${attempt.runnerId}`,
            description: `State: ${attempt.state}${attempt.leaseExpiresAt ? ` · lease until ${formatDateTime(attempt.leaseExpiresAt)}` : ""}`,
            tone: (attempt.state === "succeeded" ? "green" : attempt.state === "failed" ? "red" : "blue") as "green" | "red" | "blue",
            timestamp: <DateText value={attempt.leaseExpiresAt} />,
          }))} /></Show>
        </Section></Show>
        <Show when={tab() === "timeline"}><Section title="Authoritative events" surface="card"><PageStack>
          <Show when={(job()?.attempts.length ?? 0) > 0} fallback={<p>No authoritative events yet for this run.</p>}><Timeline items={[...(job()?.attempts ?? [])].map((attempt) => ({ title: `${attempt.state} — attempt ${attempt.number}`, description: `Runner ${attempt.runnerId}`, tone: "gray" as const }))} /></Show>
          <For each={job()?.engineEvents ?? []}>{(event) => <div class="border-b border-outline-gray-1 py-3 last:border-0"><strong>{event.kind}</strong><pre class="brain-readable mt-2 whitespace-pre-wrap break-words rounded-control bg-surface-gray-1 p-3 text-caption">{JSON.stringify(event.payload, null, 2)}</pre></div>}</For>
          <Show when={props.onOpenSession && (job()?.attempts.length ?? 0) > 0}><Button size="lg" variant="outline" iconRight="lucide-arrow-right" class="self-start" onClick={() => { const first = job()?.attempts[0]; if (first) props.onOpenSession?.(first.attemptId); }}>Open live session</Button></Show>
        </PageStack></Section></Show>
        <Show when={tab() === "evidence"}><Section title="Independent evidence" surface="card"><EvidenceList bundleDigest={job()?.evidenceDigest} workspaceId={job()?.workspaceId} /></Section></Show>
        <Show when={tab() === "placement"}><Section title="Placement explanation" surface="card"><PlacementPanel explanation={props.explanation} /></Section></Show>
      </PageStack>
      <ReasonDialog open={reasonOpen() !== false} onClose={() => setReasonOpen(false)}
        title={reasonOpen() === "reconcile" ? "Reconcile unknown outcome" : "Cancel this run"}
        description="A named reason is recorded against the exact run and cannot be empty."
        reason={reason()} onReason={setReason} cancelLabel="Back" busy={busy()}
        confirmLabel={reasonOpen() === "reconcile" ? "Record reconciliation request" : "Cancel run"}
        tone={reasonOpen() === "cancel" ? "red" : "blue"}
        onConfirm={(value) => { setReason(value); void confirm(); }} />
    </ScreenRegion>
  </BrainPage>;
}
