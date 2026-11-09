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
  return <Section title="Knowledge Studio" description="Capitalize verified operations without granting memory or execution authority." surface="card" density="compact" class="p-3 sm:p-4"
    actions={<Button size="sm" variant="outline" iconLeft="lucide-sparkles" disabled={!props.canRun} onClick={() => void props.onRun()}>Run capitalization</Button>}>
    <div class="flex min-w-0 flex-col gap-4">
      <Alert theme="blue" variant="outline" title="L0–L3 promotion boundary" description="L0 captures verified evidence, L1 extracts scoped knowledge and L2 prepares tested candidates. L3 always requires independent review and an exact active configuration release." />
      <Show when={latestRun()}>{(run) => <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-gray-7" data-testid="capitalization-latest-run">
        <Badge size="sm" theme={run().state === "succeeded" ? "green" : run().state === "failed" ? "red" : "amber"} label={run().state} />
        <span class="min-w-0 break-words">{run().observedCount} observations · {run().extractedCount} extracted · {run().candidateCount} candidates · <DateText value={run().createdAt} /></span>
      </div>}</Show>
      <section class="min-w-0" aria-labelledby="capitalization-assets">
        <h3 id="capitalization-assets" class="mb-2 text-base-medium text-ink-gray-9">L1 extracted knowledge</h3>
        <Show when={props.snapshot.assets.length > 0} fallback={<p class="border-y border-outline-gray-1 py-4 text-interface text-ink-gray-6">Verified operations will appear here after capitalization.</p>}>
          <ul class="min-w-0 divide-y divide-outline-gray-1 border-y border-outline-gray-1"><For each={props.snapshot.assets}>{(asset) => <li class="min-w-0 py-3 first:pt-0 last:pb-0" data-testid={`knowledge-asset-${asset.operationId}`}>
            <div class="flex min-w-0 flex-wrap items-center gap-1.5"><strong class="min-w-0 break-words text-base-medium">{asset.operationId}</strong><Badge size="sm" theme={asset.state === "published" ? "green" : asset.state === "revoked" ? "red" : "amber"} label={asset.state} /><Badge size="sm" variant="outline" theme="blue" label={asset.classification} /></div>
            <p class="brain-prose mt-2 whitespace-pre-wrap break-words text-interface text-ink-gray-7">{asset.content}</p>
            <p class="mt-2 text-caption text-ink-gray-6">{asset.sourceCount} distinct runs · {asset.provenance.length} evidence references · updated <DateText value={asset.updatedAt} /></p>
            <Show when={asset.provenance.length}><details class="mt-2 min-w-0"><summary class="cursor-pointer text-caption font-medium text-ink-gray-6">Provenance references</summary><ul class="mt-1 flex min-w-0 flex-col gap-1"><For each={asset.provenance}>{(reference) => <li class="min-w-0"><code class="break-all text-caption text-ink-gray-7">{reference.rootRunId}</code><br /><code class="break-all text-caption text-ink-gray-6">{reference.evidenceDigest}</code></li>}</For></ul></details></Show>
          </li>}</For></ul>
        </Show>
      </section>
      <section class="min-w-0" aria-labelledby="capitalization-candidates">
        <h3 id="capitalization-candidates" class="mb-2 text-base-medium text-ink-gray-9">L2 capability candidates</h3>
        <Show when={props.snapshot.candidates.length > 0} fallback={<p class="border-y border-outline-gray-1 py-4 text-interface text-ink-gray-6">Three distinct verified operations are required before a candidate is prepared.</p>}>
          <ul class="min-w-0 divide-y divide-outline-gray-1 border-y border-outline-gray-1"><For each={props.snapshot.candidates}>{(candidate) => <li class="min-w-0 py-3 first:pt-0 last:pb-0" data-testid={`capability-candidate-${candidate.operationId}`}>
            <div class="flex min-w-0 flex-wrap items-center gap-1.5"><strong class="min-w-0 break-words text-base-medium">{candidate.operationId}</strong><Badge size="sm" theme={candidate.state === "published" ? "green" : candidate.state === "rejected" ? "red" : "amber"} label={candidate.state} /><Badge size="sm" variant="outline" theme={candidate.testStatus === "passed" ? "green" : "red"} label={`tests ${candidate.testStatus}`} /><Badge size="sm" variant="outline" theme="gray" label={candidate.effectClass} /></div>
            <p class="mt-2 text-caption text-ink-gray-7">{candidate.sourceCount} verified source runs · {candidate.evidenceDigests.length} test fixtures · {candidate.existingAlternatives.length} existing alternatives</p>
            <dl class="mt-2 grid min-w-0 gap-1 text-caption sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-2">
              <dt class="text-ink-gray-6">Release</dt><dd class="min-w-0"><code class="break-all text-ink-gray-7">{candidate.release.id}</code></dd>
              <dt class="text-ink-gray-6">Digest</dt><dd class="min-w-0"><code class="break-all text-ink-gray-7">{candidate.release.digest}</code></dd>
            </dl>
            <Show when={props.canReview && candidate.state === "quarantined"}><div class="mt-3 flex flex-wrap gap-2 border-t border-outline-gray-1 pt-3">
              <Button size="sm" class="max-w-full" variant="solid" theme="blue" onClick={() => void props.onReview(candidate, "approve")}>Approve {candidate.operationId}</Button>
              <Button size="sm" class="max-w-full" variant="outline" theme="red" onClick={() => void props.onReview(candidate, "reject")}>Reject {candidate.operationId}</Button>
            </div></Show>
            <Show when={props.canReview && candidate.state === "reviewed"}><div class="mt-3 border-t border-outline-gray-1 pt-3"><Button size="sm" class="max-w-full" variant="outline" iconLeft="lucide-upload" onClick={() => void props.onPublish(candidate)}>Publish exact release {candidate.operationId}</Button></div></Show>
          </li>}</For></ul>
        </Show>
      </section>
    </div>
  </Section>;
}
