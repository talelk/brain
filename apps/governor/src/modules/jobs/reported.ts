import type { EngineInfo } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";

/**
 * What a runner reports about itself, kept exactly as reported (never filled in) and checked only for shape. The runner's own words are
 * never evidence of trust; they are what the Runners page shows, labelled as reported.
 */

/** A runner clock this far ahead of the Governor's is a fault to surface, not an observation to store. */
const CLOCK_SKEW_MS = 60_000;
const MAX_ENGINES = 20;

/** A runner-reported observation time as epoch ms. A missing, malformed or future time is refused: the Governor never substitutes its own. */
export function reportedObservedMs(raw: unknown, nowMs: number): number {
  const ms = typeof raw === "string" && raw.length <= 40 ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(ms)) throw new BrainDomainError("INVALID_CONTRACT", "a capability observation must state when the runner observed it");
  if (ms > nowMs + CLOCK_SKEW_MS) throw new BrainDomainError("INVALID_CONTRACT", "a capability observation is dated in the future");
  return ms;
}

const ENGINE_ID = /^[a-z][a-z0-9.-]{0,63}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

/** The engines a runner reported: each with its own digest and features, and a version only when the runner stated one. */
export function reportedEngines(raw: unknown): EngineInfo[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ENGINES) throw new BrainDomainError("INVALID_CONTRACT", "engines must be a short list");
  return raw.map((entry): EngineInfo => {
    const engine = (entry ?? {}) as Record<string, unknown>;
    const { id, version, adapterDigest, features } = engine;
    if (typeof id !== "string" || !ENGINE_ID.test(id)) throw new BrainDomainError("INVALID_CONTRACT", "an engine report needs an engine id");
    if (typeof adapterDigest !== "string" || !DIGEST.test(adapterDigest) || adapterDigest === PLACEHOLDER_DIGEST) {
      throw new BrainDomainError("INVALID_CONTRACT", `engine ${id} must report the digest of its adapter, not a placeholder`);
    }
    if (version !== undefined && (typeof version !== "string" || version.length === 0 || version.length > 64))
      throw new BrainDomainError("INVALID_CONTRACT", `engine ${id} reports a malformed version`);
    if (
      !Array.isArray(features) ||
      features.length > 64 ||
      features.some((feature) => typeof feature !== "string" || feature.length === 0 || feature.length > 64)
    ) {
      throw new BrainDomainError("INVALID_CONTRACT", `engine ${id} reports malformed features`);
    }
    return { id, ...(version === undefined ? {} : { version }), adapterDigest, features: [...new Set(features as string[])] };
  });
}
