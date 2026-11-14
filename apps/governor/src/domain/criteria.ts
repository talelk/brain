import type { CriterionId, MissionCriterion, PlanTask } from "@brain/contracts";
import { BrainDomainError } from "./errors";

/** A success criterion as stored: a stable id (`c1`, `c2`, by position at creation, never renumbered or reused) and its words (ADR 0034). */
export interface StoredCriterion { readonly id: CriterionId; readonly text: string }

/** The stored list for criteria a person or a Play wrote as plain text, in order. */
export function criteriaFromText(texts: readonly string[]): StoredCriterion[] {
  return texts.map((text, index) => ({ id: `c${index + 1}`, text }));
}

/** Reads `missions.success_criteria_json`. Every reader goes through here so the stored shape has one parser. */
export function parseCriteria(json: string): StoredCriterion[] {
  return JSON.parse(json) as StoredCriterion[];
}

/** The words of a mission's criteria, in order, for prompts, drafts and write-ups. */
export function criteriaText(json: string): string[] {
  return parseCriteria(json).map((criterion) => criterion.text);
}

/** A task names only criteria its mission has: an unknown id is refused rather than shown as work that serves nothing. */
export function assertServedCriteria(tasks: readonly Pick<PlanTask, "id" | "criterionIds">[], known: ReadonlySet<string>): void {
  for (const task of tasks) {
    const unknown = (task.criterionIds ?? []).filter((id) => !known.has(id));
    if (unknown.length > 0) throw new BrainDomainError("INVALID_ARGUMENT", `plan task ${task.id} serves unknown success criterion ${unknown.join(", ")}`);
  }
}

/**
 * Where each criterion stands: covered when at least one task of the confirmed plan serves it and every serving task is done. A
 * criterion no task serves has `serving.total` 0, which is different from work that is not finished yet.
 */
export function criteriaCoverage(criteria: readonly StoredCriterion[], planTasks: readonly Pick<PlanTask, "id" | "criterionIds">[], doneTaskIds: ReadonlySet<string>): MissionCriterion[] {
  return criteria.map((criterion) => {
    const serving = planTasks.filter((task) => (task.criterionIds ?? []).includes(criterion.id));
    const done = serving.filter((task) => doneTaskIds.has(task.id)).length;
    return { criterionId: criterion.id, text: criterion.text, state: serving.length > 0 && done === serving.length ? "covered" : "not-covered", serving: { total: serving.length, done } };
  });
}
