import { For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import type { TaskContext, TaskOrigin } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { governor } from "../../data/client";
import { ScreenRegion } from "../screen-region";
export function WorkItemTasks(props: { origin: TaskOrigin }) {
  const app = useApp(); const navigate = useNavigate();
  const context = createScopedRead<TaskContext>({ scope: app.scope, load: async (scope, signal) => ({ snapshot: await governor<TaskContext>(`/v1/task-context?workspaceId=${encodeURIComponent(scope.workspaceId)}&kind=${props.origin.kind}&id=${encodeURIComponent(props.origin.id)}`, undefined, signal), asOf: new Date().toISOString(), sourceWatermark: 0 }), refreshMs: 5000 });
  return <Section title="Tasks for this item" surface="card" actions={<Show when={app.canDispatch()}><Button size="lg" onClick={() => void navigate(`/w/${app.workspaceId()}/workflows?mode=catalog&originKind=${props.origin.kind}&originId=${encodeURIComponent(props.origin.id)}`)}>Start a task for this item</Button></Show>}>
    <ScreenRegion state={context.state()} onRetry={() => void context.refresh()} emptyTitle="No related tasks" emptyDescription="Start a task to link its progress and results to this work item.">
      <Show when={context.state().data?.runs.length} fallback={<p>No tasks started for this item yet.</p>}><For each={context.state().data?.runs}>{(run) => <div class="flex flex-wrap items-center justify-between gap-2 py-2"><span>{run.title} · {run.state}</span><Button size="lg" variant="outline" onClick={() => void navigate(`/jobs/${run.runId}`)}>View result</Button></div>}</For></Show>
    </ScreenRegion>
  </Section>;
}
