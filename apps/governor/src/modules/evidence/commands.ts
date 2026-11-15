import type { CheckResult, VerificationVerdict } from "@brain/contracts";
import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import type { EvidenceService } from "./service";

/**
 * evaluation.attest: a person records the verdict of an independence-L3 evaluation as its evaluator (ADR 0069). Human only. The service
 * refuses the people whose work it is; a retry of the same attestation finishes its projection and changes nothing else.
 */
export function evidenceCommands(evidence: EvidenceService, hooks: { verified(organizationId: string, workspaceId: string, bundleDigest: string): void }): CommandHandlers {
  return handlersFor(["evaluation.attest"], {
    kind: "self",
    handle: ({ actor, cmd, workspaceId }) => {
      const payload = cmd.payload as { attestationId: string; bundleDigests: string[]; outcome: VerificationVerdict["outcome"]; checks: Array<{ checkId: string; status: CheckResult["status"]; detail: string }> };
      const result = evidence.attest(actor, workspaceId, payload);
      for (const digest of result.verified) hooks.verified(actor.organizationId, workspaceId, digest);
      return { resourceId: payload.attestationId };
    },
  });
}
