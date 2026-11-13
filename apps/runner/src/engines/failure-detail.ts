/**
 * What an engine failure is said to be. The vendor's own message is kept (the Governor redacts and cuts it before storing it) but is led by
 * a plain cause, so a person reading "agent ended with error" learns whether the conversation outgrew the model, the answer broke the
 * output contract, a tool failed, or the attempt was stopped.
 */
const CAUSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/context (?:length|window)|maximum context|too many (?:input )?tokens|prompt is too long|context_length_exceeded|exceeds? the context/iu, "context overflow"],
  [/used its allowance|allowance is used|token budget|tool-call budget|turn budget/iu, "budget"],
  [/schema|does not meet the required output|output contract|validation failed|not valid json|invalid json/iu, "schema mismatch"],
  [/tool [\w.-]+ (?:failed|is not allowed|refused|error)|tool (?:call|input|execution)\b|governed broker/iu, "tool error"],
  [/abort|cancel|deadline exceeded|timed? ?out/iu, "stopped"],
  [/ECONN\w*|ENOTFOUND|fetch failed|socket|network|unreachable|overloaded|\b(?:429|502|503|504)\b/iu, "model endpoint"],
];

export function engineFailureDetail(raw: string): string {
  const message = raw.replace(/\s+/gu, " ").trim() || "no detail reported";
  const cause = CAUSES.find(([pattern]) => pattern.test(message))?.[1];
  return cause && !message.toLowerCase().startsWith(cause) ? `${cause}: ${message}` : message;
}
