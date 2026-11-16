import type { MissionTimelineEntry } from "@brain/contracts";
import { t, tOr, type MessageKey } from "../../i18n";
import type { TimelineKind } from "./timeline-model";

export type TimelineTone = "gray" | "blue" | "green" | "amber" | "red";

/** The icon a kind of entry carries, so the list reads at a glance before any word is read. */
export const KIND_ICON: Readonly<Record<TimelineKind, string>> = {
  plan: "lucide-list-tree", decision: "lucide-gavel", message: "lucide-message-square", run: "lucide-play",
  approval: "lucide-shield-check", effect: "lucide-wrench", verdict: "lucide-badge-check", output: "lucide-package",
};

const KIND_KEY: Readonly<Record<TimelineKind, MessageKey>> = {
  plan: "timeline.kind.plan", decision: "timeline.kind.decision", message: "timeline.kind.message", run: "timeline.kind.run",
  approval: "timeline.kind.approval", effect: "timeline.kind.effect", verdict: "timeline.kind.verdict", output: "timeline.kind.output",
};
export const kindLabel = (kind: TimelineKind): string => t(KIND_KEY[kind]);

/** The event words per outcome: the catalogue holds one sentence per case, so a translator reads the whole sentence. */
const BY_OUTCOME: Readonly<Record<string, Readonly<Record<string, MessageKey>>>> = {
  "approval.decided": { approve: "timeline.approval.approve", reject: "timeline.approval.reject", "request-changes": "timeline.approval.request-changes", revoke: "timeline.approval.revoke" },
  "effect.settled": { applied: "timeline.effect.applied", declined: "timeline.effect.declined", expired: "timeline.effect.expired", revoked: "timeline.effect.revoked", cancelled: "timeline.effect.cancelled", unknown: "timeline.effect.unknown" },
  "verdict.task": { verified: "timeline.verdict.task.verified", rejected: "timeline.verdict.task.rejected", incomplete: "timeline.verdict.task.incomplete" },
  "verdict.mission": { verified: "timeline.verdict.mission.verified", rejected: "timeline.verdict.mission.rejected" },
  "output.recorded": { verified: "timeline.output.verified", final: "timeline.output.final", draft: "timeline.output.draft" },
};

const RUN_STATE: Readonly<Record<string, MessageKey>> = {
  running: "timeline.runState.running", succeeded: "timeline.runState.succeeded", failed: "timeline.runState.failed", cancelled: "timeline.runState.cancelled", blocked: "timeline.runState.blocked",
};

const GOOD = new Set(["approve", "applied", "verified"]);
const BAD = new Set(["reject", "rejected", "declined", "failed", "revoke", "revoked"]);

export interface EntryWords {
  readonly title: string;
  /** What the entry is about, in the person's own words (a task, a decision, a message), when it has one. */
  readonly subject?: string;
  /** A second sentence that is not part of the title (the run's state now). */
  readonly note?: string;
  readonly tone: TimelineTone;
}

/** One entry in the current language. The Governor sends an event code, its subject and outcome; every sentence is composed here. */
export function entryWords(entry: MissionTimelineEntry, roleOf: (memberId: string) => string): EntryWords {
  const outcome = entry.outcome ?? "";
  const tone: TimelineTone = GOOD.has(outcome) ? "green" : BAD.has(outcome) ? "red" : outcome === "incomplete" || outcome === "unknown" || outcome === "expired" ? "amber" : "gray";
  const subject = entry.subject;
  const base = { ...(subject ? { subject } : {}), tone };
  switch (entry.event) {
    case "plan.proposed": return { ...base, title: t("timeline.plan.proposed", { revision: entry.revision ?? 0 }), tone: "blue" };
    case "plan.confirmed": return { ...base, title: t("timeline.plan.confirmed", { revision: entry.revision ?? 0 }), tone: "green" };
    case "decision.accepted": return { ...base, title: t("timeline.decision.accepted"), tone: "blue" };
    case "message.sent": return { ...base, title: entry.memberId ? t("timeline.message.member", { member: roleOf(entry.memberId) }) : t("timeline.message.mission"), tone: "blue" };
    case "message.corrected": return { ...base, title: t("timeline.message.corrected"), tone: "blue" };
    case "run.started": {
      const state = RUN_STATE[outcome];
      return { ...base, title: t("timeline.run.started"), tone: outcome === "failed" ? "red" : outcome === "succeeded" ? "green" : "blue", ...(outcome ? { note: t("timeline.run.state", { state: state ? t(state) : outcome.replaceAll("_", " ") }) } : {}) };
    }
    case "run.coordinator": return { ...base, title: t("timeline.run.coordinator"), tone: "blue" };
    case "approval.requested": return { ...base, title: t("timeline.approval.requested"), tone: "amber" };
    case "approval.expired": return { ...base, title: t("timeline.approval.expired"), tone: "amber" };
    case "effect.settled": {
      const key = BY_OUTCOME["effect.settled"]![outcome];
      return { ...base, title: key ? t(key) : t("timeline.effect.other", { outcome: tOr(`timeline.effect.${outcome}`, outcome) }) };
    }
    // Only a person's recorded verdict (independence L3) is a sign-off; the Governor's own hands-off verdict says Brain verified it.
    case "verdict.mission": if (outcome === "verified" && entry.independence !== "L3") return { ...base, title: t("timeline.verdict.mission.verifiedByBrain"), tone: "green" };
      return { ...base, title: t(outcome === "rejected" ? "timeline.verdict.mission.rejected" : "timeline.verdict.mission.verified"), tone };
    case "verdict.submitted": return { ...base, title: t("timeline.verdict.submitted"), tone: "blue" };
    default: {
      const key = BY_OUTCOME[entry.event]?.[outcome];
      return { ...base, title: key ? t(key) : entry.event };
    }
  }
}

export const openLabel = (label: string): string => tOr(`timeline.open.${label}`, label);
