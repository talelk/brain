import { OperationalChecklist } from "../catalog";
import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { WorkspaceContext } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { configExplainQuery, workspaceContextQuery } from "../../data/governor";
import { WorkspaceOverview } from "../workspace";

export default function WorkspaceOverviewPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const context = createScopedRead<WorkspaceContext>({
    scope: app.scope,
    load: (scope, signal) => workspaceContextQuery(scope.workspaceId, signal),
    refreshMs: 30_000,
  });
  const workflows = createScopedRead<string[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await configExplainQuery(scope.workspaceId, "/workflows", signal);
      const effective = loaded.snapshot.effective;
      const ids = effective && typeof effective === "object" && !Array.isArray(effective) ? Object.keys(effective) : [];
      return { ...loaded, snapshot: ids };
    },
    isEmpty: (ids) => ids.length === 0,
  });
  const [actionMessage, setActionMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={actionMessage()}><p role="status" class="text-base text-ink-gray-7">{actionMessage()}</p></Show>
    <OperationalChecklist />
    <WorkspaceOverview onBrowseWorkflows={() => void navigate(`/w/${app.workspaceId()}/workflows`)} workspaceId={app.workspaceId()} context={context.state().data}      workflows={workflows.state().data ?? []} canDispatch={app.canDispatch()}
      state={context.state()} onRefresh={() => void context.refresh({ force: true })}
      blockedReason={context.state().canMutate ? undefined
        : context.state().error ?? "The workspace view is not fresh; re-read before dispatching an effect."}
      onDispatch={async (workflowId, input) => {
        try {
          const release = context.state().data?.release;
          const result = await app.run("workflow.dispatch", {
            workflow: { id: workflowId, digest: release?.configDigest ?? "" },
            input,
          });
          setActionMessage(result.detail);
          if (result.accepted && result.resourceId) void navigate(`/jobs/${result.resourceId}`);
          await context.refresh({ force: true });
        } catch (e) { setActionMessage(e instanceof Error ? e.message : "Dispatch failed."); }
      }} />
  </div>;
}
