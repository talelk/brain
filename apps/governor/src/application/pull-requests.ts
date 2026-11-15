import type { IntegrationService } from "../modules/integrations/index";
import { observePullRequest, pullRequestRef } from "../modules/missions/index";
import type { CommandHandlers } from "./command-funnel";
import type { Store } from "./store";

/**
 * Refreshing a pull request's state by hand (#121). The Governor asks the provider, over the connection the request was opened through,
 * where the request stands and adds that as a new observation; no webhook is involved and nothing at the provider is changed. A person
 * asks for it: an agent has no command for it, so no session can use the connection's credentials this way.
 */
export function pullRequestCommands(ports: { store: Store; integrations: IntegrationService }): CommandHandlers {
  const { store, integrations } = ports;
  return {
    "pullRequest.refresh": {
      kind: "external",
      handle: async ({ actor, cmd, workspaceId }) => {
        const pullRequestId = String(cmd.payload["pullRequestId"]);
        const db = store.workspaceDb(workspaceId, actor.organizationId);
        const state = await integrations.pullRequestState(actor.organizationId, pullRequestRef(db, pullRequestId));
        observePullRequest(store, db, { organizationId: actor.organizationId, workspaceId, pullRequestId, state, observedBy: actor.actorId });
        return { resourceId: pullRequestId };
      },
    },
  };
}
