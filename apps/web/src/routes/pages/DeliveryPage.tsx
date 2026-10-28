import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { BoardView, DeliveryDossier } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { boardQuery, deliveryQuery } from "../../data/governor";
import { DeliveryScreen } from "../work";

export default function DeliveryPage(): JSX.Element {
  const app = useApp();
  const dossiers = createScopedRead<DeliveryDossier[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await deliveryQuery(scope.workspaceId, undefined, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 30_000,
  });
  const board = createScopedRead<BoardView>({
    scope: app.scope,
    load: (scope, signal) => boardQuery(scope.workspaceId, signal),
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <DeliveryScreen dossiers={dossiers.state().data ?? []} state={dossiers.state()}
      onRefresh={() => void dossiers.refresh({ force: true })} onOpen={() => undefined}
      onDecide={async (cardId, note) => {
        const card = board.state().data?.cards.find((c) => c.cardId === cardId);
        const result = await app.run("decision.record", { cardId, decision: "go", note }, { expectedVersion: card?.version ?? 0 });
        setMessage(result.detail);
      }} />
  </div>;
}
