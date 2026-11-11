import type { ReuseItem } from "@brain/contracts";
import { query } from "./client";
import { missionHref } from "../ui/mission-links";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/**
 * Reuse reads (#66, #70). The reuse hook for any screen that starts work, such as the
 * new-mission box ("Start from a previous mission"): call `reuseSearch` with the goal,
 * show the hits, and send the kept refs on the plan request (`reuse`). A hit of kind
 * `mission` carries `startFrom` (title, intent, success criteria) to pre-fill a new mission.
 * See docs/howto/start-from-previous.md.
 */
export async function reuseSearch(workspaceId: string, goal: string, missionId?: string, signal?: AbortSignal): Promise<Envelope<ReuseItem[]>> {
  const response = await query<Envelope<{ items: ReuseItem[] }>>({ queryType: "reuse.search", workspaceId, search: goal, ...(missionId ? { resourceId: missionId } : {}) }, signal);
  return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
}

/** What a mission reused, read from the attach records only. */
export async function reusedByMission(workspaceId: string, missionId: string, signal?: AbortSignal): Promise<Envelope<ReuseItem[]>> {
  const response = await query<Envelope<{ items: ReuseItem[] }>>({ queryType: "reuse.forMission", workspaceId, resourceId: missionId }, signal);
  return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
}

/** Where a reused item opens: its mission, its knowledge asset in the review place, or the play. */
export function reuseItemHref(workspaceId: string, item: Pick<ReuseItem, "itemRef" | "kind" | "provenance">): string | undefined {
  if (item.kind === "play") return `/plays/${encodeURIComponent(item.itemRef.slice("play:".length))}?w=${encodeURIComponent(workspaceId)}`;
  if (item.kind === "knowledge") return `/w/${workspaceId}/knowledge/review`;
  return item.provenance.missionId ? missionHref(workspaceId, item.provenance.missionId, "outputs") : undefined;
}
