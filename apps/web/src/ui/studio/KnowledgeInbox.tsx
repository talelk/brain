import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import type { KnowledgeAsset } from "@brain/contracts";
import { useApp } from "../app-context";
import { missionHref } from "../mission-links";
import { DateText } from "../screen-region";
import { DigestValue } from "../components/DigestValue";

/** Knowledge Brain wrote up from a finished mission; the other assets come from repeated tool use. */
export const isMissionKnowledge = (asset: KnowledgeAsset): boolean => asset.operationId === "mission-knowledge" || asset.operationId === "saved-document";

type Review = (asset: KnowledgeAsset, decision: "approve" | "reject", reason: string) => Promise<void>;

/**
 * The Library review inbox (#71): each finished mission proposes one readable record. One
 * approval reviews and publishes it, so search and future plans can use it at once. A person
 * who produced it may approve it only while nobody else can review; the card says so (ADR 0007).
 */
export function KnowledgeInbox(props: { assets: readonly KnowledgeAsset[]; canReview: boolean; canRevoke: boolean; onReview: Review; onRevoke: (asset: KnowledgeAsset, reason: string) => Promise<void>; onApproveAll?: () => Promise<void>; setting?: JSX.Element }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [rejecting, setRejecting] = createSignal<string>();
  const [reason, setReason] = createSignal("");
  const [busy, setBusy] = createSignal<string>();
  // A link from a result-ready announcement (?asset=) brings that item into view once.
  let scrolled = false;
  createEffect(() => {
    const id = new URLSearchParams(window.location.search).get("asset");
    if (scrolled || !id || !props.assets.some((asset) => asset.assetId === id)) return;
    scrolled = true;
    queueMicrotask(() => document.getElementById(`knowledge-proposal-${id}`)?.scrollIntoView({ block: "center" }));
  });
  /** Set aside by the automatic path for a person (a secret): still waits for a person, so the card says so. */
  const setAside = (asset: KnowledgeAsset) => Boolean(asset.rejectionReason?.startsWith("Left for a person"));
  /** Old notes Brain set aside because nothing in them is readable are not shown: there is nothing to decide about them. */
  const shown = () => props.assets.filter((asset) => !asset.rejectionReason?.startsWith("Not kept:"));
  const waiting = () => props.assets.filter((asset) => asset.state === "extracted" && !asset.rejectionReason);
  const [approvingAll, setApprovingAll] = createSignal(false);
  const approveAll = async () => { setApprovingAll(true); try { await props.onApproveAll?.(); } finally { setApprovingAll(false); } };
  const run = async (asset: KnowledgeAsset, action: () => Promise<void>) => {
    setBusy(asset.assetId);
    try { await action(); setRejecting(undefined); setReason(""); } finally { setBusy(undefined); }
  };
  return <section class="min-w-0" aria-labelledby="knowledge-inbox" data-testid="knowledge-inbox">
    <div class="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 id="knowledge-inbox" class="text-base-medium text-ink-gray-9">Knowledge to review <Show when={waiting().length > 0}><Badge size="sm" theme="amber" label={`${waiting().length} to review`} /></Show></h3>
      <Show when={props.canReview && props.onApproveAll && waiting().length > 0}>
        <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-check-check" loading={approvingAll()} disabled={busy() !== undefined || approvingAll()} data-testid="approve-all-verified" onClick={() => void approveAll()}>Approve all verified ({waiting().length})</Button>
      </Show>
    </div>
    <p class="mb-2 text-interface text-ink-gray-7">When a mission finishes and its result is verified, Brain writes up what happened: the result, how each criterion was checked, and what it reused. With automatic publishing on it publishes itself, marked and undoable; otherwise approve it here and it becomes searchable and is offered to future plans. It is a record of past work, never proof for new work.</p>
    {props.setting}
    <Show when={shown().length > 0} fallback={<p class="border-y border-outline-gray-1 py-4 text-interface text-ink-gray-6">Nothing to review yet. A mission closed as achieved writes up its knowledge here.</p>}>
      <ul class="min-w-0 divide-y divide-outline-gray-1 border-y border-outline-gray-1">
        <For each={shown()}>{(asset) => <li class="min-w-0 py-3 first:pt-0 last:pb-0" id={`knowledge-proposal-${asset.assetId}`} data-testid={`knowledge-proposal-${asset.assetId}`}>
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <strong class="min-w-0 break-words text-base-medium">{asset.title ?? asset.operationId}</strong>
            <Badge size="sm" theme={asset.supersededBy ? "gray" : asset.state === "published" ? "green" : asset.state === "revoked" ? "red" : "amber"} label={asset.supersededBy ? "Replaced" : asset.state === "extracted" ? (setAside(asset) ? "Needs a person" : asset.rejectionReason ? "Not published" : "Awaiting review") : asset.state === "published" ? (asset.autoPublished ? "Published automatically" : "Published") : asset.state} />
            <Show when={asset.operationId === "saved-document"}><Badge size="sm" variant="outline" theme="blue" label="Saved document" /></Show>
            <Show when={asset.selfReviewed}><Badge size="sm" variant="outline" theme="amber" label="Self-reviewed" /></Show>
          </div>
          <Show when={asset.rejectionReason}><p class="mt-1 text-caption text-ink-gray-7">{asset.supersededBy || setAside(asset) ? "" : "Left out: "}{asset.rejectionReason}</p></Show>
          <details class="mt-2 min-w-0" open={asset.state === "extracted" && !asset.rejectionReason}>
            <summary class="cursor-pointer text-caption font-medium text-ink-gray-7">Read the record</summary>
            <div class="brain-prose mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-control border border-outline-gray-1 bg-surface-gray-1 p-3 text-interface text-ink-gray-8" data-testid="knowledge-proposal-text">{asset.content}</div>
          </details>
          <p class="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-gray-6">
            <Show when={asset.missionId}><a class="text-ink-blue-link hover:underline" href={missionHref(app.workspaceId(), asset.missionId!, "outputs")} onClick={(event) => { event.preventDefault(); void navigate(missionHref(app.workspaceId(), asset.missionId!, "outputs")); }}>From this mission</a></Show>
            <span>{asset.provenance.length} evidence {asset.provenance.length === 1 ? "reference" : "references"}</span>
            <span>Proposed <DateText value={asset.createdAt} /></span>
            <Show when={asset.reviewedBy && !asset.autoPublished}><span>Approved by {asset.reviewedBy === app.identity()?.actor.actorId ? "you" : "another reviewer"}</span></Show>
          </p>
          <Show when={asset.provenance.length}><details class="mt-1 min-w-0"><summary class="cursor-pointer text-caption font-medium text-ink-gray-6">Provenance</summary>
            <ul class="mt-1 flex min-w-0 flex-col gap-1"><For each={asset.provenance}>{(reference) => <li class="min-w-0"><DigestValue value={reference.evidenceDigest} label="Evidence fingerprint" /></li>}</For></ul></details></Show>
          <Show when={props.canReview && asset.state === "extracted"}>
            <div class="mt-3 flex min-w-0 flex-col gap-2 border-t border-outline-gray-1 pt-3">
              <div class="flex flex-wrap gap-2">
                <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-check" loading={busy() === asset.assetId} disabled={busy() !== undefined} onClick={() => void run(asset, () => props.onReview(asset, "approve", "Reviewed the record and its provenance"))}>Approve and publish</Button>
                <Button size="sm" variant="outline" disabled={busy() !== undefined} onClick={() => { setRejecting(rejecting() === asset.assetId ? undefined : asset.assetId); setReason(""); }}>Not now</Button>
              </div>
              <Show when={rejecting() === asset.assetId}>
                <form class="flex min-w-0 flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (reason().trim()) void run(asset, () => props.onReview(asset, "reject", reason().trim())); }}>
                  <div class="min-w-0 flex-1"><TextInput label="Why leave it out?" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} placeholder="Too thin, wrong scope, or already covered" /></div>
                  <Button size="sm" type="submit" variant="outline" disabled={!reason().trim() || busy() !== undefined}>Keep it out of search</Button>
                </form>
              </Show>
            </div>
          </Show>
          <Show when={props.canRevoke && asset.state === "published"}>
            <div class="mt-3 border-t border-outline-gray-1 pt-3"><Button size="sm" variant="outline" theme="red" iconLeft="lucide-undo-2" disabled={busy() !== undefined} onClick={() => void run(asset, () => props.onRevoke(asset, "Withdrawn from search and reuse"))}>Withdraw from search</Button></div>
          </Show>
        </li>}</For>
      </ul>
    </Show>
  </section>;
}
