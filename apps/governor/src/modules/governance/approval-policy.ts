import type { ActionSubject } from "@brain/contracts";
import type { Store } from "../../application/store";
import { activeReleaseRecord, isProductionEnvironment, policyForRelease, policyOf, type EffectivePolicy, type PolicyRefusal } from "../configuration/index";

/**
 * What the release's effective policy asks of the person who decides an approval (ADR 0064). One named hook, called where a decision is
 * made; it adds to the rules that always hold (a human session decides, and never the one who asked) and never replaces them.
 *
 * - productionHumanApproval: a change that targets a production environment is decided by a person, never by a machine principal.
 * - separationOfDuties: the approver is not the author of the work (whoever started the run it came from) and not the owner of the
 *   mission it serves, even where the owner would otherwise decide their own mission's call.
 *
 * The policy is read from the release the approval's subject is pinned to and from the organization's active release; the stricter
 * answer holds, so naming an older release never loosens it.
 */
export interface Approver { readonly actorId: string; readonly kind: string }

function policiesFor(s: Store, subject: ActionSubject): EffectivePolicy[] {
  return [policyForRelease(s, subject.organizationId, subject.configDigest), policyOf(activeReleaseRecord(s, subject.organizationId)?.release)]
    .filter((policy): policy is EffectivePolicy => policy !== undefined);
}

/** Who started the run an approval came from, and the owner of the mission it serves: the people who may not approve it under separation of duties. */
function workOrigin(s: Store, subject: ActionSubject): string[] {
  if (!subject.origin) return [];
  const ws = s.workspaceDb(subject.workspaceId, subject.organizationId);
  const author = ws.prepare("SELECT actor_id FROM run_inputs WHERE run_id=?").get(subject.origin.runId) as { actor_id: string } | undefined;
  const owner = subject.origin.missionId ? ws.prepare("SELECT owner_id FROM missions WHERE id=?").get(subject.origin.missionId) as { owner_id: string } | undefined : undefined;
  return [author?.actor_id, owner?.owner_id].filter((id): id is string => typeof id === "string");
}

/** The refusal the policy makes of this approver deciding this subject, naming the layer and field; undefined when it allows the decision. */
export function approvalPolicyProblem(s: Store, subject: ActionSubject, approver: Approver): PolicyRefusal | undefined {
  for (const policy of policiesFor(s, subject)) {
    if (policy.effective.productionHumanApproval === "required" && isProductionEnvironment(subject.target.environmentId) && approver.kind !== "human") {
      const layer = policy.provenance["productionHumanApproval"] ?? policy.layers[0] ?? "policy";
      return { layer, field: "productionHumanApproval", message: `Policy ${layer} requires a person to approve a change to the production environment ${subject.target.environmentId}, not a machine principal (productionHumanApproval)` };
    }
    if (policy.effective.separationOfDuties && workOrigin(s, subject).includes(approver.actorId)) {
      const layer = policy.provenance["separationOfDuties"] ?? policy.layers[0] ?? "policy";
      return { layer, field: "separationOfDuties", message: `Policy ${layer} requires a different person to approve: you started this work or own its mission (separationOfDuties)` };
    }
  }
  return undefined;
}
