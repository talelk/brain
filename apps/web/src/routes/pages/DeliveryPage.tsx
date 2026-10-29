import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Dialog } from "@talelk/newui-molecules";
import type { BoardView, DeliveryDossier } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { boardQuery, deliveryQuery } from "../../data/governor";
import { DeliveryScreen } from "../work";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { ArtifactContent } from "../../ui/components/ArtifactContent";
import { DigestValue } from "../../ui/components/DigestValue";

export default function DeliveryPage(): JSX.Element {
  const app = useApp();
  const dossiers = createScopedRead<DeliveryDossier[]>({ scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await deliveryQuery(scope.workspaceId, undefined, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    }, isEmpty: (items) => items.length === 0, refreshMs: 30_000,
  });
  const board = createScopedRead<BoardView>({ scope: app.scope, load: (scope, signal) => boardQuery(scope.workspaceId, signal) });
  const [message, setMessage] = createSignal("");
  const [selected, setSelected] = createSignal("");
  const [detail, setDetail] = createSignal<DeliveryDossier>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => {
    const id = selected();
    const controller = new AbortController();
    setDetail(undefined); setError("");
    if (id) {
      setLoading(true);
      void deliveryQuery(app.workspaceId(), id, controller.signal)
        .then((loaded) => setDetail(loaded.snapshot))
        .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Dossier could not be loaded"); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
    onCleanup(() => controller.abort());
  });
  const card = () => board.state().data?.cards.find((candidate) => candidate.cardId === selected());
  return <div class="brain-detail-stack">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <DeliveryScreen dossiers={dossiers.state().data ?? []} state={dossiers.state()}
      onRefresh={() => void dossiers.refresh({ force: true })} onOpen={setSelected}
      onDecide={async (cardId, note) => {
        const current = board.state().data?.cards.find((candidate) => candidate.cardId === cardId);
        const result = await app.run("decision.record", { cardId, decision: "go", note }, { expectedVersion: current?.version ?? 0 });
        setMessage(result.detail);
      }} />
    <Dialog.Root open={Boolean(selected())} onOpenChange={(open) => { if (!open) setSelected(""); }}>
      <Dialog.Content size="4xl" position="top">
        <Dialog.Header><Dialog.Title>Delivery dossier</Dialog.Title><Dialog.Description>Criteria, independent evidence and the exact source behind this delivery decision.</Dialog.Description></Dialog.Header>
        <Show when={!loading()} fallback={<p role="status">Loading dossier…</p>}>
          <Show when={!error()} fallback={<p role="alert">{error()}</p>}>
            <Show when={detail()} keyed>{(dossier) => <div class="brain-detail-stack">
              <div class="flex flex-wrap items-center gap-control-gap"><StatusBadge status={dossier.state} /><span class="text-base text-ink-gray-7">{dossier.criteria.filter((criterion) => criterion.status === "passed").length}/{dossier.criteria.length} criteria passed</span></div>
              <div><span class="text-caption text-ink-gray-6">Source revision</span><DigestValue value={dossier.sourceRevision} label="Source revision" /></div>
              <section><h3 class="mb-2 text-base-medium">Acceptance criteria</h3><For each={dossier.criteria}>{(criterion) => <article class="border-b border-outline-gray-1 py-3 last:border-0">
                <div class="flex flex-wrap items-center gap-2"><StatusBadge status={criterion.status} /><strong>{criterion.criterionId}</strong></div><p class="mt-1 text-base text-ink-gray-7">{criterion.detail}</p>
              </article>}</For></section>
              <section><h3 class="mb-2 text-base-medium">Evidence artifacts</h3><Show when={dossier.evidence.length} fallback={<p>No evidence artifacts are attached.</p>}><For each={dossier.evidence}>{(artifact) => <ArtifactContent artifact={artifact} compact />}</For></Show></section>
              <Show when={card()}>{(linked) => <Button class="min-h-11" onClick={() => void (async () => {
                const result = await app.run("decision.record", { cardId: linked().cardId, decision: "go", note: `Accepted against delivery dossier ${dossier.id}` }, { expectedVersion: linked().version });
                setMessage(result.detail); setSelected("");
              })()}>Record Go decision</Button>}</Show>
            </div>}</Show>
          </Show>
        </Show>
        <Dialog.Footer><Button variant="outline" onClick={() => setSelected("")}>Close</Button></Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </div>;
}
