import type { CommandHandler, CommandHandlers } from "../../application/command-funnel";
import type { CapitalizationService } from "./service";

/** Capitalization commands: runs, candidate review and governed tool publication. */
export function capitalizationCommands(capitalization: CapitalizationService): CommandHandlers {
  const handler = (outcome: "applied" | "queued"): CommandHandler => ({
    kind: "workspace",
    handle: ({ actor, cmd }) => ({ outcome, resourceId: capitalization.apply(actor, cmd as Parameters<CapitalizationService["apply"]>[1]) }),
  });
  return {
    // A capitalization run is requested here and executed by the runtime.
    "capitalization.run": handler("queued"),
    "capability.review": handler("applied"),
    "tool.propose": handler("applied"),
    "tool.publish": handler("applied"),
    // Approving writes control.db (memory) and workspace.db (asset): idempotent on the asset id, so a retry repairs a crash between them.
    "knowledge.review": { kind: "self", handle: ({ actor, cmd }) => ({ outcome: "applied", resourceId: capitalization.apply(actor, cmd as Parameters<CapitalizationService["apply"]>[1]) }) },
    "knowledge.approveVerified": { kind: "self", handle: ({ actor, cmd }) => ({ outcome: "applied", resourceId: capitalization.apply(actor, cmd as Parameters<CapitalizationService["apply"]>[1]) }) },
    "library.settings.set": handler("applied"),
  };
}
