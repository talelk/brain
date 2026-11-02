/**
 * Bounded one-line text of a stream-record summary; objects render as bounded
 * JSON. Shared by the log rows, the tool-call grouping and the console's
 * approval panel — the one truncation policy for projected summaries.
 */
export function streamSummaryText(summary: unknown, maxChars = 220): string {
  const text = typeof summary === "string" ? summary : summary === undefined || summary === null ? "" : JSON.stringify(summary);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
