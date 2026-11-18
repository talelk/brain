import type { FailureBucket, InsightDays, Role, TaskState } from "@brain/contracts";

/**
 * The few values of the model the screens enumerate. They are written here, typed by the contract, because importing values from
 * `@brain/contracts` would pull its hashing code (node:crypto) into the browser bundle.
 */
export const TASK_STATES = ["needs_you", "running", "ready", "waiting", "done", "failed", "stopped"] as const satisfies readonly TaskState[];
export const ROLES = ["viewer", "member", "admin"] as const satisfies readonly Role[];
export const roleAtLeast = (have: Role, need: Role): boolean => ROLES.indexOf(have) >= ROLES.indexOf(need);
export const INSIGHT_DAYS = [7, 30, 90] as const satisfies readonly InsightDays[];
export const FAILURE_BUCKETS = ["limits", "setup", "engine", "checks", "other"] as const satisfies readonly FailureBucket[];
export const EFFECTS = ["read", "write", "privileged"] as const;
export const NATIVE_LEVELS = ["none", "read", "all"] as const;
export const ENGINES = ["pi", "claude"] as const;
export { isSlug, slugify, slugifyTool } from "@brain/contracts/slug";
