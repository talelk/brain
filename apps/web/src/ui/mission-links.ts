/** The mission views (#43). Each tab of a mission lives at its own address. */
export type MissionTab = "live" | "team" | "plan" | "brief" | "logs" | "outputs";

/**
 * A mission's address. `?w=` names the mission's workspace so a link from the
 * attention drawer, a notification or a push opens it whichever workspace is
 * selected: the mission page switches to it.
 */
export function missionHref(workspaceId: string, missionId: string, tab: MissionTab): string {
  return `/missions/${encodeURIComponent(missionId)}/${tab}?w=${encodeURIComponent(workspaceId)}`;
}
