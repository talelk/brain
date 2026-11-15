import type { Store } from "../../application/store";
import { operationRefusal, policyOf, runtimeCap, type EffectivePolicy, type PolicyRefusal } from "./policy-floor";
import { releaseRecord, type ReleaseRecord } from "./releases";

/**
 * Reading a release's effective policy where work is admitted and where an approval is decided (ADR 0067). The policy was merged and
 * pinned when the release compiled; nothing here merges again, so a refusal names the layer the stored merge names.
 */

/** The effective policy of the release a piece of work is pinned to, when that release has Policy documents. */
export function policyForRelease(s: Store, organizationId: string, configDigest: string): EffectivePolicy | undefined {
  return policyOf(releaseRecord(s, organizationId, configDigest)?.release);
}

interface StepShape { readonly kind?: string; readonly uses?: { readonly type?: string; readonly release?: { readonly id: string } }; readonly evaluator?: { readonly id: string } }

/**
 * The operations a step performs: the tool of a tool step, every tool its agent may call (an agent can call any of them), and the tool
 * of the evaluator an eval step runs. A step that runs no tool (a gate, a subgraph, a steer) performs none.
 */
export function stepOperations(release: ReleaseRecord["release"], step: StepShape): string[] {
  if (step.kind === "eval" && step.evaluator) {
    const tool = release.evaluators?.[step.evaluator.id]?.spec.tool.id;
    return tool ? [tool] : [];
  }
  // A tool's own self-test runs under the reserved id selftest.<tool>; the policy judges the tool it tests.
  if (step.uses?.type === "tool" && step.uses.release) return [step.uses.release.id.replace(/^selftest\./u, "")];
  if (step.uses?.type === "agent" && step.uses.release) return (release.agents?.[step.uses.release.id]?.spec.tools ?? []).map((tool) => tool.id);
  return [];
}

/** The first operation of the step the policy refuses, with the layer and field that refuse it. */
export function stepAdmissionRefusal(s: Store, organizationId: string, configDigest: string, step: StepShape): PolicyRefusal | undefined {
  const record = releaseRecord(s, organizationId, configDigest);
  const policy = policyOf(record?.release);
  if (!record || !policy) return undefined;
  for (const operation of stepOperations(record.release, step)) {
    const refusal = operationRefusal(policy, operation);
    if (refusal) return refusal;
  }
  return undefined;
}

/** The refusal of one operation (an effect tool) under the release's policy. */
export function operationAdmissionRefusal(s: Store, organizationId: string, configDigest: string, operation: string): PolicyRefusal | undefined {
  const policy = policyForRelease(s, organizationId, configDigest);
  return policy ? operationRefusal(policy, operation) : undefined;
}

/** The attempt time allowed: the step's own timeout, never more than the policy's cap (the cap also applies to a step that declares none). */
export function allowedRuntime(s: Store, organizationId: string, configDigest: string, stepTimeoutSeconds: number | undefined): { seconds: number; capped: { layer: string } | undefined } | undefined {
  const policy = policyForRelease(s, organizationId, configDigest);
  const cap = policy ? runtimeCap(policy) : undefined;
  if (!cap) return stepTimeoutSeconds === undefined ? undefined : { seconds: stepTimeoutSeconds, capped: undefined };
  if (stepTimeoutSeconds !== undefined && stepTimeoutSeconds <= cap.seconds) return { seconds: stepTimeoutSeconds, capped: undefined };
  return { seconds: cap.seconds, capped: { layer: cap.layer } };
}
