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

/**
 * Locale policy (one for the whole UI): the interface is English, so every date and time is formatted with the explicit
 * `en-GB` locale (day before month, 24-hour clock, never the browser's own language) in the viewer's own timezone, or in an
 * explicit IANA zone when a schedule names one. Do not call `toLocaleString(undefined, ...)` or `Intl.DateTimeFormat(undefined)`
 * elsewhere: use these helpers.
 */
export const UI_LOCALE = "en-GB";

/** Times read on a 24-hour clock everywhere (no AM/PM). */
export const CLOCK_24 = { hourCycle: "h23" } as const;

/** The viewer's IANA timezone ("Africa/Tunis"), or "UTC" when the browser does not say. */
export function userTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** Formats an instant with the UI locale in `timeZone` (default: the viewer's); an unreadable value comes back unchanged. */
export function formatInstant(value: string | number | Date | undefined, options: Intl.DateTimeFormatOptions, timeZone: string = userTimeZone()): string {
  if (value === undefined || value === "") return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  try { return new Intl.DateTimeFormat(UI_LOCALE, { ...CLOCK_24, ...options, timeZone }).format(date); } catch { return String(value); }
}

/** "12 Nov 2026, 14:05" in the viewer's timezone: the one form DateText renders, for string-only contexts too. */
export function formatDateTime(value?: string | number | Date, timeZone?: string): string {
  return formatInstant(value, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }, timeZone);
}

/** "14:05:09" (or "14:05" without seconds) in the viewer's timezone. */
export function formatClock(value: string | number | Date | undefined, seconds = true, timeZone?: string): string {
  return formatInstant(value, seconds ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" }, timeZone);
}

/** "Thu 12 Nov, 08:00" in the given timezone (a schedule's own zone, so 08:00 reads as 08:00). */
export function formatOccurrence(value: string | number | Date | undefined, timeZone?: string): string {
  return formatInstant(value, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }, timeZone);
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

/**
 * A named output's name for people. Workflow outputs are named after their plan task id ("write-recommendation"), so a task title
 * wins when the caller knows it; otherwise the id is spelled out as words ("Write recommendation").
 */
export function friendlyOutputName(name: string, taskTitle?: string): string {
  if (taskTitle?.trim()) return taskTitle.trim();
  if (!/^[a-z0-9._-]+$/u.test(name) || /^[._-]|[._-]$/u.test(name)) return name;
  return titleize(name.replaceAll("_", "-").replaceAll(".", "-"));
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
