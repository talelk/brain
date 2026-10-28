import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { BoardView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { boardQuery } from "../../data/governor";
import { BoardScreen } from "../work";

export default function BoardPage(): JSX.Element {
  const app = useApp();
  const board = createScopedRead<BoardView>({
    scope: app.scope,
    load: (scope, signal) => boardQuery(scope.workspaceId, signal),
    isEmpty: (view) => view.cards.length === 0,
    refreshMs: 15_000,
  });
  const [conflict, setConflict] = createSignal<string>();
  async function move(cardId: string, status: string, version: number, evidenceDigest?: string) {
    try {
      const result = await app.run("board.move", { cardId, status: status as "to-decide" | "todo" | "in-progress" | "verifying" | "done" | "blocked", evidenceDigest }, { expectedVersion: version });
      setConflict(result.accepted ? undefined : `${result.detail} The board shows the newer state; decide again if the intent stands.`);
      await board.refresh({ force: true });
    } catch (e) {
      await board.refresh({ force: true });
      setConflict(e instanceof Error ? e.message : "The move was refused; the board shows the newer state.");
    }
  }
  return <BoardScreen board={board.state().data} state={board.state()} conflict={conflict()}
    onRefresh={() => void board.refresh({ force: true })}
    onCreate={async (title, criteria) => {
      try { const result = await app.run("board.create", { title, criteria }); setConflict(undefined); if (result.accepted) await board.refresh({ force: true }); }
      catch { /* the refresh above surfaces the authoritative state */ }
    }}
    onMove={move}
    onComment={async (cardId, text) => {
      const card = board.state().data?.cards.find((c) => c.cardId === cardId);
      await app.run("board.comment", { cardId, text }, { expectedVersion: card?.version ?? 0 });
      await board.refresh({ force: true });
    }} />;
}
