import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { CapabilityCandidate, CapitalizationRun, KnowledgeAsset } from "@brain/contracts";
import { Badge, Button } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import { DateText } from "../screen-region";

export interface CapitalizationSnapshot {
  assets: KnowledgeAsset[];
  candidates: CapabilityCandidate[];
  runs: CapitalizationRun[];
}

export function CapitalizationStudio(props: {
  snapshot: CapitalizationSnapshot;
  canRun: boolean;
  canReview: boolean;
  onRun: () => Promise<void>;
  onReview: (candidate: CapabilityCandidate, decision: "approve" | "reject") => Promise<void>;
  onPublish: (candidate: CapabilityCandidate) => Promise<void>;
}): JSX.Element {
  const latestRun = () => props.snapshot.runs[0];
  return <Section title="Knowledge Studio" description="Capitalize verified operations without granting memory or execution authority." surface="card"
    actions={<Button size="lg" variant="outline" iconLeft="lucide-sparkles" disabled={!props.canRun} onClick={() => void props.onRun()}>Run capitalization</Button>}>
    <div class="flex flex-col gap-5">
      <Alert theme="blue" variant="outline" title="L0–L3 promotion boundary" description="L0 captures verified evidence, L1 extracts scoped knowledge and L2 prepares tested candidates. L3 always requires independent review and an exact active configuration release." />
      <Show when={latestRun()}>{(run) => <div class="flex flex-wrap items-center gap-2 text-interface text-ink-gray-7" data-testid="capitalization-latest-run">
        <Badge theme={run().state === "succeeded" ? "green" : run().state === "failed" ? "red" : "amber"} label={run().state} />
        <span>{run().observedCount} observations · {run().extractedCount} extracted · {run().candidateCount} candidates · <DateText value={run().createdAt} /></span>
      </div>}</Show>
      <div>
        <h3 class="mb-3 text-heading-sm text-ink-gray-9">L1 extracted knowledge</h3>
        <Show when={props.snapshot.assets.length > 0} fallback={<p class="text-interface text-ink-gray-6">Verified operations will appear here after capitalization.</p>}>
          <ul class="flex flex-col gap-3"><For each={props.snapshot.assets}>{(asset) => <li class="rounded-card border border-outline-gray-1 p-4" data-testid={`knowledge-asset-${asset.operationId}`}>
            <div class="flex flex-wrap items-center gap-2"><strong>{asset.operationId}</strong><Badge theme={asset.state === "published" ? "green" : asset.state === "revoked" ? "red" : "amber"} label={asset.state} /><Badge variant="outline" theme="blue" label={asset.classification} /></div>
            <p class="mt-2 whitespace-pre-wrap break-words text-interface text-ink-gray-7">{asset.content}</p>
            <p class="mt-2 text-caption text-ink-gray-6">{asset.sourceCount} distinct runs · {asset.provenance.length} evidence references · updated <DateText value={asset.updatedAt} /></p>
          </li>}</For></ul>
        </Show>
      </div>
      <div>
        <h3 class="mb-3 text-heading-sm text-ink-gray-9">L2 capability candidates</h3>
        <Show when={props.snapshot.candidates.length > 0} fallback={<p class="text-interface text-ink-gray-6">Three distinct verified operations are required before a candidate is prepared.</p>}>
          <ul class="flex flex-col gap-3"><For each={props.snapshot.candidates}>{(candidate) => <li class="rounded-card border border-outline-gray-1 p-4" data-testid={`capability-candidate-${candidate.operationId}`}>
            <div class="flex flex-wrap items-center gap-2"><strong>{candidate.operationId}</strong><Badge theme={candidate.state === "published" ? "green" : candidate.state === "rejected" ? "red" : "amber"} label={candidate.state} /><Badge variant="outline" theme={candidate.testStatus === "passed" ? "green" : "red"} label={`tests ${candidate.testStatus}`} /><Badge variant="outline" theme="gray" label={candidate.effectClass} /></div>
            <p class="mt-2 text-interface text-ink-gray-7">{candidate.sourceCount} verified source runs · {candidate.evidenceDigests.length} test fixtures · {candidate.existingAlternatives.length} existing alternatives</p>
            <p class="mt-1 break-all text-caption text-ink-gray-6">Release {candidate.release.id} · {candidate.release.digest}</p>
            <Show when={props.canReview && candidate.state === "quarantined"}><div class="mt-3 flex flex-wrap gap-2">
              <Button size="lg" theme="blue" onClick={() => void props.onReview(candidate, "approve")}>Approve {candidate.operationId}</Button>
              <Button size="lg" variant="outline" theme="red" onClick={() => void props.onReview(candidate, "reject")}>Reject {candidate.operationId}</Button>
            </div></Show>
            <Show when={props.canReview && candidate.state === "reviewed"}><div class="mt-3"><Button size="lg" variant="outline" iconLeft="lucide-upload" onClick={() => void props.onPublish(candidate)}>Publish exact release {candidate.operationId}</Button></div></Show>
          </li>}</For></ul>
        </Show>
      </div>
    </div>
  </Section>;
}
