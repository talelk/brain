import type { SnapshotManifest, TaskSummary } from "@brain/contracts";

/**
 * How agents hand work to each other, read from what the model has: a Play's steps (`after`, `review_by`, `judge`) and the tasks
 * that recently ran (a step after another, a sub-task an agent or the planner created, a check). Agents never message each other, so
 * this is every way one agent's work reaches another.
 */
export interface Handoff {
  /** `work`: the first agent's result is the second's input. `check`: the second agent checks the first's result. */
  readonly kind: "work" | "check";
  readonly from: string;
  readonly to: string;
  /** How often it happened in the tasks given; 0 when only a Play names it. */
  readonly count: number;
  readonly planned: boolean;
}

export function handoffs(snapshot: SnapshotManifest, tasks: readonly TaskSummary[]): Handoff[] {
  const agents = snapshot.agents;
  const edges = new Map<string, { kind: Handoff["kind"]; from: string; to: string; count: number; planned: boolean }>();
  const add = (kind: Handoff["kind"], from: string | null | undefined, to: string | null | undefined, count: number, planned = false): void => {
    if (!from || !to || from === to || !agents[from] || !agents[to]) return;
    const key = `${kind}\n${from}\n${to}`;
    const edge = edges.get(key) ?? { kind, from, to, count: 0, planned: false };
    edges.set(key, { ...edge, count: edge.count + count, planned: edge.planned || planned });
  };

  for (const play of Object.values(snapshot.plays)) {
    for (const step of play.step) {
      for (const before of step.after) add("work", play.step.find((other) => other.id === before)?.agent, step.agent, 0, true);
      add("check", step.agent, step.review_by, 0, true);
      if (step.judge && step.judge !== "person") for (const doer of Array.isArray(step.candidates) ? step.candidates : [step.agent]) add("check", doer, step.judge, 0, true);
    }
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const checker = agents["checker"] ? "checker" : null;
  for (const task of tasks) {
    const step = task.play && task.stepId ? snapshot.plays[task.play]?.step.find((candidate) => candidate.id === task.stepId) : undefined;
    for (const before of step?.after ?? []) {
      for (const earlier of tasks) if (earlier.rootId === task.rootId && earlier.stepId === before && earlier.id !== task.id) add("work", earlier.agent, task.agent, 1);
    }
    if (task.stepId === null && task.parentId !== null) {
      const parent = byId.get(task.parentId);
      if (parent) add("work", parent.agent ?? (parent.id === parent.rootId && parent.play === null ? "planner" : null), task.agent, 1);
    }
    if (task.agent !== null && (task.state === "done" || task.state === "failed" || task.round > 1)) {
      const rounds = task.state === "done" || task.state === "failed" ? Math.max(1, task.round) : task.round - 1;
      add("check", task.agent, step?.review_by ?? checker, rounds);
    }
  }
  return [...edges.values()];
}
