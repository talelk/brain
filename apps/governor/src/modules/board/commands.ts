import type { CommandHandlers } from "../../application/command-funnel";
import type { BoardService } from "./service";

/** Board commands: business decisions bound to work items (ADR 0001). */
export function boardCommands(board: BoardService): CommandHandlers {
  return {
    "decision.record": { kind: "workspace", handle: ({ actor, cmd, workspaceId }) => ({ resourceId: board.apply(actor, cmd, workspaceId) }) },
  };
}
