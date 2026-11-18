/**
 * The caller's days, from a time zone name (docs/model.md, "The timeline and Insights"): where each local day starts and what the zone's offset from UTC is
 * at every instant of the window, so a daylight-saving change inside it is exact (a day of 23 or 25 hours has all its hours).
 */
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();
const formatOf = (zone: string): Intl.DateTimeFormat => {
  let format = formats.get(zone);
  if (!format) formats.set(zone, (format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })));
  return format;
};

/** How far `zone`'s clock is ahead of UTC at the instant `at`, in ms. */
export function offsetAt(zone: string, at: number): number {
  const whole = Math.floor(at / 1000) * 1000;
  const parts = formatOf(zone).formatToParts(new Date(whole));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - whole;
}

/** The instant at which the clock of `zone` reads `wall` (given as if it were UTC). */
const instantOf = (zone: string, wall: number): number => wall - offsetAt(zone, wall - offsetAt(zone, wall));

export interface DayWindow {
  /** The local days, `YYYY-MM-DD`, oldest first; the last one holds `now`. */
  readonly days: readonly string[];
  /** The instant the first day starts. */
  readonly since: number;
  /** The offset from UTC (ms) from each instant on, oldest first; the first is at `since`. */
  readonly offsets: ReadonlyArray<{ readonly from: number; readonly offset: number }>;
}

export function dayWindow(zone: string, count: number, now: number): DayWindow {
  const today = new Date(now + offsetAt(zone, now));
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Array.from({ length: count }, (_, index) => new Date(midnight - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10));
  const since = instantOf(zone, midnight - (count - 1) * DAY_MS);
  const offsets = [{ from: since, offset: offsetAt(zone, since) }];
  // The offset is looked at every six hours and a change is narrowed down to the second.
  for (let at = since; at < now; at += 6 * 3_600_000) {
    const next = Math.min(now, at + 6 * 3_600_000);
    const before = offsetAt(zone, at);
    if (offsetAt(zone, next) === before) continue;
    let low = at;
    let high = next;
    while (high - low > 1000) { const middle = Math.floor((low + high) / 2000) * 1000; if (offsetAt(zone, middle) === before) low = middle; else high = middle; }
    offsets.push({ from: high, offset: offsetAt(zone, high) });
  }
  return { days, since, offsets };
}

/** SQL for the offset (ms) in force at the instant in `column`. */
export const offsetSql = (window: DayWindow, column: string): string => {
  const later = [...window.offsets].slice(1).reverse();
  const first = window.offsets[0]?.offset ?? 0;
  return later.length === 0 ? String(first) : `(CASE ${later.map((entry) => `WHEN ${column} >= ${entry.from} THEN ${entry.offset}`).join(" ")} ELSE ${first} END)`;
};
