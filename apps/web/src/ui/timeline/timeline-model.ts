import type { MissionTimelineEntry } from "@brain/contracts";
import { missionHref } from "../mission-links";

export type TimelineKind = MissionTimelineEntry["kind"];
/** The kinds in the order a person reads them: what was planned, said and run, then what was approved, changed, checked and produced. */
export const TIMELINE_KINDS: readonly TimelineKind[] = ["plan", "decision", "message", "run", "approval", "effect", "verdict", "output"];

export interface TimelineFilter { readonly kind: TimelineKind | ""; readonly member: string }

/** A kind named in the address that the timeline does not know is no filter at all. */
export const kindOf = (value: unknown): TimelineKind | "" => ((TIMELINE_KINDS as readonly unknown[]).includes(value) ? value as TimelineKind : "");

/** The entries of one kind and/or one team member, in their original order. A member filter keeps only entries that name that member. */
export function filterTimeline(items: readonly MissionTimelineEntry[], filter: TimelineFilter): MissionTimelineEntry[] {
  return items.filter((entry) => (!filter.kind || entry.kind === filter.kind) && (!filter.member || entry.memberId === filter.member));
}

/** The kinds that occur, so the filter offers only choices that show something. */
export function kindsPresent(items: readonly MissionTimelineEntry[]): TimelineKind[] {
  const present = new Set(items.map((entry) => entry.kind));
  return TIMELINE_KINDS.filter((kind) => present.has(kind));
}

export interface TimelineLink { readonly href: string; readonly label: "run" | "evidence" | "approval" | "decision" | "output" | "plan" | "message" | "mission" | "logs" }

/**
 * Where an entry's source lives. A run opens its run page (the run's checks open on its Evidence tab); an approval, effect or output its own
 * page; a decision, plan, message or sign-off the mission view that shows it. A run no job was ever created for (nothing to inspect) falls
 * back to its logs.
 */
export function sourceLink(entry: MissionTimelineEntry, where: { workspaceId: string; missionId: string }): TimelineLink {
  const { source } = entry;
  const mission = (tab: "plan" | "brief" | "live" | "outputs", extra = ""): string => `${missionHref(where.workspaceId, where.missionId, tab)}${extra}`;
  switch (source.kind) {
    case "run":
      if (!source.jobId) return { href: `/w/${encodeURIComponent(where.workspaceId)}/logs?run=${encodeURIComponent(source.id)}`, label: "logs" };
      return entry.event === "verdict.task" ? { href: `/runs/${encodeURIComponent(source.jobId)}?tab=evidence`, label: "evidence" } : { href: `/runs/${encodeURIComponent(source.jobId)}`, label: "run" };
    case "approval": return { href: `/approvals/${encodeURIComponent(source.id)}`, label: "approval" };
    case "output": return { href: `/outputs/${encodeURIComponent(source.id)}`, label: "output" };
    case "decision": return { href: mission("brief", `&decision=${encodeURIComponent(source.id)}`), label: "decision" };
    case "plan": return { href: mission("plan"), label: "plan" };
    case "message": return { href: mission("live"), label: "message" };
    case "mission": return { href: mission("outputs"), label: "mission" };
  }
}

/** A run's tool calls open the run page on its Tool calls tab; a run with no job, or no calls, has none to open. */
export function toolCallsLink(entry: MissionTimelineEntry): string | undefined {
  return entry.source.kind === "run" && entry.source.jobId && entry.toolCalls ? `/runs/${encodeURIComponent(entry.source.jobId)}?tab=tool-calls` : undefined;
}
