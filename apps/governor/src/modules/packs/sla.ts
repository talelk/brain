// Deterministic SLA minutes from immutable responsibility intervals.
// Calendar time only in this baseline; business-calendar versioning is recorded
// via calendarDigest on each interval by callers.
export interface SlaInterval {
  readonly responsibility: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

export function computeSlaMinutes(intervals: readonly SlaInterval[], responsibility: string, nowMs: number): number {
  let total = 0;
  for (const iv of intervals) {
    if (iv.responsibility !== responsibility) continue;
    const end = iv.endedAtMs ?? nowMs;
    total += Math.max(0, end - iv.startedAtMs);
  }
  return Math.floor(total / 60_000);
}
