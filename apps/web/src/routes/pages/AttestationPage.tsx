import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { Badge, Button, Textarea } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import type { CheckResult, EvaluationAttestation } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { ActionFeedback } from "../../ui/components/ActionFeedback";
import { EvidenceList } from "../../ui/components/EvidenceList";
import { ATTENTION_CHANGED } from "../../ui/attention";
import { formatDateTime } from "../../ui/format";
import { missionHref } from "../../ui/mission-links";

type Status = CheckResult["status"];
type Outcome = "verified" | "rejected" | "incomplete";
const STATUSES: ReadonlyArray<{ value: Status; label: string }> = [
  { value: "passed", label: "Passed" }, { value: "failed", label: "Failed" }, { value: "missing", label: "Missing" }, { value: "inconclusive", label: "Cannot tell" },
];

/** The outcome the checks add up to, by the verdict's own rules: all passed is verified, any failure rejects, anything missing or unclear is incomplete. */
function outcomeOf(statuses: readonly Status[]): Outcome {
  if (statuses.every((status) => status === "passed")) return "verified";
  return statuses.includes("failed") ? "rejected" : "incomplete";
}
const OUTCOME_WORDS: Record<Outcome, { action: string; sentence: string; theme: "green" | "red" | "amber" }> = {
  verified: { action: "Record: verified", sentence: "Every check passed: this evidence will be recorded as verified and the work can go on.", theme: "green" },
  rejected: { action: "Record: rejected", sentence: "At least one check failed: the evidence will be rejected and the work sent back.", theme: "red" },
  incomplete: { action: "Record: incomplete", sentence: "Something is missing or unclear: the evidence will be recorded as incomplete and the work sent back for a new attempt.", theme: "amber" },
};

/**
 * Attest evidence (#157, ADR 0064): an evaluation that requires a person as its independent evaluator (independence level 3). The person
 * reviews the exact evidence that was submitted, answers each pinned check, and records the verdict as the evaluator. Nobody who started
 * or owns the work can; the page says so instead of offering a form that would be refused.
 */
export default function AttestationPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const request = createScopedRead<EvaluationAttestation>({
    scope: app.scope,
    resource: () => params.id,
    load: async (scope, signal, resource) => {
      const response = await query<{ snapshot: EvaluationAttestation; asOf: string; sourceWatermark: number }>({ queryType: "attestations.get", workspaceId: scope.workspaceId, resourceId: resource }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const [answers, setAnswers] = createSignal<Record<string, Status>>({});
  const [notes, setNotes] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const data = () => request.state().data;
  const answered = () => data()?.requiredChecks.every((check) => answers()[check.checkId]) ?? false;
  const outcome = (): Outcome | undefined => answered() ? outcomeOf(data()!.requiredChecks.map((check) => answers()[check.checkId]!)) : undefined;

  async function record(): Promise<void> {
    const current = data();
    const verdict = outcome();
    if (!current || !verdict || busy()) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await app.run("evaluation.attest", {
        attestationId: current.attestationId, bundleDigests: [...current.bundleDigests], outcome: verdict,
        checks: current.requiredChecks.map((check) => ({ checkId: check.checkId, status: answers()[check.checkId]!, detail: (notes()[check.checkId] ?? "").trim() || OUTCOME_DETAIL[answers()[check.checkId]!] })),
      });
      if (!receipt.accepted) throw new Error(receipt.detail);
      await request.refresh({ force: true });
      window.dispatchEvent(new Event(ATTENTION_CHANGED));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The verdict was not recorded.");
    } finally {
      setBusy(false);
    }
  }

  return <BrainPage title={data() ? `Attest the evidence for ${data()!.title}` : "Attest evidence"} description="An independent person judges the evidence this work submitted. Your verdict is recorded as the evaluator's, at independence level 3.">
    <PageStack>
      <ScreenRegion state={request.state()} onRetry={() => void request.refresh({ force: true })} emptyTitle="Request not found" emptyDescription="No evaluation with this id is waiting in this workspace, or you cannot read it.">
        <Show when={data()}>{(loaded) => <>
          <div class="flex flex-wrap items-center gap-2" data-testid="attestation-facts" data-state={loaded().state}>
            <Badge variant="outline" theme="blue" label="Independence level 3: a person" />
            <Badge variant="outline" theme={loaded().state === "open" ? "amber" : "green"} label={loaded().state === "open" ? "Waiting for a reviewer" : loaded().state === "attested" ? "Verdict recorded" : "Closed"} />
            <span class="text-caption text-ink-gray-6">Requested {formatDateTime(loaded().requestedAt)}</span>
            <Show when={loaded().missionId}><Button size="sm" variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(missionHref(app.workspaceId(), loaded().missionId!, "live"))}>Open the mission</Button></Show>
          </div>

          <Show when={loaded().verdict}>{(verdict) => <Alert theme={verdict().outcome === "verified" ? "green" : verdict().outcome === "rejected" ? "red" : "amber"} variant="outline" title={`Evaluated by ${verdict().attestedBy}: ${verdict().outcome}`}
            description={`Recorded ${formatDateTime(verdict().attestedAt)} as the independent evaluator at level ${verdict().independence.slice(1)}. A person made this call, not a tool or a model.`} />}</Show>
          <Show when={!loaded().verdict && !loaded().canAttest}><Alert theme="amber" variant="outline" title="You cannot attest this one" description={loaded().cannotAttestReason ?? "You may not record this verdict."} /></Show>

          <WorkspaceSection title="The evidence" description="Exactly what was submitted. Your verdict is bound to these digests; if the evidence changes you review it again.">
            <div class="flex min-w-0 flex-col gap-4">
              <For each={loaded().bundleDigests}>{(digest) => <EvidenceList bundleDigest={digest} workspaceId={loaded().workspaceId} />}</For>
            </div>
          </WorkspaceSection>

          <Show when={!loaded().verdict && loaded().canAttest}>
            <WorkspaceSection title="Your verdict" description="Answer every check yourself. Do not rely on what the author claimed.">
              <div class="flex min-w-0 flex-col gap-4" data-testid="attestation-form">
                <For each={loaded().requiredChecks}>{(check) => <fieldset class="m-0 flex min-w-0 flex-col gap-2 rounded-card border border-outline-gray-2 p-3" data-testid={`attest-check-${check.checkId}`}>
                  <legend class="px-1 text-base-medium text-ink-gray-9">{check.criterionId}</legend>
                  <Show when={check.claimed}>{(claim) => <p class="m-0 text-caption text-ink-gray-6">The author claims: {claim().status}. {claim().detail}</p>}</Show>
                  <div class="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup" aria-label={`Result for ${check.criterionId}`}>
                    <For each={STATUSES}>{(status) => <label class="inline-flex cursor-pointer items-center gap-1.5 text-interface text-ink-gray-9">
                      <input type="radio" name={`result-${check.checkId}`} value={status.value} checked={answers()[check.checkId] === status.value}
                        onChange={() => setAnswers({ ...answers(), [check.checkId]: status.value })} />{status.label}
                    </label>}</For>
                  </div>
                  <Textarea label="What you saw (optional)" value={notes()[check.checkId] ?? ""} rows={2} onInput={(event) => setNotes({ ...notes(), [check.checkId]: event.currentTarget.value })} />
                </fieldset>}</For>
                <Show when={outcome()}>{(verdict) => <p class="m-0 text-interface text-ink-gray-7" data-testid="attest-outcome" data-outcome={verdict()}>{OUTCOME_WORDS[verdict()].sentence}</p>}</Show>
                <div class="flex flex-wrap items-center gap-2">
                  <Button variant="solid" theme={outcome() ? OUTCOME_WORDS[outcome()!].theme === "green" ? "blue" : "red" : "blue"} iconLeft="lucide-clipboard-check" disabled={!outcome() || busy()} loading={busy()} onClick={() => void record()}>
                    {outcome() ? OUTCOME_WORDS[outcome()!].action : "Answer every check first"}
                  </Button>
                </div>
                <ActionFeedback tone="error" message={error()} title="Verdict not recorded" />
              </div>
            </WorkspaceSection>
          </Show>
        </>}</Show>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}

/** What the record says when the person gave no note: their answer, in words. */
const OUTCOME_DETAIL: Record<Status, string> = {
  passed: "The evaluator reviewed the evidence and judged this check passed.",
  failed: "The evaluator reviewed the evidence and judged this check failed.",
  missing: "The evaluator found the evidence for this check missing.",
  inconclusive: "The evaluator could not tell from the evidence.",
};
