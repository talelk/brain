/**
 * Every in-app path an outbound notification (push, webhook, email) links to is built here, so a test can hold each one to the
 * generated route table (`tests/domain/notification-links.test.ts`). A link no screen answers to would send the person to `/`.
 */

/** A platform alert (disk, model endpoint, replica, hosted model) lands where the problem is shown: the Health tab. */
export const platformAlertLink = (): string => "/settings?tab=health";

/** An approval of one exact call links straight to that decision (ADR 0024); a gate without one opens the inbox. */
export const approvalLink = (approvalId?: string): string => (approvalId ? `/approvals/${approvalId}` : "/approvals");

/** The daily digest opens Today in the person's first workspace with results waiting. */
export const digestLink = (workspaceId: string): string => `/w/${workspaceId}/today`;

/** The test email points at the page where the person switched email on. */
export const securitySettingsLink = (): string => "/settings?tab=security";

/** An attention item: a knowledge asset for review, a result or a sign-off on the mission's Results tab, or the mission's live view. */
export function attentionLink(item: { kind: string; workspaceId: string; missionId: string; resourceId?: string; knowledgeAssetId?: string }): string {
  if (item.kind === "result-ready" && item.knowledgeAssetId) return `/w/${item.workspaceId}/knowledge/review?asset=${item.knowledgeAssetId}`;
  if (item.kind === "result-ready") return `/missions/${item.missionId}/outputs?w=${item.workspaceId}${item.resourceId === item.missionId ? "" : `&result=${item.resourceId}`}`;
  if (item.kind === "sign-off") return `/missions/${item.missionId}/outputs?w=${item.workspaceId}`;
  return `/missions/${item.missionId}/live?w=${item.workspaceId}`;
}
