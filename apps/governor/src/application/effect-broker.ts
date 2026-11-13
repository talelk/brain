import type { JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import type { IntegrationService } from "../modules/integrations/index";
import type { Connectors } from "../modules/operations/connectors";

type Input = Readonly<Record<string, unknown>>;
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/**
 * Performs an approved effect that needs the Governor's own credentials: a ticket, a team message or a pull request. By now the call
 * passed its approval, its single-use permit and the argument check; the connector holds the secret and the answer carries none.
 */
export async function runGovernorEffect(ports: { connectors: Connectors; integrations: IntegrationService }, call: { organizationId: string; workspaceId: string; toolId: string; input: Input }): Promise<JsonValue> {
  const { input } = call;
  switch (call.toolId) {
    case "ticket.create": {
      if (!ports.connectors.tickets) throw new BrainDomainError("FORBIDDEN", "no ticketing system is connected on this server");
      const created = await ports.connectors.tickets.create({ title: text(input["title"], 200), description: text(input["description"], 4000), priority: text(input["priority"], 20) || "normal" });
      return { ticketId: created.id, url: created.url } as unknown as JsonValue;
    }
    case "message.send": {
      if (!ports.connectors.messages) throw new BrainDomainError("FORBIDDEN", "no team chat is connected on this server");
      await ports.connectors.messages.send(text(input["text"], 2000));
      return { delivered: true } as unknown as JsonValue;
    }
    case "git.open-pr": {
      const files = (Array.isArray(input["files"]) ? input["files"] : []).map((file) => ({ path: text((file as Input)["path"], 300), content: text((file as Input)["content"], 100 * 1024) }));
      const opened = await ports.integrations.openPullRequest(call.organizationId, call.workspaceId, { title: text(input["title"], 200), body: text(input["body"], 4000), branch: text(input["branch"], 80), files });
      return { url: opened.url, number: opened.number, branch: opened.branch, commit: opened.commit } as unknown as JsonValue;
    }
    default:
      throw new BrainDomainError("FORBIDDEN", `${call.toolId} is not performed by the Governor`);
  }
}
