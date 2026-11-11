/**
 * Display helpers shared by every screen so the same server value renders the
 * same way everywhere (counts, digests, dates, money, labels) — no per-page
 * dialects.
 */

/** "1 decision" / "3 decisions"; never "1 decisions". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * One consistent truncated digest form: `sha256:ba102196c289…`. The ellipsis is
 * part of the rendering so a shortened digest can never read as a complete one.
 */
/** A digest as a short, plain tag for running text ("38cbefce"); the full value always sits behind a copy affordance or a tooltip. */
export function digestTag(digest: string | undefined): string {
  if (!digest) return "—";
  return digest.slice(digest.indexOf(":") + 1).slice(0, 8);
}

export function shortDigest(digest: string | undefined, hexChars = 12): string {
  if (!digest) return "—";
  const colon = digest.indexOf(":");
  const prefix = colon >= 0 ? digest.slice(0, colon + 1) : "";
  const hex = colon >= 0 ? digest.slice(colon + 1) : digest;
  return `${prefix}${hex.slice(0, hexChars)}…`;
}

/** Times read on a 24-hour clock everywhere (no AM/PM); the locale still orders the date. */
export const CLOCK_24 = { hourCycle: "h23" } as const;

/** The locale date-time form DateText renders, for string-only contexts (table columns, descriptions). */
export function formatDateTime(value?: string | number | Date): string {
  return value ? new Date(value).toLocaleString(undefined, CLOCK_24) : "—";
}

/** Compact relative form for meta stamps: "3 min ago", "in 2 h", "5 d ago". */
export function formatRelative(value?: string | number | Date): string {
  if (!value) return "—";
  const ms = Date.parse(String(value)) - Date.now();
  const minutes = Math.round(ms / 60_000);
  const future = minutes > 0;
  const magnitude = Math.abs(minutes);
  const span = magnitude < 1 ? "just now"
    : magnitude < 60 ? `${magnitude} min`
    : magnitude < 1440 ? `${Math.round(magnitude / 60)} h`
    : `${Math.round(magnitude / 1440)} d`;
  if (span === "just now") return span;
  return future ? `in ${span}` : `${span} ago`;
}

/** Micro-USD as a dollar figure: 1250000 → "$1.25"; whole dollars drop the cents and a non-zero amount under a cent reads "<$0.01". */
export function formatUsd(microUsd?: number): string {
  if (microUsd === undefined || microUsd === null) return "—";
  if (microUsd > 0 && microUsd < 10_000) return "<$0.01";
  return `$${(microUsd / 1_000_000).toFixed(2).replace(/\.00$/, "")}`;
}

/** Token counts compactly: 950 -> "950", 12450 -> "12.5k", 3200000 -> "3.2M"; exact figures stay in tooltips. */
export function formatTokens(tokens?: number): string {
  if (tokens === undefined || tokens === null) return "unknown";
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** `operations-triage` → `Operations triage`, matching the historical label helper. */
/** "workItem.transitioned" -> "work item transitioned": an event type in words, for counts shown to people. */
const EVENT_WORDS: Record<string, string> = { "mission.created": "mission started", "mission.seen": "visit recorded", "plan.confirmed": "plan confirmed", "plan.proposed": "plan drafted" };
export function eventWords(type: string): string {
  return EVENT_WORDS[type] ?? type.replace(/([a-z])([A-Z])/gu, "$1 $2").replaceAll(".", " ").replaceAll("-", " ").toLowerCase();
}

export function titleize(value: string): string {
  return value.replaceAll("-", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

const QUEUE_REASON_LABELS: Record<string, string> = {
  READY: "Ready for a runner", WAITING_FOR_RUNNER: "Waiting for a capable runner", BLOCKED_BY_POLICY: "Blocked by policy",
  WAITING_FOR_APPROVAL: "Waiting for approval", INSUFFICIENT_CAPACITY: "Runner capacity exhausted",
  WAITING_FOR_RESOURCE: "Waiting for a resource", BUDGET_EXHAUSTED: "Budget exhausted", FAIRNESS_DELAY: "Fairness delay", RUNNER_OFFLINE: "Runner offline",
};

/** Human queue-reason list; "None" when empty. */
export function queueReasonLabel(reasons: readonly string[]): string {
  return reasons.map((reason) => QUEUE_REASON_LABELS[reason] ?? reason).join(", ") || "None";
}

/** SLA ages render as whole minutes; both support tables share this unit. */
export function formatSlaMinutes(ms: number): string {
  return `${Math.round(ms / 60000)} min`;
}
