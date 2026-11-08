/** The mission views (#43). Each tab of a mission lives at its own address. */
export type MissionTab = "live" | "team" | "plan" | "brief" | "logs" | "outputs";

export function missionHref(_workspaceId: string, missionId: string, tab: MissionTab): string {
  return `/missions/${encodeURIComponent(missionId)}/${tab}`;
}
