import type { Delegation } from "@brain/contracts";
import type { MessageKey } from "../../i18n";

/** How deep a delegation goes at most (ADR 0049); the Governor enforces it, the screen only says it. */
export const MISSION_DEPTH_LIMIT = 3;

export type DelegationStatus = "working" | "to-review" | "accepted" | "rejected" | "failed";

/** Where a delegation stands for a person: a decided review wins, then a failed run, then a finished one waiting for its review. */
export function delegationStatus(item: Pick<Delegation, "state" | "run">): DelegationStatus {
  if (item.state === "accepted" || item.state === "rejected") return item.state;
  if (item.run.state === "failed") return "failed";
  return item.run.state === "succeeded" ? "to-review" : "working";
}

/** Accepting rests on evidence an independent check verified; rejecting never does. */
export function canAccept(item: Pick<Delegation, "evidence">): boolean {
  return item.evidence?.bundleState === "verified" && item.evidence.verdict === "verified";
}

export function evidenceVerdictKey(evidence: NonNullable<Delegation["evidence"]>): MessageKey {
  if (evidence.verdict === "verified") return "delegations.verdict.verified";
  if (evidence.verdict === "rejected") return "delegations.verdict.rejected";
  if (evidence.verdict === "incomplete") return "delegations.verdict.incomplete";
  return "delegations.verdict.none";
}

export const STATUS_KEY: Readonly<Record<DelegationStatus, MessageKey>> = {
  working: "delegations.status.working", "to-review": "delegations.status.to-review", accepted: "delegations.status.accepted", rejected: "delegations.status.rejected", failed: "delegations.status.failed",
};
