/** Cron schedules (docs/architecture.md section 9): the one parser the scheduler, the validation of a Play and the web app's form share. */

function field(text: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [base = "", step = "1", ...more] = part.split("/");
    if (more.length > 0 || !/^\d+$/u.test(step)) return undefined;
    const range = base === "*" ? [min, max] : /^\d+-\d+$/u.test(base) ? base.split("-").map(Number) : /^\d+$/u.test(base) ? [Number(base), part.includes("/") ? max : Number(base)] : undefined;
    const [low, high] = range ?? [];
    if (low === undefined || high === undefined || low < min || high > max || low > high || Number(step) < 1) return undefined;
    for (let value = low; value <= high; value += Number(step)) values.add(value);
  }
  return values;
}

const clocks = new Map<string, Intl.DateTimeFormat>();
/** The wall clock of a time zone at a moment, as a date whose UTC fields are that clock's fields. */
function wallClock(ms: number, timeZone: string): Date {
  let clock = clocks.get(timeZone);
  if (!clock) clocks.set(timeZone, (clock = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })));
  const part = Object.fromEntries(clock.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
  return new Date(Date.UTC(part["year"] ?? 0, (part["month"] ?? 1) - 1, part["day"], part["hour"], part["minute"], part["second"]));
}
/**
 * The first minute after `afterMs` at which the wall clock of `timeZone` (an IANA name) shows a time a five-field cron expression names
 * (minute, hour, day of month, month, day of week; lists, ranges and steps). When both day fields are restricted, either one matching is
 * enough. A time the clock skips when it is set forward does not come, and one it shows twice when it is set back comes twice. Undefined
 * for an expression that names no time.
 */
export function nextCron(expression: string, afterMs: number, timeZone: string): number | undefined {
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = expression.trim().split(/\s+/u);
  const minutes = field(minute, 0, 59);
  const hours = field(hour, 0, 23);
  const days = field(day, 1, 31);
  const months = field(month, 1, 12);
  const weekdays = field(weekday, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return undefined;
  const dayOk = (wall: Date): boolean => {
    const inMonth = days.has(wall.getUTCDate());
    const inWeek = weekdays.has(wall.getUTCDay()) || (wall.getUTCDay() === 0 && weekdays.has(7));
    return day !== "*" && weekday !== "*" ? inMonth || inWeek : inMonth && inWeek;
  };
  let at = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  /** The moment the wall clock reaches `to` (a later time of the same clock), or the minute after `at` when the clock was set in between and passed it. */
  const until = (wall: Date, to: number): number => {
    const reached = at + (to - wall.getTime());
    const past = wallClock(reached, timeZone).getTime() - to;
    return Math.max(at + 60_000, past > 0 ? reached - past : reached);
  };
  // Whole days and hours that cannot match are stepped over, so a year is a few thousand steps.
  for (let steps = 0; steps < 100_000; steps += 1) {
    const wall = wallClock(at, timeZone);
    if (!months.has(wall.getUTCMonth() + 1) || !dayOk(wall)) at = until(wall, Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1));
    else if (!hours.has(wall.getUTCHours())) at = until(wall, Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours() + 1));
    else if (!minutes.has(wall.getUTCMinutes())) at += 60_000;
    else return at;
  }
  return undefined;
}


/** True when five cron fields name at least one time (a schedule that can fire). */
export const isCron = (expression: string): boolean => nextCron(expression, Date.UTC(2024, 0, 1), "UTC") !== undefined;
