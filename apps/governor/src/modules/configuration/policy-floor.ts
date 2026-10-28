import { BrainDomainError } from "../../domain/errors";

// Typed restrictive intersection for the security floor (doc 03):
// allowlists intersect, deny lists union, safeguard booleans OR together,
// numeric upper limits take the minimum, minimum isolation takes the stricter
// order. A null is a value only where the schema permits it; on safeguard
// fields it is never a disable. Unknown/incomparable overrides fail.
export interface PolicySpec {
  readonly productionHumanApproval?: string;
  readonly defaultEffect?: string;
  readonly allowedOperations?: readonly string[];
  readonly deniedOperations?: readonly string[];
  readonly maxMicroUsd?: number;
  readonly maxRuntimeSeconds?: number;
  readonly minimumIsolation?: string;
  readonly separationOfDuties?: boolean;
}

const ISOLATION_ORDER = ["none", "process", "ephemeral-container", "microvm", "vm"] as const;
const SAFEGUARD_FIELDS = new Set(["productionHumanApproval", "defaultEffect", "separationOfDuties", "minimumIsolation"]);

export interface PolicyResolution {
  readonly effective: Required<PolicySpec>;
  readonly provenance: Readonly<Record<string, string>>;
}

function stricterIsolation(a: string, b: string, path: string): string {
  const ia = ISOLATION_ORDER.indexOf(a as (typeof ISOLATION_ORDER)[number]);
  const ib = ISOLATION_ORDER.indexOf(b as (typeof ISOLATION_ORDER)[number]);
  if (ia < 0 || ib < 0) throw new BrainDomainError("INVALID_CONTRACT", `${path}: incomparable isolation ${a}/${b}`);
  return ISOLATION_ORDER[Math.max(ia, ib)] ?? a;
}

export function mergePolicyFloor(layers: readonly { name: string; spec: PolicySpec }[]): PolicyResolution {
  if (layers.length === 0) throw new BrainDomainError("INVALID_CONTRACT", "policy floor requires at least one layer");
  const provenance: Record<string, string> = {};
  let allowed: Set<string> | undefined;
  const denied = new Set<string>();
  const approval = "required";
  const defaultEffect = "deny";
  let maxMicroUsd = Number.POSITIVE_INFINITY;
  let maxRuntimeSeconds = Number.POSITIVE_INFINITY;
  let isolation = "ephemeral-container";
  let sod = false;
  for (const layer of layers) {
    const spec = layer.spec as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(spec)) {
      if (value === null && SAFEGUARD_FIELDS.has(field)) {
        throw new BrainDomainError("INVALID_CONTRACT", `${layer.name}: null cannot disable safeguard ${field}`);
      }
    }
    if (layer.spec.productionHumanApproval !== undefined) {
      if (layer.spec.productionHumanApproval !== "required" && approval === "required") {
        throw new BrainDomainError("INVALID_CONTRACT", `${layer.name}: override cannot turn off production human approval`);
      }
      provenance["productionHumanApproval"] = layer.name;
    }
    if (layer.spec.defaultEffect !== undefined) {
      if (layer.spec.defaultEffect !== "deny") {
        throw new BrainDomainError("INVALID_CONTRACT", `${layer.name}: defaultEffect cannot broaden beyond deny`);
      }
      provenance["defaultEffect"] = layer.name;
    }
    if (layer.spec.allowedOperations !== undefined) {
      const next = new Set(layer.spec.allowedOperations);
      allowed = allowed === undefined ? next : new Set([...allowed].filter((x) => next.has(x)));
      provenance["allowedOperations"] = layer.name;
    }
    if (layer.spec.deniedOperations !== undefined) {
      for (const op of layer.spec.deniedOperations) denied.add(op);
      provenance["deniedOperations"] = layer.name;
    }
    if (layer.spec.maxMicroUsd !== undefined) {
      if (layer.spec.maxMicroUsd < maxMicroUsd) { maxMicroUsd = layer.spec.maxMicroUsd; provenance["maxMicroUsd"] = layer.name; }
    }
    if (layer.spec.maxRuntimeSeconds !== undefined) {
      if (layer.spec.maxRuntimeSeconds < maxRuntimeSeconds) { maxRuntimeSeconds = layer.spec.maxRuntimeSeconds; provenance["maxRuntimeSeconds"] = layer.name; }
    }
    if (layer.spec.minimumIsolation !== undefined) {
      isolation = stricterIsolation(isolation, layer.spec.minimumIsolation, layer.name);
      provenance["minimumIsolation"] = layer.name;
    }
    if (layer.spec.separationOfDuties !== undefined) {
      sod = sod || layer.spec.separationOfDuties === true;
      provenance["separationOfDuties"] = layer.name;
    }
  }
  const effectiveAllowed = [...(allowed ?? new Set<string>())].filter((op) => !denied.has(op)).sort();
  return {
    effective: {
      productionHumanApproval: approval,
      defaultEffect,
      allowedOperations: effectiveAllowed,
      deniedOperations: [...denied].sort(),
      maxMicroUsd: Number.isFinite(maxMicroUsd) ? maxMicroUsd : 0,
      maxRuntimeSeconds: Number.isFinite(maxRuntimeSeconds) ? maxRuntimeSeconds : 120,
      minimumIsolation: isolation,
      separationOfDuties: sod,
    },
    provenance,
  };
}
