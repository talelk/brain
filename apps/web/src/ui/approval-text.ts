import type { ApprovalRequest } from "@brain/contracts";

/** The plain-words reading of an approval request, shared by the approvals screens and the Needs you queue. */
export const effectParts = (approval?: ApprovalRequest) => ({
  operation: approval?.subject.operation ?? "Requested effect",
  target: approval?.subject.target.targetId ?? "Declared record",
  environment: approval?.subject.target.environmentId,
  tool: approval?.subject.tool?.id ?? "Declared capability",
  precondition: approval?.subject.target.preconditionDigest,
});
/** One plain sentence saying what approving allows. */
export const plainSentence = (approval?: ApprovalRequest) => {
  const effect = effectParts(approval);
  // "support.reply.publish" reads as "Publish support reply": last segment is the verb, the rest the thing.
  const words = effect.operation.split(/[._:\-/]+/u).filter(Boolean);
  const verb = words.pop() ?? "Run";
  const what = words.join(" ");
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${what ? ` ${what}` : ""} on ${effect.target}${effect.environment ? ` in ${effect.environment}` : ""}.`;
};
/** The dialog keeps the exact operation id beside the sentence. */
export const dialogSummary = (approval?: ApprovalRequest) => `${plainSentence(approval)} (${effectParts(approval).operation})`;
export const exactJson = (approval?: ApprovalRequest) => JSON.stringify(approval?.subject ?? null, null, 2);
