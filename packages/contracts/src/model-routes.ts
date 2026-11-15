/**
 * Model routes (ADR 0055): a workspace's ordered list of hosted models. A route names a place, a model, two prices and a key by reference;
 * the key itself lives in the environment of whoever calls (the runner, or the Governor for the advisory judge), never in a job or an event.
 */
export const COST_TIERS = ["low", "standard", "premium"] as const;
export type CostTier = (typeof COST_TIERS)[number];

/** Cheaper to dearer: an agent that names a cost tier takes routes of that tier or a cheaper one. */
export const costTierRank = (tier: CostTier): number => COST_TIERS.indexOf(tier);

export const MAX_MODEL_ROUTES = 8;
/** A route's name and its key reference are short slugs: a pasted secret or an arbitrary variable name is not one. */
export const ROUTE_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
export const KEY_REFERENCE = /^[a-z][a-z0-9-]{0,31}$/u;
/** Anything that looks like a vendor secret is refused as a reference even when it would fit the slug. */
export const LOOKS_LIKE_SECRET = /^(?:sk|pk|key|token|secret|bearer)-|[0-9]{8,}/iu;

export function isKeyReference(value: string): boolean {
  return KEY_REFERENCE.test(value) && !LOOKS_LIKE_SECRET.test(value);
}

/** The one environment variable a key reference resolves to: a fixed prefix, so a reference can never name another secret of the host. */
export function modelKeyEnvName(keyRef: string): string {
  return `BRAIN_MODEL_KEY_${keyRef.toUpperCase().replace(/-/gu, "_")}`;
}

/** The key of a reference from the given environment, or undefined when the host has none set. */
export function resolveModelKey(keyRef: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  if (!isKeyReference(keyRef)) return undefined;
  const key = env[modelKeyEnvName(keyRef)];
  return key ? key : undefined;
}
