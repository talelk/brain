import type { AutonomyPolicy, AutonomyPreset, PlanOperation, PlanTask } from "@brain/contracts";
import { BrainDomainError } from "./errors";

/** Expanded operation lists behind each autonomy preset (issue #35). */
export const AUTONOMY_PRESETS: Readonly<Record<AutonomyPreset, readonly PlanOperation[]>> = {
  supervised: ["conflictTask.create"],
  standard: ["task.add", "task.change", "task.remove", "task.reassign", "member.addExistingRole", "decision.accept", "conflictTask.create"],
  autonomous: ["task.add", "task.change", "task.remove", "task.reassign", "member.addExistingRole", "member.addNewRole", "decision.accept", "conflictTask.create", "backlog.drop"],
};

export function policyFor(preset: AutonomyPreset, version: number): AutonomyPolicy {
  return { preset, operations: [...AUTONOMY_PRESETS[preset]], version };
}

/** Plan-version diff against the confirmed version, with the affected branch (issue #39). */
export interface PlanDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly reassigned: readonly string[];
  /** Changed, added and removed tasks plus everything downstream of them in either version. */
  readonly affected: readonly string[];
  /** Operations a coordinator would need the autonomy policy to permit. */
  readonly operations: readonly PlanOperation[];
}

const content = (task: PlanTask) => JSON.stringify({ title: task.title, criteria: task.criteria, dependsOn: [...task.dependsOn].sort(), workflowId: task.workflowId ?? null, optional: task.optional ?? false });

function downstream(tasks: readonly PlanTask[], roots: ReadonlySet<string>): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]);
  const out = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of dependents.get(id) ?? []) if (!out.has(next)) { out.add(next); queue.push(next); }
  }
  return out;
}

/**
 * Compares a proposed plan version with the confirmed one. Started tasks
 * (work already running, under review, blocked or done) must stay identical:
 * a version whose affected branch reaches one is rejected for every author,
 * because started work is never interrupted by replanning.
 */
export function diffPlan(confirmed: readonly PlanTask[], proposed: readonly PlanTask[], started: ReadonlySet<string>): PlanDiff {
  const before = new Map(confirmed.map((task) => [task.id, task]));
  const after = new Map(proposed.map((task) => [task.id, task]));
  const added = proposed.filter((task) => !before.has(task.id)).map((task) => task.id).sort();
  const removed = confirmed.filter((task) => !after.has(task.id)).map((task) => task.id).sort();
  const changed: string[] = []; const reassigned: string[] = [];
  for (const task of proposed) {
    const prior = before.get(task.id);
    if (!prior) continue;
    if (content(prior) !== content(task)) changed.push(task.id);
    else if (JSON.stringify(prior.assignment ?? null) !== JSON.stringify(task.assignment ?? null)) reassigned.push(task.id);
  }
  changed.sort(); reassigned.sort();
  const roots = new Set([...added, ...removed, ...changed]);
  const affected = new Set([...downstream(confirmed, roots), ...downstream(proposed, roots), ...reassigned]);
  // A started task downstream of a change implies its upstream is started too (dependencies finish first), so checking the roots suffices.
  const touched = [...roots, ...reassigned].filter((id) => started.has(id));
  if (touched.length > 0) throw new BrainDomainError("CONFLICT", `plan version changes started work: ${touched.sort().join(", ")}`);
  const operations = new Set<PlanOperation>();
  if (added.length > 0) operations.add("task.add");
  if (changed.length > 0) operations.add("task.change");
  if (reassigned.length > 0) operations.add("task.reassign");
  for (const id of removed) operations.add(before.get(id)?.optional ? "task.remove" : "backlog.drop");
  return { added, removed, changed, reassigned, affected: [...affected].sort(), operations: [...operations].sort() };
}

/** Operations a plan diff needs that the policy does not grant. */
export function beyondPolicy(diff: PlanDiff, policy: AutonomyPolicy): readonly PlanOperation[] {
  return diff.operations.filter((operation) => !policy.operations.includes(operation));
}
