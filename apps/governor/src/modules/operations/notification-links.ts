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

/**
 * An attention item opens where its row in Needs you opens (`attentionHref` in the web app): an approval its decision; a plan
 * proposal, parked work or an unknown step the mission's Plan tab; a result, a sign-off or a verdict the Results tab (a result with a
 * write-up opens that write-up); routed findings the live view; a question from an agent the live view with its composer open on that question; an evaluation waiting for a person its attestation page, with or without a mission; a paused mission its brief. Without a mission, an unknown step opens its
 * run and a schedule that could not start opens Schedules.
 */
export function attentionLink(item: { kind: string; workspaceId: string; missionId?: string; resourceId?: string; knowledgeAssetId?: string }): string {
  if (item.kind === "approval") return approvalLink(item.resourceId);
  if (item.kind === "attestation") return `/attestations/${item.resourceId}?w=${item.workspaceId}`;
  if (!item.missionId) return item.kind === "outcome-unknown" && item.resourceId ? `/runs/${encodeURIComponent(item.resourceId)}` : `/w/${item.workspaceId}/schedules`;
  const at = (tab: string): string => `/missions/${item.missionId}/${tab}?w=${item.workspaceId}`;
  switch (item.kind) {
    case "result-ready":
      if (item.knowledgeAssetId) return `/w/${item.workspaceId}/knowledge/review?asset=${item.knowledgeAssetId}`;
      return `${at("outputs")}${item.resourceId === item.missionId ? "" : `&result=${item.resourceId}`}`;
    case "sign-off": case "verdict-ready": return at("outputs");
    case "plan-proposal": return `${at("plan")}&proposal=${item.resourceId}`;
    case "parked": case "needs-attention": case "outcome-unknown": return at("plan");
    case "routed": return at("live");
    case "question": return `${at("live")}&question=${item.resourceId}`;
    default: return at("brief");
  }
}

/** A mission opened on one of its tabs; the reply to a chat `start` links to its Plan tab, where the starting plan waits. */
export const missionLink = (workspaceId: string, missionId: string, tab: "plan" | "live" | "outputs" | "brief"): string => `/missions/${missionId}/${tab}?w=${workspaceId}`;
