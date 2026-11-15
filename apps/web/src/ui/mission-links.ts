/** The mission views (#43). Each tab of a mission lives at its own address. */
export type MissionTab = "live" | "team" | "plan" | "brief" | "timeline" | "delegations" | "outputs";

/**
 * A mission's address. `?w=` names the mission's workspace so a link from the
 * attention drawer, a notification or a push opens it whichever workspace is
 * selected: the mission page switches to it.
 */
export function missionHref(workspaceId: string, missionId: string, tab?: MissionTab): string {
  return `/missions/${encodeURIComponent(missionId)}${tab ? `/${tab}` : ""}?w=${encodeURIComponent(workspaceId)}`;
}

/** An agent definition's page in the Library (ADR 0014): its status, runs, rates and cost. */
export function agentHref(workspaceId: string, agentId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/library/agents/${encodeURIComponent(agentId)}`;
}

/** One team member's panel on its mission's Team tab. */
export function memberHref(workspaceId: string, missionId: string, memberId: string): string {
  return `${missionHref(workspaceId, missionId, "team")}&member=${encodeURIComponent(memberId)}`;
}

/**
 * Missions that share a title (a repeated run, two near-identical goals) look the same in a list. Each one in such a group gets the time
 * it started, so a person can tell them apart; a mission with a title of its own gets nothing.
 */
export function sameTitleHints(missions: ReadonlyArray<{ missionId: string; title: string; createdAt: string }>, when: (iso: string) => string): ReadonlyMap<string, string> {
  const groups = new Map<string, string[]>();
  for (const mission of missions) {
    const key = mission.title.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), mission.missionId]);
  }
  const hints = new Map<string, string>();
  for (const mission of missions) if ((groups.get(mission.title.trim().toLowerCase())?.length ?? 0) > 1) hints.set(mission.missionId, when(mission.createdAt));
  return hints;
}
