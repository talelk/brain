import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import type { ContextManifest, ContextPackView } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "./Domain";
import { DigestValue } from "./DigestValue";

const LABELS: Record<ContextManifest["sections"][number]["label"], string> = {
  fact: "Fact: derived by Brain or written by the owner",
  claim: "Claim: written by a person or an agent, not verified",
  reference: "Reference: a pointer, fetched on demand",
};

function Reference(props: { workspaceId: string; reference: string }): JSX.Element {
  const [text, setText] = createSignal<string>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function open() {
    setBusy(true); setError("");
    try {
      const response = await query<{ snapshot: { text: string } }>({ queryType: "contextPacks.reference", workspaceId: props.workspaceId, resourceId: props.reference });
      setText(response.snapshot.text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The full text could not be loaded.");
    } finally { setBusy(false); }
  }
  return <span class="flex min-w-0 flex-col gap-1">
    <Show when={text() === undefined}><Button variant="outline" size="sm" loading={busy()} onClick={() => void open()}>Show the full text</Button></Show>
    <Show when={error()}><span role="alert" class="text-caption text-ink-red-7">{error()}</span></Show>
    <Show when={text() !== undefined}><pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-gray-1 p-2 text-caption text-ink-gray-8" data-reference-text>{text()}</pre></Show>
  </span>;
}

function Pack(props: { workspaceId: string; pack: ContextPackView }): JSX.Element {
  const manifest = () => props.pack.manifest;
  return <div class="flex min-w-0 flex-col gap-3" data-context-pack={props.pack.jobId}>
    <p class="text-interface text-ink-gray-8" data-context-total>
      About <span class="font-medium tabular-nums">{manifest().estimatedTokens}</span> tokens (estimated) of a {manifest().budgetTokens}-token context budget
      for <span class="font-medium">{manifest().agentId}</span>, step {props.pack.stepId}.
      <Show when={manifest().overBudget}> The facts alone exceed the budget; they are never compacted.</Show>
    </p>
    <p class="text-caption text-ink-gray-6">{manifest().estimateNote}</p>
    <table class="w-full min-w-0 border-collapse text-interface" aria-label="Context sections">
      <thead><tr class="text-left text-caption text-ink-gray-6"><th class="py-1 pr-3 font-medium">Section</th><th class="py-1 pr-3 font-medium">Items</th><th class="py-1 text-right font-medium">Tokens (est.)</th></tr></thead>
      <tbody><For each={manifest().sections}>{(section) =>
        <tr class="border-t border-outline-gray-1 align-top" data-section={section.id}>
          <td class="py-2 pr-3"><span class="block break-words font-medium text-ink-gray-9">{section.title}</span><span class="block text-caption text-ink-gray-6">{LABELS[section.label]}</span></td>
          <td class="py-2 pr-3 tabular-nums">{section.items}</td>
          <td class="py-2 text-right tabular-nums">{section.estimatedTokens}</td>
        </tr>}</For></tbody>
    </table>
    <Show when={manifest().truncations.length} fallback={<p class="text-interface text-ink-gray-7" data-no-truncation>Nothing was shortened: everything fit the budget.</p>}>
      <div class="flex flex-col gap-2">
        <h4 class="text-base-medium text-ink-gray-9">Shortened to fit the budget</h4>
        <p class="text-caption text-ink-gray-6">Shortening is mechanical: sentences are cut at their end, or the text is replaced by a pointer. No model wrote a summary. The full text is kept and can be read below.</p>
        <ul class="flex flex-col gap-2"><For each={manifest().truncations}>{(entry) =>
          <li class="flex min-w-0 flex-col gap-1.5 rounded-control border border-outline-gray-1 p-3" data-truncation={entry.itemId}>
            <span class="text-interface text-ink-gray-9">
              {entry.mode === "truncated" ? "Cut" : "Replaced by a pointer"}: {entry.itemId} in {entry.sectionId}
              {" "}({entry.originalTokens} tokens, {entry.keptTokens} kept)
            </span>
            <span class="break-all text-caption text-ink-gray-6">{entry.reference}</span>
            <Reference workspaceId={props.workspaceId} reference={entry.reference} />
          </li>}</For></ul>
      </div>
    </Show>
    <p class="break-all text-caption text-ink-gray-6">Pack digest <DigestValue value={manifest().textDigest} /></p>
  </div>;
}

/**
 * "Context this task received" (issue #81): the sections the Governor put in front
 * of an agent, their estimated sizes, what was shortened and how to read it in full.
 * Rendered from the manifest stored with the run, never recomputed.
 */
export function ContextReceived(props: { runId: string | undefined }): JSX.Element {
  const app = useApp();
  const packs = createScopedRead<{ items: ContextPackView[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: ContextPackView[] }; asOf: string; sourceWatermark: number }>({ queryType: "contextPacks.forRun", workspaceId: scope.workspaceId, resourceId: props.runId ?? "" }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (data) => data.items.length === 0,
  });
  return <WorkspaceSection title="Context this task received" description="What Brain put in front of the agent before it started, with sizes estimated before the run. Messages and handoff notes are claims; they are labelled as such.">
    <Show when={props.runId} fallback={<p class="text-interface text-ink-gray-7">This run has not started yet.</p>}>
      <ScreenRegion state={packs.state()} onRetry={() => void packs.refresh({ force: true })} emptyTitle="No context was assembled" emptyDescription="This run did not belong to a mission task, or its agent has not been given work yet, so it received only its own input.">
        <Show when={packs.state().data}>{(data) => <div class="flex flex-col gap-5"><For each={data().items}>{(pack) => <Pack workspaceId={app.scope().workspaceId} pack={pack} />}</For></div>}</Show>
      </ScreenRegion>
    </Show>
  </WorkspaceSection>;
}
