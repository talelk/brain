import type { Accessor } from "solid-js";
import type { BoardView, WorkItem } from "@brain/contracts";
import { fetchView } from "./governor";
import { createScopedRead, type ScreenState } from "./screens";

/**
 * The single board read model. Every screen that shows or judges work items
 * binds to this one read — including the version a decision or transition
 * must carry, so a stale client can never overwrite newer server state.
 */
export interface BoardModel {
  state: Accessor<ScreenState<BoardView>>;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  /** The work item behind an id, with the version effects must bind to. */
  item: (workItemId: string) => WorkItem | undefined;
}

export function createBoardModel(
  scope: Accessor<{ organizationId: string; workspaceId: string; generation: number }>,
  options: { refreshMs?: number } = {},
): BoardModel {
  const board = createScopedRead<BoardView>({
    scope,
    load: (s, signal) => fetchView({ queryType: "board.get", workspaceId: s.workspaceId }, signal),
    isEmpty: (view) => view.items.length === 0,
    ...(options.refreshMs ? { refreshMs: options.refreshMs } : {}),
  });
  return {
    state: board.state,
    refresh: board.refresh,
    item: (workItemId) => board.state().data?.items.find((candidate) => candidate.workItemId === workItemId),
  };
}
