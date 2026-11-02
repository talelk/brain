import type { ArtifactDiffResult, ArtifactHistory, ArtifactRef } from "@brain/contracts";
import { fetchView } from "./governor";

/**
 * The Output Browser's typed reads (T61): authorized generated artifacts with
 * previews, diffs and version history. Wire shapes are the generated contracts
 * (ArtifactRef, ArtifactHistory, ArtifactDiffResult) implemented by brain.ts.
 */

export type { ArtifactDiffResult, ArtifactHistory, ArtifactRef };
export type ArtifactVersion = ArtifactHistory["history"][number];
export type DiffOp = ArtifactDiffResult["hunks"][number]["lines"][number];

export type ArtifactState = "uploading" | "verified" | "quarantined" | "deleted";
export type ArtifactClassification = "public" | "internal" | "confidential" | "restricted";

/** The Output Browser index scope, resolved server-side (producer or work item). */
export interface ArtifactListParams {
  workspaceId: string;
  jobId?: string;
  runId?: string;
  workItemId?: string;
  state?: ArtifactState;
  classification?: ArtifactClassification;
}

export const artifactsListQuery = (params: ArtifactListParams, signal?: AbortSignal) =>
  fetchView({ queryType: "artifacts.list", workspaceId: params.workspaceId, jobId: params.jobId, runId: params.runId, workItemId: params.workItemId, state: params.state, classification: params.classification }, signal);

export const artifactsHistoryQuery = (ref: { artifactId: string } | { digest: string }, signal?: AbortSignal) =>
  fetchView({ queryType: "artifacts.history", ...ref }, signal);

export const artifactsDiffQuery = (params: { leftId: string; rightId: string; maxBytes?: number }, signal?: AbortSignal) =>
  fetchView({ queryType: "artifacts.diff", leftId: params.leftId, rightId: params.rightId, maxBytes: params.maxBytes }, signal);
