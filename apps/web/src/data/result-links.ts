import { governor, query } from "./client";

/** A read-only share link as the owner sees it. The token itself is shown once, at creation, and never again. */
export interface ShareLink {
  shareId: string;
  versionId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  state: "active" | "expired" | "revoked";
  views: number;
  lastViewedAt?: string;
  revokedAt?: string;
}

export interface CreatedShare { shareId: string; expiresAt: string; url: string }

export const createShare = (workspaceId: string, versionId: string, expiresInHours: number): Promise<CreatedShare> =>
  governor<CreatedShare>("/v1/shares", { workspaceId, versionId, expiresInHours });

export async function listShares(workspaceId: string, versionId: string, signal?: AbortSignal): Promise<ShareLink[]> {
  const response = await governor<{ items: ShareLink[] }>(`/v1/shares?workspaceId=${encodeURIComponent(workspaceId)}&versionId=${encodeURIComponent(versionId)}`, undefined, signal);
  return response.items;
}

export const revokeShare = (workspaceId: string, shareId: string): Promise<ShareLink> => governor<ShareLink>("/v1/shares/revoke", { workspaceId, shareId });

/** What a share link shows: one verified result and nothing around it. */
export interface SharedResult {
  name: string;
  versionLabel: string;
  verified: true;
  recordedAt: string;
  sharedAt: string;
  expiresAt: string;
  mediaType: string;
  text: string;
  truncated: boolean;
}

export type SharedOutcome = { kind: "ok"; result: SharedResult } | { kind: "gone"; reason: "expired" | "revoked" } | { kind: "missing" };

/** The public read. It sends no cookies: the link alone is the credential. */
export async function readShared(token: string): Promise<SharedOutcome> {
  const response = await fetch(`/v1/shared/${encodeURIComponent(token)}`, { credentials: "omit", headers: { accept: "application/json" } });
  if (response.ok) return { kind: "ok", result: await response.json() as SharedResult };
  if (response.status === 410) return { kind: "gone", reason: (await response.json() as { state: "expired" | "revoked" }).state };
  return { kind: "missing" };
}

/** An independent re-check of a result: findings are claims, labelled as one model's opinion, never a verdict (ADR 0012). */
export interface ChallengeClaim { text: string }
export interface Challenge {
  challengeId: string;
  workItemId: string;
  state: "requested" | "running" | "done" | "failed";
  requestedBy: string;
  requestedAt: string;
  completedAt?: string;
  summary?: string;
  claims: ChallengeClaim[];
  reason?: string;
  independence: "L1";
}

export async function listChallenges(workspaceId: string, workItemId: string | undefined, signal?: AbortSignal): Promise<Challenge[]> {
  const response = await query<{ snapshot: { items: Challenge[] } }>({ queryType: "challenges.list", workspaceId, resourceId: workItemId }, signal);
  return [...response.snapshot.items];
}
