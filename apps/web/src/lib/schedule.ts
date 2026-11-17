import { nextCron } from "@brain/contracts/cron";
import { intlLocale, t } from "../i18n";

/** Schedules as people say them: the presets of the form, the plain-words reading of a cron expression, and the next times in a time zone. */
export type Preset =
  | { readonly kind: "hourly"; readonly minute: number }
  | { readonly kind: "daily" | "weekdays"; readonly hour: number; readonly minute: number }
  | { readonly kind: "weekly"; readonly day: number; readonly hour: number; readonly minute: number }
  | { readonly kind: "monthly"; readonly date: number; readonly hour: number; readonly minute: number }
  | { readonly kind: "custom"; readonly cron: string };
export const PRESETS = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"] as const;

const n = "(\\d{1,2})";
/** The preset a cron expression is, when it is one of them; else `custom`. */
export function presetOf(cron: string): Preset {
  const text = cron.trim().replace(/\s+/gu, " ");
  const at = (pattern: string): number[] | undefined => new RegExp(`^${pattern}$`, "u").exec(text)?.slice(1).map(Number);
  let m: number[] | undefined;
  if ((m = at(`${n} \\* \\* \\* \\*`))) return { kind: "hourly", minute: m[0] ?? 0 };
  if ((m = at(`${n} ${n} \\* \\* \\*`))) return { kind: "daily", minute: m[0] ?? 0, hour: m[1] ?? 0 };
  if ((m = at(`${n} ${n} \\* \\* 1-5`))) return { kind: "weekdays", minute: m[0] ?? 0, hour: m[1] ?? 0 };
  if ((m = at(`${n} ${n} \\* \\* ([0-7])`))) return { kind: "weekly", minute: m[0] ?? 0, hour: m[1] ?? 0, day: (m[2] ?? 0) % 7 };
  if ((m = at(`${n} ${n} ${n} \\* \\*`))) return { kind: "monthly", minute: m[0] ?? 0, hour: m[1] ?? 0, date: m[2] ?? 1 };
  return { kind: "custom", cron: text };
}

export function cronOf(preset: Preset): string {
  switch (preset.kind) {
    case "hourly": return `${preset.minute} * * * *`;
    case "daily": return `${preset.minute} ${preset.hour} * * *`;
    case "weekdays": return `${preset.minute} ${preset.hour} * * 1-5`;
    case "weekly": return `${preset.minute} ${preset.hour} * * ${preset.day}`;
    case "monthly": return `${preset.minute} ${preset.hour} ${preset.date} * *`;
    case "custom": return preset.cron;
  }
}

const two = (value: number): string => String(value).padStart(2, "0");
export const clock = (hour: number, minute: number): string => `${two(hour)}:${two(minute)}`;
/** A weekday's name in the language of the page (0 is Sunday). */
export const weekday = (day: number): string => new Intl.DateTimeFormat(intlLocale(), { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2024, 0, 7 + day));

/** "Every Monday at 08:00, Africa/Tunis"; the raw expression for a shape that is not a preset. */
export function words(cron: string, timeZone: string): string {
  const p = presetOf(cron);
  const zone = timeZone;
  switch (p.kind) {
    case "hourly": return t("schedule.words.hourly", { minute: two(p.minute), zone });
    case "daily": return t("schedule.words.daily", { time: clock(p.hour, p.minute), zone });
    case "weekdays": return t("schedule.words.weekdays", { time: clock(p.hour, p.minute), zone });
    case "weekly": return t("schedule.words.weekly", { day: weekday(p.day), time: clock(p.hour, p.minute), zone });
    case "monthly": return t("schedule.words.monthly", { date: p.date, time: clock(p.hour, p.minute), zone });
    case "custom": return t("schedule.words.custom", { cron: p.cron, zone });
  }
}

/** The next `count` times a schedule fires after `from`, or none when it names no time. */
export function upcoming(cron: string, timeZone: string, count: number, from = Date.now()): number[] {
  const out: number[] = [];
  let at = from;
  for (let step = 0; step < count; step += 1) {
    const next = nextCron(cron, at, timeZone);
    if (next === undefined) break;
    out.push(next);
    at = next;
  }
  return out;
}

/** A moment on the clock of a time zone: "Mon 17 Nov, 08:00". */
export const inZone = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat(intlLocale(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at);

/** "github.issues.opened" as "on GitHub issues opened". */
export const webhookWords = (event: string): string => t("schedule.words.webhook", { event: event.split(".").slice(1).join(" ").replaceAll("_", " ") });
export const isValidCron = (cron: string, timeZone: string): boolean => cron.trim().split(/\s+/u).length === 5 && nextCron(cron, Date.now(), timeZone) !== undefined;
