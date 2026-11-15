import type { JsonValue } from "@brain/contracts";
import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import type { SessionService } from "./service";

/** Session commands: lifecycle, checkpoints, delegation and live steer/stop controls. */
export function sessionCommands(sessions: SessionService): CommandHandlers {
  return {
    ...handlersFor(["session.create", "session.checkpoint", "session.delegate", "delegation.review"], {
      kind: "workspace",
      handle: ({ actor, cmd }) => ({ resourceId: sessions.apply(actor, cmd as Parameters<SessionService["apply"]>[1]) }),
    }),
    // Starts a run, so it manages its own transactions and is idempotent on the command id (as workflow.dispatch is).
    "session.resume": {
      kind: "self",
      handle: ({ actor, cmd, workspaceId }) => ({ outcome: "queued", resourceId: sessions.resume(actor, workspaceId, cmd.commandId, cmd.payload) }),
    },
    ...handlersFor(["session.steer", "session.stop"], {
      kind: "workspace",
      handle: ({ actor, cmd, workspaceId }) => ({
        resourceId: sessions.enqueueControl(actor, workspaceId, String(cmd.payload["sessionId"]), cmd.commandType as "session.steer" | "session.stop", cmd.payload as JsonValue),
      }),
    }),
  };
}
