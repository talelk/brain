import { OperationalChecklist } from "../../ui/components/OperationalChecklist";
import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { WorkspaceContext } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { workspaceContextQuery } from "../../data/governor";
import { WorkspaceOverview } from "../workspace";
import { DisclosureCard } from "../../ui/components/primitives";

export default function WorkspaceOverviewPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const context = createScopedRead<WorkspaceContext>({
    scope: app.scope,
    load: (scope, signal) => workspaceContextQuery(scope.workspaceId, signal),
    refreshMs: 30_000,
  });
  return <div class="flex flex-col gap-field-gap">
    <Show when={app.canAdminister()}><DisclosureCard label="Installation status"><OperationalChecklist /></DisclosureCard></Show>
    <WorkspaceOverview onBrowseWorkflows={() => void navigate(`/w/${app.workspaceId()}/workflows`)} workspaceId={app.workspaceId()} context={context.state().data}      canDispatch={app.canDispatch()}
      state={context.state()} onRefresh={() => void context.refresh({ force: true })}
      blockedReason={context.state().canMutate ? undefined
        : context.state().error ?? "The workspace view is not fresh; re-read before dispatching an effect."}
 />
  </div>;
}
