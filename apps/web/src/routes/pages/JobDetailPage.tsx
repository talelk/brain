import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type { JobSnapshot, PlacementExplanation, SessionView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { jobExplainQuery, jobQuery, sessionsQuery } from "../../data/governor";
import { RunDetail } from "../../ui/components/RunDetail";

export default function JobDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const jobId = () => params.id ?? "";
  const job = createScopedRead<JobSnapshot>({
    scope: app.scope,
    load: (scope, signal) => jobQuery(scope.workspaceId, jobId(), signal),
    refreshMs: 10_000,
  });
  const explanation = createScopedRead<PlacementExplanation>({
    scope: app.scope,
    load: (scope, signal) => jobExplainQuery(scope.workspaceId, jobId(), signal),
  });
  const sessions = createScopedRead<SessionView[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await sessionsQuery({ workspaceId: scope.workspaceId }, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
  });
  const [message, setMessage] = createSignal("");
  const jobSession = () => (sessions.state().data ?? []).find((s) => s.jobId === job.state().data?.jobId);
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <RunDetail jobId={jobId()} job={job.state().data} explanation={explanation.state().data}
      state={job.state()} onRefresh={() => void job.refresh({ force: true })}
      {...(jobSession() ? { onOpenSession: () => void navigate(`/sessions/${jobSession()!.sessionId}`) } : {})}
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
