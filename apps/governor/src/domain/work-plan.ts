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
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} depends on unknown task ${dependency}`);
    }
  }
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency)?.push(task.id);
  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort();
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
