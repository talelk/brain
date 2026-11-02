import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import type { PlacementExplanation } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { jobExplainQuery, jobQuery } from "../../data/governor";
import { RunDetail, type RunJobSnapshot } from "../../ui/components/RunDetail";
import { ActionFeedback } from "../../ui/components/ActionFeedback";

export default function JobDetailPage(): JSX.Element {
  const app = useApp();
  const params = useParams();
  const jobId = () => params.id ?? "";
  const job = createScopedRead<RunJobSnapshot>({
    scope: app.scope,
    load: (scope, signal) => jobQuery(scope.workspaceId, jobId(), signal),
    refreshMs: 10_000,
  });
  const explanation = createScopedRead<PlacementExplanation>({
    scope: app.scope,
    load: (scope, signal) => jobExplainQuery(scope.workspaceId, jobId(), signal),
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <ActionFeedback message={message()} />
    <RunDetail jobId={jobId()} job={job.state().data} explanation={explanation.state().data}
      state={job.state()} onRefresh={() => void job.refresh({ force: true })}
      onCancel={async (reason) => {
        const runId = job.state().data?.workflowRunId;
        if (!runId) { setMessage("No run is bound to this job yet."); return; }
        const result = await app.run("workflow.cancel", { runId, reason });
        setMessage(result.detail);
        await job.refresh({ force: true });
      }}
      onReconcile={async (reason) => {
        const current = job.state().data;
        if (!current) return;
        const result = await app.run("job.reconcile", { jobId: current.jobId, reason }, { expectedVersion: current.version });
        setMessage(result.detail);
        await job.refresh({ force: true });
      }} />
  </div>;
}
