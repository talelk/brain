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
  };
}
