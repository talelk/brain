import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { JobSnapshot, RunnerSnapshot, SessionView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { jobsQuery, runnersQuery, sessionsQuery } from "../../data/governor";
import { RunsScreen } from "../runs";

export default function RunsPage(props: { initialTab?: "runs" | "sessions" | "runners" }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const runs = createScopedRead<{ jobs: JobSnapshot[]; sessions: SessionView[]; runners: RunnerSnapshot[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [j, s, r] = await Promise.all([
        jobsQuery({ workspaceId: scope.workspaceId }, signal),
        sessionsQuery({ workspaceId: scope.workspaceId }, signal),
        runnersQuery({ workspaceId: scope.workspaceId }, signal),
      ]);
      return {
        asOf: j.asOf, sourceWatermark: j.sourceWatermark,
        snapshot: { jobs: [...j.snapshot.items], sessions: [...s.snapshot.items], runners: [...r.snapshot.items] },
      };
    },
    isEmpty: (data) => data.jobs.length === 0 && data.sessions.length === 0 && data.runners.length === 0,
    refreshMs: 10_000,
  });
  return <RunsScreen workspaceId={app.workspaceId()} initialTab={props.initialTab}
    jobs={runs.state().data?.jobs ?? []} sessions={runs.state().data?.sessions ?? []} runners={runs.state().data?.runners ?? []}
    state={runs.state()} onRefresh={() => void runs.refresh({ force: true })}
    onOpenJob={(jobId) => void navigate(`/jobs/${jobId}`)}
    onOpenSession={(sessionId) => void navigate(`/sessions/${sessionId}`)}
    onOpenRunner={(runnerId) => void navigate(`/runners/${runnerId}`)}
    onDispatch={() => void navigate(`/w/${app.workspaceId()}/overview`)}
    canDispatch={app.canDispatch()} />;
}
