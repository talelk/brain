import type { PlaySpec } from "@brain/contracts";
import { query } from "./client";

/** A reviewable description of an achieved mission's confirmed plan, team and criteria, offered as a Play (ADR 0015). */
export interface PlayProposal {
  proposalId: string;
  missionId: string;
  missionTitle: string;
  state: "proposed" | "approved" | "rejected";
  playId: string;
  spec: PlaySpec;
  proposedBy: string;
  proposedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reason?: string;
  draftId?: string;
  selfReviewed?: boolean;
}

export async function listPlayProposals(workspaceId: string, signal?: AbortSignal): Promise<{ snapshot: PlayProposal[]; asOf: string; sourceWatermark: number }> {
  const response = await query<{ snapshot: { items: PlayProposal[] }; asOf: string; sourceWatermark: number }>({ queryType: "playProposals.list", workspaceId }, signal);
  return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
}
