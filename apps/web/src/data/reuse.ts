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
export async function reuseSearch(workspaceId: string, goal: string, missionId?: string, signal?: AbortSignal, limit?: number): Promise<Envelope<ReuseItem[]>> {
  const response = await query<Envelope<{ items: ReuseItem[] }>>({ queryType: "reuse.search", workspaceId, search: goal, ...(missionId ? { resourceId: missionId } : {}), ...(limit ? { limit } : {}) }, signal);
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

/** Most past items a first draft is given without anyone choosing. */
export const AUTO_REUSE_CAP = 3;
const KIND_PREFERENCE: Record<ReuseItem["kind"], number> = { knowledge: 0, output: 1, mission: 2, handoff: 3, play: 9 };

/**
 * What the first draft is handed on its own. The server already applied the relevance cutoff (a hit
 * shares at least half of the goal's distinctive terms, BM25-ranked); here Plays are left out because
 * they are templates the person starts from, not past work, then verified knowledge and outputs
 * lead, human-reviewed before self-reviewed, and the list is capped.
 */
export function pickForPlan(items: readonly ReuseItem[]): ReuseItem[] {
  return items
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => item.kind !== "play")
    .sort((a, b) => KIND_PREFERENCE[a.item.kind] - KIND_PREFERENCE[b.item.kind] || Number(Boolean(a.item.selfReviewed)) - Number(Boolean(b.item.selfReviewed)) || a.order - b.order)
    .slice(0, AUTO_REUSE_CAP)
    .map(({ item }) => item);
}
