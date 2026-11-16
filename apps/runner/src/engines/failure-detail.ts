/**
 * What an engine failure is said to be. The vendor's own message is kept but is led by a plain cause, so a person reading the failure of
 * an attempt learns whether the conversation outgrew the model, the answer was not the required JSON, a tool failed, the model refused for
 * quota, or the attempt was stopped.
 */
/** The provider refused for quota or rate: HTTP 429, or its own words for it (OpenAI-compatible, Anthropic, Gemini and gateway spellings). */
export const QUOTA_TEXT = /\b429\b|rate[ _-]?limit|too many requests|insufficient[_ ]quota|\bquota\b|resource[_ ]exhausted|(?:tokens|requests) per min|usage limit|server requested \d+s retry delay/iu;
const QUOTA_CAUSE = "quota or rate limit";

const CAUSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/context (?:length|window)|maximum context|too many (?:input )?tokens|prompt is too long|context_length_exceeded|exceeds? the context/iu, "context overflow"],
  [/used its allowance|allowance is used|tool-call budget/iu, "limit"],
  [/not valid json|invalid json|required json/iu, "answer format"],
  [/tool [\w.-]+ (?:failed|is not allowed|refused|error)|tool (?:call|input|execution)\b/iu, "tool error"],
  [QUOTA_TEXT, QUOTA_CAUSE],
  [/abort|cancel|deadline exceeded|timed? ?out/iu, "stopped"],
  [/ECONN\w*|ENOTFOUND|fetch failed|socket|network|unreachable|overloaded|\b(?:502|503|504)\b/iu, "model endpoint"],
];

/** One unit word as milliseconds per unit; nothing for a word that is not a unit of time. An empty unit is seconds, as Retry-After counts them. */
const unitMs = (unit: string): number | undefined => {
  const u = unit.toLowerCase();
  if (u === "" || u === "s" || /^sec(?:ond)?s?$/u.test(u)) return 1000;
  if (u === "ms") return 1;
  if (u === "m" || /^min(?:ute)?s?$/u.test(u)) return 60_000;
  if (u === "h" || /^hours?$/u.test(u)) return 3_600_000;
  return undefined;
};

/**
 * The wait a provider asked for, in milliseconds, from its own words: "Server requested 30s retry delay" (the Retry-After header, as Pi
 * reports it), "retry after 20 seconds", "try again in 1m30s", "retry in 24.5s". Undefined when it named none.
 */
function quotaRetryAfterMs(raw: string): number | undefined {
  const named = /server requested (\d+)s retry delay/iu.exec(raw);
  if (named) return Number(named[1]) * 1000;
  const lead = /(?:retry[- ]after|retry in|try again (?:in|after))[:= ]+/iu.exec(raw);
  if (!lead) return undefined;
  // Durations follow one another ("1m30s"): read them one at a time from the end of the lead, never past the first thing that is not one.
  const duration = / ?([\d.]{1,9}) ?([a-z]{0,7})(?![a-z])/iuy;
  let total = 0;
  duration.lastIndex = lead.index + lead[0].length;
  for (let part = duration.exec(raw); part && total < 86_400_000; part = duration.exec(raw)) {
    const unit = unitMs(part[2] ?? "");
    // A bare number is seconds, but only the first part may be bare ("retry after 30"; never "1m30 ...").
    if (unit === undefined || (total > 0 && !part[2])) break;
    total += Number(part[1]) * unit;
  }
  return total > 0 ? Math.round(total) : undefined;
}

export function engineFailureDetail(raw: string): string {
  const message = raw.replace(/\s+/gu, " ").trim() || "no detail reported";
  const cause = CAUSES.find(([pattern]) => pattern.test(message))?.[1];
  if (cause === QUOTA_CAUSE) {
    // The wait the provider named leads in one fixed phrase the Governor reads: the stored reason is cut from its end.
    const wait = quotaRetryAfterMs(message);
    return `${QUOTA_CAUSE}${wait === undefined ? "" : ` (retry after ${Math.max(1, Math.ceil(wait / 1000))}s)`}: ${message}`;
  }
  return cause && !message.toLowerCase().startsWith(cause) ? `${cause}: ${message}` : message;
}

/** Whose failure it is: the model's account refused (`model-refused`), its endpoint did not answer (`endpoint`), or anything else. */
export function failureKind(detail: string): "model-refused" | "endpoint" | "other" {
  const cause = CAUSES.find(([pattern]) => pattern.test(detail))?.[1];
  return cause === QUOTA_CAUSE ? "model-refused" : cause === "model endpoint" ? "endpoint" : "other";
}
