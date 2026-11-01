import { OperationalChecklist } from "../../ui/components/OperationalChecklist";
import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { JobSnapshot, WorkspaceContext } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { jobsQuery, workspaceContextQuery } from "../../data/governor";
import { WorkspaceOverview } from "../workspace";
import { DisclosureCard } from "../../ui/components/primitives";
import { WorkspaceManagementDialog } from "../../ui/components/WorkspaceManagementDialog";

export default function WorkspaceOverviewPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [manageOpen, setManageOpen] = createSignal(false);
  const context = createScopedRead<{ context: WorkspaceContext; jobs: JobSnapshot[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [workspace, jobs] = await Promise.all([workspaceContextQuery(scope.workspaceId, signal), jobsQuery({ workspaceId: scope.workspaceId, limit: 5 }, signal)]);
      return { asOf: workspace.asOf, sourceWatermark: workspace.sourceWatermark, snapshot: { context: workspace.snapshot, jobs: [...jobs.snapshot.items] } };
    },
    refreshMs: 30_000,
  });
  return <div class="flex flex-col gap-field-gap">
    <Show when={app.canAdminister()}><DisclosureCard label="Installation status"><OperationalChecklist /></DisclosureCard></Show>
    <WorkspaceOverview onBrowseWorkflows={() => void navigate(`/w/${app.workspaceId()}/workflows`)} workspaceId={app.workspaceId()} context={context.state().data?.context} recentJobs={context.state().data?.jobs ?? []} canDispatch={app.canDispatch()}
      onOpenJob={(jobId) => void navigate(`/jobs/${jobId}`)} state={context.state()} onRefresh={() => void context.refresh({ force: true })}
      onManage={app.canAdminister() ? () => setManageOpen(true) : undefined}
      blockedReason={context.state().canMutate ? undefined : context.state().error ?? "The workspace view is not fresh; re-read before dispatching an effect."} />
    <WorkspaceManagementDialog open={manageOpen()} workspace={context.state().data?.context.workspace} onClose={() => setManageOpen(false)} onChanged={async () => { setManageOpen(false); await context.refresh({ force: true }); }} />
  </div>;
}
