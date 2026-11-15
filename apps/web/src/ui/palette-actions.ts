import { ROUTES } from "../routes/index.gen";
import type { MessageKey } from "../i18n";
import { missionHref, type MissionTab } from "./mission-links";

/** One thing the command palette can do from the keyboard: a plain label and the address it opens. */
export interface PaletteAction { id: string; labelKey: MessageKey; /** Catalogue key of the mission view a "go to" action names. */ viewKey?: MessageKey; href: string }

const TABS: ReadonlyArray<{ tab: MissionTab; viewKey: MessageKey }> = [
  { tab: "live", viewKey: "mission.tab.live" }, { tab: "team", viewKey: "mission.tab.team" }, { tab: "plan", viewKey: "mission.tab.plan" },
  { tab: "brief", viewKey: "mission.tab.brief" }, { tab: "timeline", viewKey: "mission.tab.timeline" }, { tab: "outputs", viewKey: "mission.tab.outputs" },
];

/** The address of a screen of the route table, or undefined when the contract has no such screen (so an action never leads nowhere). */
function screen(pattern: string, workspaceId: string): string | undefined {
  return ROUTES.some((entry) => entry.route === pattern) ? pattern.replace(":id", encodeURIComponent(workspaceId)) : undefined;
}

/** The palette's actions for this workspace; a mission's other views are offered only while one of its pages is open. */
export function paletteActions(workspaceId: string, openMission?: { missionId: string; tab?: string }): PaletteAction[] {
  const named: Array<[string, MessageKey, string]> = [
    ["new-mission", "palette.action.new-mission", "/w/:id/missions/new"], ["approvals", "palette.action.approvals", "/approvals"],
    ["live", "palette.action.live", "/w/:id/live"], ["board", "palette.action.board", "/w/:id/board"],
  ];
  const actions: PaletteAction[] = [];
  for (const [id, labelKey, pattern] of named) {
    const href = screen(pattern, workspaceId);
    if (href) actions.push({ id, labelKey, href });
  }
  if (openMission) {
    for (const entry of TABS) {
      if (entry.tab !== openMission.tab) actions.push({ id: `tab-${entry.tab}`, labelKey: "palette.action.mission-tab", viewKey: entry.viewKey, href: missionHref(workspaceId, openMission.missionId, entry.tab) });
    }
  }
  return actions;
}
