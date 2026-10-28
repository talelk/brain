import { BrainDomainError } from "../../domain/errors";

// Five-field cron with IANA time zones and declared DST misfire policy:
// - a wall time inside a spring-forward gap fires once at the first valid
//   local minute after the gap;
// - a repeated wall time (fall-back) fires once, at its first occurrence;
// - every fire has a unique identity (scheduleId@utcMinute) so replays dedupe;
// - catch-up is bounded: "skip" drops missed fires, "once" emits at most the
//   single latest missed fire.
export interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly dom: ReadonlySet<number> | null;
  readonly months: ReadonlySet<number>;
  readonly dow: ReadonlySet<number> | null;
}

function parseField(text: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const stepMatch = /^([^/]+)\/(\d+)$/.exec(part);
    const base = stepMatch ? stepMatch[1]! : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isSafeInteger(step) || step < 1) throw new BrainDomainError("INVALID_CONTRACT", `cron ${label}: bad step in ${text}`);
    let lo = min, hi = max;
    if (base !== "*") {
      const range = /^(\d+)-(\d+)$/.exec(base);
      if (range) { lo = Number(range[1]); hi = Number(range[2]); }
      else if (/^\d+$/.test(base)) { lo = hi = Number(base); }
      else throw new BrainDomainError("INVALID_CONTRACT", `cron ${label}: unsupported token ${base}`);
    }
    if (lo < min || hi > max || lo > hi) throw new BrainDomainError("INVALID_CONTRACT", `cron ${label}: ${lo}-${hi} outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new BrainDomainError("INVALID_CONTRACT", `cron ${label}: empty`);
  return out;
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new BrainDomainError("INVALID_CONTRACT", `cron must have 5 fields: ${expression}`);
  const [mi, ho, dom, mo, dow] = fields as [string, string, string, string, string];
  return {
    minutes: parseField(mi, 0, 59, "minute"),
    hours: parseField(ho, 0, 23, "hour"),
    dom: dom === "*" ? null : parseField(dom, 1, 31, "day-of-month"),
    months: parseField(mo, 1, 12, "month"),
    dow: dow === "*" ? null : new Set([...parseField(dow, 0, 7, "day-of-week")].map((d) => (d === 7 ? 0 : d))),
  };
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(timeZone: string, utcMs: number): LocalParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    });
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[String(parts["weekday"])] ?? 0;
  return {
    year: Number(parts["year"]), month: Number(parts["month"]), day: Number(parts["day"]),
    hour: Number(parts["hour"]) % 24, minute: Number(parts["minute"]), weekday,
  };
}

function dayMatches(spec: CronSpec, p: LocalParts): boolean {
  if (!spec.months.has(p.month)) return false;
  const domOk = spec.dom === null || spec.dom.has(p.day);
  const dowOk = spec.dow === null || spec.dow.has(p.weekday);
  // Vixie rule: when both dom and dow are restricted, either match fires.
  if (spec.dom !== null && spec.dow !== null) return domOk || dowOk;
  return domOk && dowOk;
}

// All fire instants (UTC ms, minute-aligned) whose local date is the local
// date containing `dayProbeUtcMs`, honoring the DST policy above.
function firesOnLocalDay(spec: CronSpec, timeZone: string, dayProbeUtcMs: number): number[] {
  const probe = localParts(timeZone, dayProbeUtcMs);
  if (!dayMatches(spec, probe)) return [];
  const dayKey = `${probe.year}-${probe.month}-${probe.day}`;
  const start = Date.UTC(probe.year, probe.month - 1, probe.day) - 16 * 3600_000;
  const end = Date.UTC(probe.year, probe.month - 1, probe.day) + 40 * 3600_000;
  const byWall = new Map<string, number>(); // wall HH:MM -> first UTC instant
  const wallOrder: string[] = [];
  for (let t = Math.floor(start / 60_000) * 60_000; t <= end; t += 60_000) {
    const p = localParts(timeZone, t);
    if (`${p.year}-${p.month}-${p.day}` !== dayKey) continue;
    if (!spec.hours.has(p.hour) || !spec.minutes.has(p.minute)) continue;
    const wall = `${p.hour}:${p.minute}`;
    if (!byWall.has(wall)) { byWall.set(wall, t); wallOrder.push(wall); }
  }
  const fires = [...byWall.values()];
  // Gap policy: a candidate wall time with no instant today fires at the
  // first valid local minute after the gap.
  const candidates: string[] = [];
  for (const h of [...spec.hours].sort((a, b) => a - b)) {
    for (const m of [...spec.minutes].sort((a, b) => a - b)) candidates.push(`${h}:${m}`);
  }
  for (const wall of candidates) {
    if (byWall.has(wall)) continue;
    const [h, m] = wall.split(":").map(Number) as [number, number];
    for (let t = Math.floor(start / 60_000) * 60_000; t <= end; t += 60_000) {
      const p = localParts(timeZone, t);
      if (`${p.year}-${p.month}-${p.day}` !== dayKey) continue;
      if (p.hour * 60 + p.minute > h * 60 + m) { fires.push(t); break; }
    }
  }
  void wallOrder;
  return [...new Set(fires)].sort((a, b) => a - b);
}

export function nextCronFire(spec: CronSpec, timeZone: string, afterMs: number): number | null {
  let probe = Math.floor(afterMs / 60_000) * 60_000;
  for (let day = 0; day < 732; day++) {
    for (const fire of firesOnLocalDay(spec, timeZone, probe)) {
      if (fire > afterMs) return fire;
    }
    probe += 24 * 3600_000;
  }
  return null;
}

export function cronFireId(scheduleId: string, utcMs: number): string {
  return `${scheduleId}@${Math.floor(utcMs / 60_000)}`;
}

export function dueCronFires(
  spec: CronSpec, timeZone: string, lastFireMs: number, nowMs: number,
  misfire: "skip" | "once",
): number[] {
  const missed: number[] = [];
  let cursor = lastFireMs;
  for (let i = 0; i < 10_000; i++) {
    const next = nextCronFire(spec, timeZone, cursor);
    if (next === null || next > nowMs) break;
    missed.push(next);
    cursor = next;
  }
  if (misfire === "skip") return [];
  return missed.length > 0 ? [missed[missed.length - 1]!] : [];
}
