import type { PlanTask } from "@brain/contracts";
import { BrainDomainError } from "./errors";

export function assertPlanTasks(tasks: readonly PlanTask[]): readonly string[] {
  if (tasks.length === 0 || tasks.length > 100) throw new BrainDomainError("INVALID_ARGUMENT", "a plan must contain between 1 and 100 tasks");
  const byId = new Map<string, PlanTask>();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new BrainDomainError("INVALID_ARGUMENT", `duplicate plan task ${task.id}`);
    if (task.criteria.length === 0) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} needs success criteria`);
    if (task.dependsOn.includes(task.id)) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} cannot depend on itself`);
    byId.set(task.id, task);
  }
  // Best-of-N (ADR 0064): two to four candidates, each naming a team member or a way of working, no two alike.
  for (const task of tasks) {
    const candidates = task.candidates;
    if (candidates === undefined) continue;
    if (candidates.length < 2 || candidates.length > 4) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} needs two to four candidates`);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.memberId && !candidate.workflowId) throw new BrainDomainError("INVALID_ARGUMENT", `candidate ${candidate.id} of plan task ${task.id} names neither a team member nor a way of working`);
      const key = `${candidate.memberId ?? ""}|${candidate.workflowId ?? ""}`;
      if (seen.has(key)) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} has two candidates with the same member and way of working`);
      seen.add(key);
    }
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} has duplicate candidate ids`);
    if (task.parentId !== undefined || tasks.some((other) => other.parentId === task.id)) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} has candidates and so cannot be a subtask or have subtasks`);
  }
  // A subtask names a task of the same plan, one level deep: a parent is never itself a subtask (ADR 0057).
  for (const task of tasks) {
    if (task.parentId === undefined) continue;
    const parent = byId.get(task.parentId);
    if (!parent) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} is a subtask of unknown task ${task.parentId}`);
    if (parent.id === task.id) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} cannot be its own parent`);
    if (parent.parentId !== undefined) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.parentId} is itself a subtask, so ${task.id} cannot sit under it`);
    // A parent is done only after its subtasks, so a subtask that waited for its parent (or the parent for it) could never finish.
    if (task.dependsOn.includes(parent.id) || parent.dependsOn.includes(task.id)) throw new BrainDomainError("INVALID_ARGUMENT", `plan tasks ${parent.id} and ${task.id} are parent and subtask and cannot depend on each other`);
  }
  // A parent finishes after its subtasks, so they are implicit dependencies of it: a cycle through that edge is a deadlock too.
  const waitsFor = (task: PlanTask): readonly string[] => [...task.dependsOn, ...tasks.filter((other) => other.parentId === task.id).map((other) => other.id)];
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, waitsFor(task).length);
    dependents.set(task.id, []);
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} depends on unknown task ${dependency}`);
    }
  }
  for (const task of tasks) for (const dependency of waitsFor(task)) dependents.get(dependency)?.push(task.id);
  const ready = tasks.filter((task) => waitsFor(task).length === 0).map((task) => task.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    order.push(id);
    for (const dependent of dependents.get(id)?.sort() ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== tasks.length) throw new BrainDomainError("INVALID_ARGUMENT", "plan dependencies contain a cycle");
  return order;
}
