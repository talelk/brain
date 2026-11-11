import type { Mission, PlayView } from "@brain/contracts";

/**
 * Reuse entry points of the Today box (#69). Everything the box offers to
 * start from is a `ReuseCandidate`; today they are derived from the
 * workspace's finished missions. The reuse index (#66) will supply the same
 * shape (verified outputs, freshness, search ranking) by replacing
 * `fromMissions`; nothing else in the UI changes.
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

/** HOOK for #66: replace with a query against the reuse index. */
export type ReuseSource = (missions: readonly Mission[], plays: readonly PlayView[]) => ReuseCandidate[];

/** A mission is reusable once it is closed; achieved ones count as verified. */
export const fromMissions: ReuseSource = (missions, plays) => missions
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
