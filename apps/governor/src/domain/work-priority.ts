import type { WorkItemPriority } from "@brain/contracts";
import { BrainDomainError } from "./errors";

/**
 * Work-item priority as the job priority the claim sorts on (jobs.priority is 0..3). Work no work item asked for (a chat, a schedule, a
 * coordinator turn) is normal, so a low item yields to it and an urgent one does not.
 */
export const JOB_PRIORITY: Readonly<Record<WorkItemPriority, number>> = { low: 0, normal: 1, high: 2, urgent: 3 };
export const NORMAL_JOB_PRIORITY = JOB_PRIORITY.normal;

export const MAX_TAGS = 10;

/** Tags are lower-cased, trimmed and unique, so "Billing" and "billing " are one tag; an empty one is refused. */
export function normalizeTags(raw: readonly unknown[]): string[] {
  const tags = new Set<string>();
  for (const entry of raw) {
    const tag = String(entry).trim().toLowerCase();
    if (!tag) throw new BrainDomainError("INVALID_ARGUMENT", "a tag cannot be empty");
    tags.add(tag);
  }
  if (tags.size > MAX_TAGS) throw new BrainDomainError("INVALID_ARGUMENT", `a work item takes at most ${MAX_TAGS} tags`);
  return [...tags];
}
