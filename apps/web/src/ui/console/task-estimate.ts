import type { Accessor } from "solid-js";
import type { Mission, PlanEstimate, WorkItem } from "@brain/contracts";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { useApp } from "../app-context";

export interface TaskFacts {
  /** The plan task's estimate, in minutes; absent when the plan gave none. */
  readonly estimatedMinutes?: number;
  readonly taskState?: WorkItem["state"];
  readonly missionId?: string;
  readonly mission?: { readonly state: Mission["state"]; readonly version: number };
}

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/**
 * What the plan says about the task a session works on: its estimate (from the
 * server's plan estimate) and the task's current state. Nothing is guessed: a
 * session with no task, or a task without an estimate, simply has no estimate.
 */
export function createTaskFacts(workItemId: Accessor<string | undefined>): Accessor<TaskFacts> & { refresh: () => Promise<void> } {
  const app = useApp();
  const read = createScopedRead<TaskFacts>({
    scope: app.scope,
    resource: workItemId,
    load: async (scope, signal, id) => {
      if (!id) return { snapshot: {}, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const item = await query<Envelope<WorkItem>>({ queryType: "workItems.get", workspaceId: scope.workspaceId, resourceId: id }, signal);
      let estimatedMinutes: number | undefined;
      try {
        const estimate = await query<Envelope<PlanEstimate>>({ queryType: "plans.estimate", workspaceId: scope.workspaceId, resourceId: item.snapshot.planVersionId }, signal);
        estimatedMinutes = estimate.snapshot.tasks.find((task) => task.taskId === item.snapshot.planTaskId)?.estimatedMinutes;
      } catch { /* an unreadable estimate is an unknown one */ }
      let mission: TaskFacts["mission"];
      try {
        const read = await query<Envelope<Mission>>({ queryType: "missions.get", workspaceId: scope.workspaceId, resourceId: item.snapshot.missionId }, signal);
        mission = { state: read.snapshot.state, version: read.snapshot.version };
      } catch { /* the mission controls simply stay hidden */ }
      return { snapshot: { ...(mission ? { mission } : {}), ...(estimatedMinutes !== undefined ? { estimatedMinutes } : {}), taskState: item.snapshot.state, missionId: item.snapshot.missionId }, asOf: item.asOf, sourceWatermark: item.sourceWatermark };
    },
    refreshMs: 10_000,
  });
  return Object.assign(() => read.state().data ?? {}, { refresh: () => read.refresh({ force: true }) });
}
