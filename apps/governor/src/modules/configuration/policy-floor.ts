import { isolationRank, ISOLATION_LEVELS, type JsonValue } from "@brain/contracts";
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

const SAFEGUARD_FIELDS = new Set(["productionHumanApproval", "defaultEffect", "separationOfDuties", "minimumIsolation"]);

export interface PolicyResolution {
  /**
   * What holds after the merge. `allowedOperations` is null when no layer wrote a non-empty list (an empty list states no allow-list), and
   * an empty array when lists were written and nothing is left of them: only the first allows everything, only the second nothing.
   * `maxRuntimeSeconds` is null when no layer set one.
   */
  readonly effective: {
    readonly productionHumanApproval: string;
    readonly defaultEffect: string;
    readonly allowedOperations: readonly string[] | null;
    readonly deniedOperations: readonly string[];
    readonly maxMicroUsd: number;
    readonly maxRuntimeSeconds: number | null;
    readonly minimumIsolation: string;
    readonly separationOfDuties: boolean;
  };
  /** The layer that decided each field: the one whose value is the one in force (the first layer to reach a tie). */
  readonly provenance: Readonly<Record<string, string>>;
  /** The layer that first denied each denied operation. */
  readonly denials: Readonly<Record<string, string>>;
  /** Each layer's own non-empty allow-list, in layer order: a refusal names the first layer whose list leaves an operation out. */
  readonly allowLists: readonly { readonly layer: string; readonly operations: readonly string[] }[];
  /** The layers merged, in order. */
  readonly layers: readonly string[];
}

export type EffectivePolicy = PolicyResolution;

function stricter(a: string, b: string, path: string): string {
  if (isolationRank(a) < 0 || isolationRank(b) < 0) throw new BrainDomainError("INVALID_CONTRACT", `${path}: incomparable isolation ${a}/${b}; use one of ${ISOLATION_LEVELS.join(", ")}`);
  return isolationRank(b) > isolationRank(a) ? b : a;
}

export function mergePolicyFloor(layers: readonly { name: string; spec: PolicySpec }[]): PolicyResolution {
  if (layers.length === 0) throw new BrainDomainError("INVALID_CONTRACT", "policy floor requires at least one layer");
  const provenance: Record<string, string> = {};
  const denials: Record<string, string> = {};
  const allowLists: { layer: string; operations: string[] }[] = [];
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
      provenance["productionHumanApproval"] ??= layer.name;
    }
    if (layer.spec.defaultEffect !== undefined) {
      if (layer.spec.defaultEffect !== "deny") {
        throw new BrainDomainError("INVALID_CONTRACT", `${layer.name}: defaultEffect cannot broaden beyond deny`);
      }
      provenance["defaultEffect"] ??= layer.name;
    }
    // An empty list states no allow-list; two lists that share nothing leave an allow-list that allows nothing.
    if (layer.spec.allowedOperations !== undefined && layer.spec.allowedOperations.length > 0) {
      const next = new Set(layer.spec.allowedOperations);
      allowed = allowed === undefined ? next : new Set([...allowed].filter((x) => next.has(x)));
      allowLists.push({ layer: layer.name, operations: [...next].sort() });
      provenance["allowedOperations"] = layer.name;
    }
    if (layer.spec.deniedOperations !== undefined) {
      for (const op of layer.spec.deniedOperations) {
        if (!denied.has(op)) denials[op] = layer.name;
        denied.add(op);
      }
      if (layer.spec.deniedOperations.length > 0) provenance["deniedOperations"] = layer.name;
    }
    if (layer.spec.maxMicroUsd !== undefined) {
      if (layer.spec.maxMicroUsd < maxMicroUsd) { maxMicroUsd = layer.spec.maxMicroUsd; provenance["maxMicroUsd"] = layer.name; }
    }
    if (layer.spec.maxRuntimeSeconds !== undefined) {
      if (layer.spec.maxRuntimeSeconds < maxRuntimeSeconds) { maxRuntimeSeconds = layer.spec.maxRuntimeSeconds; provenance["maxRuntimeSeconds"] = layer.name; }
    }
    if (layer.spec.minimumIsolation !== undefined) {
      const raised = stricter(isolation, layer.spec.minimumIsolation, layer.name);
      // The layer that raised the minimum is the one named; a layer that states the level already in force, or a weaker one, changes nothing.
      if (raised !== isolation || provenance["minimumIsolation"] === undefined) provenance["minimumIsolation"] = layer.name;
      isolation = raised;
    }
    if (layer.spec.separationOfDuties !== undefined) {
      // The layer that first requires separation of duties is the one named; before any does, the first layer that states the field.
      if (layer.spec.separationOfDuties === true && !sod) provenance["separationOfDuties"] = layer.name;
      else provenance["separationOfDuties"] ??= layer.name;
      sod = sod || layer.spec.separationOfDuties === true;
    }
  }
  const effectiveAllowed = allowed === undefined ? null : [...allowed].filter((op) => !denied.has(op)).sort();
  return {
    effective: {
      productionHumanApproval: approval,
      defaultEffect,
      allowedOperations: effectiveAllowed,
      deniedOperations: [...denied].sort(),
      maxMicroUsd: Number.isFinite(maxMicroUsd) ? maxMicroUsd : 0,
      maxRuntimeSeconds: Number.isFinite(maxRuntimeSeconds) ? maxRuntimeSeconds : null,
      minimumIsolation: isolation,
      separationOfDuties: sod,
    },
    provenance,
    denials,
    allowLists,
    layers: layers.map((layer) => layer.name),
  };
}

/** What a release stores as its effective policy: the merge result as plain JSON, pinned with the release digest. */
export function storedPolicy(resolution: PolicyResolution): JsonValue {
  return JSON.parse(JSON.stringify(resolution)) as JsonValue;
}

/** A refusal the policy makes: which layer and which field caused it, and a plain sentence that names both. */
export interface PolicyRefusal {
  readonly layer: string;
  readonly field: string;
  readonly message: string;
}

/** Whether an operation (a tool id) may run: refused when a layer denies it, or when the allow-lists leave it out. */
export function operationRefusal(policy: EffectivePolicy, operation: string): PolicyRefusal | undefined {
  const denier = policy.denials[operation];
  if (denier !== undefined) {
    return { layer: denier, field: "deniedOperations", message: `Policy ${denier} denies the operation ${operation} (deniedOperations)` };
  }
  const allowed = policy.effective.allowedOperations;
  if (allowed !== null && !allowed.includes(operation)) {
    const excluding = policy.allowLists.find((list) => !list.operations.includes(operation))?.layer ?? policy.provenance["allowedOperations"] ?? policy.layers[0] ?? "policy";
    return { layer: excluding, field: "allowedOperations", message: `Policy ${excluding} does not allow the operation ${operation} (allowedOperations)` };
  }
  return undefined;
}

/** The runtime cap in seconds and the layer that set it, when one is set. */
export function runtimeCap(policy: EffectivePolicy): { seconds: number; layer: string } | undefined {
  const seconds = policy.effective.maxRuntimeSeconds;
  return seconds === null ? undefined : { seconds, layer: policy.provenance["maxRuntimeSeconds"] ?? policy.layers[0] ?? "policy" };
}

/** The effective policy a release stores, if it carries one. */
export function policyOf(release: { manifest?: Record<string, unknown> } | undefined): EffectivePolicy | undefined {
  const stored = release?.manifest?.["effectivePolicy"];
  return stored && typeof stored === "object" ? stored as unknown as EffectivePolicy : undefined;
}

/** True for an environment the policy treats as production: `production` or `prod`, alone or with a suffix such as `production-eu`. */
export function isProductionEnvironment(environmentId: string): boolean {
  const name = environmentId.toLowerCase();
  return ["production", "prod"].some((base) => name === base || (name.startsWith(base) && "-_.:".includes(name.charAt(base.length))));
}
