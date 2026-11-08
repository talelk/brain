import { For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { JobSnapshot, TaskContext, TaskOrigin } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { governor } from "../../data/client";
import { jobsQuery } from "../../data/governor";
import { ScreenRegion } from "../screen-region";
import { StatusBadge } from "./StatusBadge";
import { WorkspaceSection } from "./Domain";

/** Run correlation row: job and session ids as the server resolved them. The
 * sessionId field trails in the generated contract until contract
 * regeneration; the Governor already resolves the attempt-bound session. */
type RunBinding = { runId: string; jobId: string; sessionId?: string };

/**
 * Execution-link panel for one work item, ticket or incident. Every run links
 * to its exact execution context — the run inspector always; the live console,
 * Logs and Outputs once the server-resolved job snapshot carries the bound
 * session and job ids.
 */
export function WorkItemTasks(props: { origin: TaskOrigin }) {
  const app = useApp(); const navigate = useNavigate();
  const context = createScopedRead<TaskContext>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<TaskContext>(`/v1/task-context?workspaceId=${encodeURIComponent(scope.workspaceId)}&kind=${props.origin.kind}&id=${encodeURIComponent(props.origin.id)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }), refreshMs: 5000 });
  // One workspace read: jobs.list snapshots carry workflowRunId plus the
  // server-resolved session binding, so no per-run lookup is needed here.
  const bindings = createScopedRead<RunBinding[]>({ scope: app.scope,
    load: async (scope, signal) => {
      const view = await jobsQuery({ workspaceId: scope.workspaceId }, signal);
      return { ...view, snapshot: view.snapshot.items.map((job) => ({ runId: job.workflowRunId, jobId: job.jobId, sessionId: (job as JobSnapshot & { readonly sessionId?: string }).sessionId })) };
    },
    isEmpty: (items) => !items.length,
  });
  const bindingFor = (runId: string) => bindings.state().data?.find((binding) => binding.runId === runId);
  return <WorkspaceSection title="Tasks for this item" actions={<Show when={app.canDispatch()}><Button size="md" variant="outline" iconLeft="lucide-play" onClick={() => void navigate(`/w/${app.workspaceId()}/plays?originKind=${props.origin.kind}&originId=${encodeURIComponent(props.origin.id)}`)}>Start a task for this item</Button></Show>}>
    <ScreenRegion state={context.state()} onRetry={() => void context.refresh()} emptyTitle="No related tasks" emptyDescription="Start a task to link its progress and results to this work item.">
      <Show when={context.state().data?.runs.length} fallback={<p class="text-interface text-ink-gray-6">No tasks started for this item yet.</p>}>
        <div class="brain-queue"><For each={context.state().data?.runs}>{(run) => {
          const binding = () => bindingFor(run.runId);
          return <div class="flex flex-wrap items-center justify-between gap-2 border-b border-outline-gray-1 px-2 py-3">
            <span class="flex min-w-0 flex-wrap items-center gap-2"><span class="break-words text-base-medium text-ink-gray-9">{run.title}</span><StatusBadge kind="job" status={run.state} /></span>
            <span class="flex flex-wrap items-center gap-1.5">
              <Show when={binding()?.sessionId}><Button size="md" variant="ghost" iconLeft="lucide-radio" onClick={() => void navigate(`/w/${app.workspaceId()}/live?session=${encodeURIComponent(binding()?.sessionId ?? "")}`)}>Console</Button></Show>
              <Show when={binding()?.jobId || binding()?.sessionId}><Button size="md" variant="ghost" iconLeft="lucide-scroll-text" onClick={() => void navigate(binding()?.jobId ? `/w/${app.workspaceId()}/logs?job=${encodeURIComponent(binding()?.jobId ?? "")}` : `/w/${app.workspaceId()}/logs?session=${encodeURIComponent(binding()?.sessionId ?? "")}`)}>Logs</Button></Show>
              <Button size="md" variant="ghost" iconLeft="lucide-package" onClick={() => void navigate(binding()?.jobId ? `/w/${app.workspaceId()}/outputs?job=${encodeURIComponent(binding()?.jobId ?? "")}` : `/w/${app.workspaceId()}/outputs?run=${encodeURIComponent(run.runId)}`)}>Outputs</Button>
              <Button size="md" variant="outline" iconRight="lucide-arrow-right" onClick={() => void navigate(`/runs/${run.runId}`)}>Inspect run</Button>
            </span>
          </div>;
        }}</For></div>
      </Show>
    </ScreenRegion>
  </WorkspaceSection>;
}
