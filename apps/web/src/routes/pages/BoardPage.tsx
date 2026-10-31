import { useSearchParams } from "@solidjs/router";
import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { WorkBoardView, WorkItemState } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { WorkBoard } from "../../ui/components/WorkBoard";

export default function BoardPage(): JSX.Element {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const board = createScopedRead<WorkBoardView>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: WorkBoardView; asOf: string; sourceWatermark: number }>({ queryType: "workBoard.get", workspaceId: scope.workspaceId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
    refreshMs: 15_000,
  });
  const [conflict, setConflict] = createSignal<string>();
  return <WorkBoard selectedId={typeof params.card === "string" ? params.card : undefined} onSelected={(card) => setParams({ card })} board={board.state().data} state={board.state()} conflict={conflict()}
    onRefresh={() => void board.refresh({ force: true })}
    onTransition={async (item, state: WorkItemState, evidenceDigest, reason) => {
      try {
        const result = await app.run("workItem.transition", { workItemId: item.workItemId, state, ...(evidenceDigest ? { evidenceDigest } : {}), ...(reason ? { reason } : {}) }, { expectedVersion: item.version });
        setConflict(result.accepted ? undefined : result.detail);
        await board.refresh({ force: true });
      } catch (error) {
        await board.refresh({ force: true });
        setConflict(error instanceof Error ? error.message : "The move was refused");
      }
    }}
    onComment={async (item, text) => {
      await app.run("workItem.comment", { workItemId: item.workItemId, text });
      await board.refresh({ force: true });
    }} />;
}
