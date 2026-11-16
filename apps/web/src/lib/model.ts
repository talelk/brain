import type { Role, TaskState } from "@brain/contracts";

/**
 * The few values of the model the screens enumerate. They are written here, typed by the contract, because importing values from
 * `@brain/contracts` would pull its hashing code (node:crypto) into the browser bundle.
 */
export const TASK_STATES = ["needs_you", "running", "ready", "waiting", "done", "failed", "stopped"] as const satisfies readonly TaskState[];
export const ROLES = ["viewer", "member", "admin"] as const satisfies readonly Role[];
export const roleAtLeast = (have: Role, need: Role): boolean => ROLES.indexOf(have) >= ROLES.indexOf(need);
export const EFFECTS = ["read", "write", "privileged"] as const;
export const NATIVE_LEVELS = ["none", "read", "all"] as const;
export const ENGINES = ["pi", "claude"] as const;
export const isSlug = (name: string): boolean => /^[a-z][a-z0-9-]{0,62}$/u.test(name);
/** A name a person typed, as the lower-case, dashed name a file or an address needs. */
export const slugify = (text: string): string => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^[^a-z]+|-+$/gu, "").slice(0, 63);
