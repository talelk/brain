import type { CommandHandler, CommandHandlers } from "../../application/command-funnel";
import type { IntegrationService } from "./service";

/** Integration commands: connections and repository bindings live in control.db. */
export function integrationCommands(integrations: IntegrationService): CommandHandlers {
  const handler = (outcome: "applied" | "queued"): CommandHandler => ({
    kind: "control",
    handle: ({ actor, cmd }) => ({ outcome, resourceId: integrations.apply(actor, cmd as Parameters<IntegrationService["apply"]>[1]) }),
  });
  return {
    "integration.connect": handler("applied"),
    "integration.verify": handler("applied"),
    "integration.bind": handler("applied"),
  };
}
