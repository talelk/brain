import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import type { KnowledgeAsset, ReuseItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { WorkspaceSection } from "./Domain";
import { reusedByMission, reuseItemHref } from "../../data/reuse";
import { formatRelative } from "../format";

const KIND_LABEL: Record<ReuseItem["kind"], string> = { mission: "Past mission", output: "Verified result", knowledge: "Approved knowledge", play: "Play", handoff: "Findings" };

const usedText = (count: number): string => (count === 0 ? "not used yet" : count === 1 ? "used once" : `used ${count} times`);

/** The freshness every reused item shows: when it was last verified and how often Brain has used it. */
export function freshness(item: Pick<ReuseItem, "lastVerifiedAt" | "usedCount">): string {
  return `last verified ${formatRelative(item.lastVerifiedAt)}, ${usedText(item.usedCount)}`;
}

function ItemLink(props: { item: Pick<ReuseItem, "itemRef" | "kind" | "provenance" | "title"> }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const href = () => reuseItemHref(app.workspaceId(), props.item);
  return <Show when={href()} fallback={<span class="font-medium">{props.item.title}</span>}>
    {(target) => <a class="font-medium text-ink-blue-link hover:underline focus-visible:focus-ring" href={target()} onClick={(event) => { event.preventDefault(); void navigate(target()); }}>{props.item.title}</a>}
  </Show>;
}

/**
 * "Used from past work: N items (change)": the calm line under the plan header. Brain already
 * attached what cleared the relevance cutoff (at most three) when it drafted, so nothing waits on
 * the person. Opening it lists each item with a tick; only after something is changed does
 * "Redraft with my changes" appear. Items are hints with provenance, never evidence.
 */
export function PastWorkUsed(props: { missionId: string; workspaceId: string; /** Picks that are being sent with the first draft, shown until the attach records exist. */ pending: readonly ReuseItem[]; busy: boolean; canEdit: boolean; refreshKey: number; onRedraft: (kept: string[], dropped: string[]) => void }): JSX.Element {
  const app = useApp();
  const attached = createScopedRead<ReuseItem[]>({
    scope: app.scope, refreshMs: 15_000,
    resource: () => `${props.missionId}:${props.refreshKey}`,
    load: async (_scope, signal) => reusedByMission(props.workspaceId, props.missionId, signal),
  });
  const items = (): readonly ReuseItem[] => ((attached.state().data ?? []).length > 0 ? attached.state().data! : props.pending.map((item) => ({ ...item, decision: "kept" as const })));
  const serverOff = () => items().filter((item) => item.decision === "dropped").map((item) => item.itemRef);
  const [off, setOff] = createSignal<ReadonlySet<string>>(new Set());
  createEffect(() => setOff(new Set(serverOff())));
  const toggle = (ref: string, on: boolean) => setOff((current) => { const next = new Set(current); if (on) next.delete(ref); else next.add(ref); return next; });
  const changed = () => { const was = new Set(serverOff()); return off().size !== was.size || [...off()].some((ref) => !was.has(ref)); };
  const kept = () => items().filter((item) => !off().has(item.itemRef));
  return <Show when={items().length > 0}>
    <details class="group min-w-0 rounded-control border border-outline-gray-1 bg-surface-gray-1 px-3 py-2 text-interface text-ink-gray-8" data-testid="past-work-used">
      <summary class="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 focus-visible:focus-ring">
        <span class="lucide-recycle size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
        <span class="min-w-0 font-medium" data-testid="past-work-count">Used from past work: {kept().length} {kept().length === 1 ? "item" : "items"}</span>
        <span class="text-ink-blue-link underline-offset-2 group-hover:underline">(change)</span>
      </summary>
      <div class="mt-2 flex min-w-0 flex-col gap-2">
        <p class="text-caption text-ink-gray-7">The planner saw these as hints from earlier verified work. They never count as proof for this mission. Untick anything that does not apply.</p>
        <ul class="flex min-w-0 flex-col divide-y divide-outline-gray-1">
          <For each={items()}>{(item) => <li class="flex min-w-0 items-start gap-3 py-2 first:pt-0 last:pb-0" data-testid="reuse-suggestion">
            <input type="checkbox" class="mt-1 size-4 shrink-0" checked={!off().has(item.itemRef)} disabled={!props.canEdit || props.busy} onChange={(event) => toggle(item.itemRef, event.currentTarget.checked)} aria-label={`Use ${item.title}`} />
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <p class="flex min-w-0 flex-wrap items-center gap-1.5"><ItemLink item={item} /><Badge size="sm" variant="outline" theme="gray" label={KIND_LABEL[item.kind]} /><Show when={item.selfReviewed}><Badge size="sm" variant="outline" theme="amber" label="Self-reviewed" /></Show></p>
              <p class="text-caption text-ink-gray-6">{freshness(item)}</p>
            </div>
          </li>}</For>
        </ul>
        <Show when={changed() && props.canEdit}><div><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-sparkles" loading={props.busy} disabled={props.busy} onClick={() => props.onRedraft(kept().map((item) => item.itemRef), [...off()])}>Redraft with my changes</Button></div></Show>
      </div>
    </details>
  </Show>;
}

/**
 * "Reused: ..." (#70): what Brain attached to this mission, read from the stored attach
 * records and never from model text. Dropping an item is one click and an audited command.
 */
export function ReusedLine(props: { missionId: string; workspaceId: string; canEdit?: boolean }): JSX.Element {
  const app = useApp();
  const [message, setMessage] = createSignal("");
  const reused = createScopedRead<ReuseItem[]>({
    scope: app.scope, refreshMs: 15_000,
    resource: () => props.missionId,
    load: async (_scope, signal) => reusedByMission(props.workspaceId, props.missionId, signal),
  });
  const kept = () => (reused.state().data ?? []).filter((item) => item.decision !== "dropped");
  async function drop(item: ReuseItem): Promise<void> {
    try {
      const receipt = await app.run("mission.reuse.decide", { missionId: props.missionId, itemRef: item.itemRef, decision: "drop" });
      setMessage(receipt.accepted ? `${item.title} will not be offered to this mission again.` : receipt.detail ?? "That was not saved.");
      await reused.refresh({ force: true });
    } catch (error) { setMessage(error instanceof Error ? error.message : "That was not saved."); }
  }
  return <Show when={reused.state().status === "ready" || reused.state().status === "empty-authorized"}>
    <div class="flex min-w-0 flex-col gap-1 text-caption text-ink-gray-7" data-testid="reused-line">
      <Show when={kept().length > 0} fallback={<p data-testid="reused-none"><span class="lucide-recycle mr-1 inline-block size-3.5 align-text-bottom" aria-hidden="true" />Nothing reused</p>}>
        <p class="font-medium text-ink-gray-8"><span class="lucide-recycle mr-1 inline-block size-3.5 align-text-bottom" aria-hidden="true" />What Brain reused</p>
        <ul class="flex min-w-0 flex-col gap-0.5">
          <For each={kept()}>{(item) => <li class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="reused-item">
            <span>Reused:</span><ItemLink item={item} /><Badge size="sm" variant="outline" theme="gray" label={KIND_LABEL[item.kind]} /><span>last verified {formatRelative(item.lastVerifiedAt)} · {usedText(item.usedCount)}</span>
            <Show when={item.selfReviewed}><Badge size="sm" variant="outline" theme="amber" label="Self-reviewed" /></Show>
            <Show when={props.canEdit ?? app.canDispatch()}><Button size="xs" variant="ghost" aria-label={`Stop reusing ${item.title}`} onClick={() => void drop(item)}>Remove</Button></Show>
          </li>}</For>
        </ul>
      </Show>
      <Show when={message()}><p role="status">{message()}</p></Show>
    </div>
  </Show>;
}

/**
 * The capitalization half of the loop, on the mission itself: a finished, verified mission
 * has written up what it learned (#67). Says whether that record waits for a decision or is
 * already searchable, and links to the Review inbox.
 */
export function KnowledgeProposalNote(props: { missionId: string; workspaceId: string; achieved: boolean }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const assets = createScopedRead<KnowledgeAsset[]>({
    scope: app.scope, refreshMs: 10_000,
    resource: () => props.missionId,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: KnowledgeAsset[] }; asOf: string; sourceWatermark: number }>({ queryType: "knowledgeAssets.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((asset) => asset.missionId === props.missionId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  const asset = () => (assets.state().data ?? [])[0];
  const target = () => `/w/${props.workspaceId}/knowledge/review`;
  return <Show when={props.achieved && asset()}>{(record) => <div class="flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-outline-gray-1 bg-surface-gray-1 p-3 text-interface text-ink-gray-8" data-testid="knowledge-proposal-note">
    <span class="lucide-book-marked size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
    <p class="min-w-0 flex-1">{record().state === "published" ? "What Brain learned from this mission is published: it is searchable and offered to future plans." : record().rejectionReason ? "You left this mission's write-up out of search." : "Brain wrote up what it learned from this mission. Approve it once so search and future plans can use it."}</p>
    <Button size="sm" variant={record().state === "extracted" && !record().rejectionReason ? "solid" : "outline"} theme={record().state === "extracted" && !record().rejectionReason ? "blue" : "gray"} onClick={() => void navigate(target())}>{record().state === "extracted" && !record().rejectionReason ? "Review it" : "Open the Review inbox"}</Button>
  </div>}</Show>;
}

/** The brief's record of reuse (#68): what was kept or dropped for this mission, and by whom. */
export function ReusedInBrief(props: { missionId: string; workspaceId: string }): JSX.Element {
  const app = useApp();
  const reused = createScopedRead<ReuseItem[]>({
    scope: app.scope, refreshMs: 15_000,
    resource: () => props.missionId,
    load: async (_scope, signal) => reusedByMission(props.workspaceId, props.missionId, signal),
  });
  const who = (id: string | undefined) => (id === app.identity()?.actor.actorId ? "you" : "another person");
  return <Show when={(reused.state().data ?? []).length > 0}><WorkspaceSection title="Reused from earlier work" description="Past verified work the planner was shown as hints, never as proof. Who kept or dropped each item is recorded.">
    <ul class="flex flex-col gap-2" data-testid="brief-reused">
      <For each={reused.state().data}>{(item) => <li class={item.decision === "dropped" ? "text-ink-gray-5" : ""}>
        <ItemLink item={item} /> <span class="text-caption text-ink-gray-6">· {KIND_LABEL[item.kind]} · {item.decision === "dropped" ? "dropped" : "kept"} by {who(item.decidedBy)} · {freshness(item)}</span>
      </li>}</For>
    </ul>
  </WorkspaceSection></Show>;
}
