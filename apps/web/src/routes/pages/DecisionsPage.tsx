import type { JSX } from "solid-js";
import type { DecisionHistoryEntry } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { createBoardModel } from "../../data/board";
import { decisionsQuery } from "../../data/governor";
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
  const board = createBoardModel(app.scope);
  return <DecisionsScreen decisions={decisions.state().data ?? []} state={decisions.state()} workItemIds={(board.state().data?.items ?? []).map((item) => item.workItemId)}
    viewerId={app.identity()?.actor.actorId} viewerName={app.identity()?.displayName}
    onRefresh={() => void decisions.refresh({ force: true })}
    onRecord={async (workItemId, decision, note) => {
      const item = board.item(workItemId);
      const result = await app.run("decision.record", { workItemId, decision, note }, { expectedVersion: item?.version ?? 0 });
      if (result.accepted) {
        await decisions.refresh({ force: true });
        await board.refresh({ force: true });
      }
    }}
    />;
}
