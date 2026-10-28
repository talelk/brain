import type { JSX } from "solid-js";
import type { BoardView, DecisionHistoryEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { boardQuery, decisionsQuery } from "../../data/governor";
import { DecisionsScreen } from "../work";

export default function DecisionsPage(): JSX.Element {
  const app = useApp();
  const decisions = createScopedRead<DecisionHistoryEntry[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await decisionsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 30_000,
  });
  const board = createScopedRead<BoardView>({
    scope: app.scope,
    load: (scope, signal) => boardQuery(scope.workspaceId, signal),
  });
  return <DecisionsScreen decisions={decisions.state().data ?? []} state={decisions.state()} cardIds={(board.state().data?.cards ?? []).map((c) => c.cardId)}
    viewerId={app.identity()?.actor.actorId} viewerName={app.identity()?.displayName}
    onRefresh={() => void decisions.refresh({ force: true })}
    onRecord={async (cardId, decision, note) => {
      const card = board.state().data?.cards.find((c) => c.cardId === cardId);
      const result = await app.run("decision.record", { cardId, decision, note }, { expectedVersion: card?.version ?? 0 });
      if (result.accepted) await decisions.refresh({ force: true });
    }}
    />;
}
