import type { Mission, PlayView, ReuseItem } from "@brain/contracts";

/**
 * Reuse entry points of the Today box (#69). Everything the box offers to
 * start from is a `ReuseCandidate`. "Start from a previous mission" is fed by
 * the reuse index (`fromReuseItems`: verified work only, ranked by search);
 * "Repeat this" lists finished missions (`fromMissions`) because a schedule
 * can target any of them.
 */
export interface ReuseCandidate {
  readonly id: string;
  readonly title: string;
  readonly intent: string;
  readonly successCriteria: readonly string[];
  /** Where the work came from, in words: the play that started it, or "described by you". */
  readonly provenance: string;
  /** When the result was last verified; absent when it never was. */
  readonly lastVerifiedAt?: string;
  readonly verified: boolean;
  /** The play the mission started from, when it had one (lets Repeat target the play). */
  readonly playId?: string;
}

/** Mission hits of the reuse index (#66), which carry what a new mission is seeded with. Other kinds cannot seed one. */
export function fromReuseItems(items: readonly ReuseItem[], missions: readonly Mission[]): ReuseCandidate[] {
  return items.flatMap((item): ReuseCandidate[] => {
    const missionId = item.provenance.missionId;
    if (item.kind !== "mission" || !item.startFrom || !missionId) return [];
    const playId = missions.find((mission) => mission.missionId === missionId)?.playId;
    return [{
      id: missionId, title: item.startFrom.title, intent: item.startFrom.intent, successCriteria: item.startFrom.successCriteria,
      provenance: `${item.provenance.source ?? "Achieved mission"}${item.usedCount ? ` · reused ${item.usedCount} ${item.usedCount === 1 ? "time" : "times"}` : ""}`,
      lastVerifiedAt: item.lastVerifiedAt, verified: true, ...(playId ? { playId } : {}),
    }];
  });
}

/** A mission is reusable once it is closed; achieved ones count as verified. */
export const fromMissions = (missions: readonly Mission[], plays: readonly PlayView[]): ReuseCandidate[] => missions
  .filter((mission) => mission.state === "closed")
  .map((mission): ReuseCandidate => {
    const verified = mission.outcome === "achieved";
    const play = mission.playId ? plays.find((candidate) => candidate.playId === mission.playId) : undefined;
    return {
      id: mission.missionId, title: mission.title, intent: mission.intent, successCriteria: mission.successCriteria,
      provenance: mission.playId ? `From play ${play?.title ?? mission.playId}` : "Described by you",
      verified, ...(verified ? { lastVerifiedAt: mission.updatedAt } : {}), ...(mission.playId ? { playId: mission.playId } : {}),
    };
  })
  .sort((a, b) => Number(b.verified) - Number(a.verified) || (b.lastVerifiedAt ?? "").localeCompare(a.lastVerifiedAt ?? ""));

/** The brief constraint that names the source of a seeded mission. */
export function sourceConstraint(candidate: ReuseCandidate): string {
  return `Started from the earlier mission "${candidate.title}" (${candidate.id}); its verified outputs are the starting inputs. ${candidate.verified ? `Last verified ${candidate.lastVerifiedAt ?? "earlier"}.` : "It was not verified."}`;
}

/** HOOK for #56: the preset schedule picker. Until it exists, Repeat opens the Schedules editor for the play, else the mission's plan. */
export function repeatHref(workspaceId: string, candidate: ReuseCandidate): string {
  return candidate.playId
    ? `/w/${encodeURIComponent(workspaceId)}/schedules?create=${encodeURIComponent(candidate.playId)}`
    : `/missions/${encodeURIComponent(candidate.id)}/plan?w=${encodeURIComponent(workspaceId)}`;
}
