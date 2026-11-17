import type { TaskState, Usage } from "@brain/contracts";
import { intlLocale, locale, t, tn } from "../i18n";

/** How the app writes money, time, sizes and hashes. Money arrives in micro-USD, times in milliseconds. */

/** A name inside a right-to-left sentence, kept in one piece (Unicode first-strong isolate). */
export const isolate = (name: string): string => (locale() === "ar" ? `\u2068${name}\u2069` : name);

export function money(microUsd: number): string {
  const usd = microUsd / 1_000_000;
  const digits = usd !== 0 && Math.abs(usd) < 0.1 ? 3 : 2;
  return new Intl.NumberFormat(intlLocale(), { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: digits }).format(usd);
}

export function count(value: number): string {
  return new Intl.NumberFormat(intlLocale(), { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export const tokens = (usage: Usage): string => t("cost.tokens", { input: count(usage.inputTokens), output: count(usage.outputTokens) });

export function bytes(value: number): string {
  const units = ["B", "kB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit += 1; }
  return `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: size < 10 && unit > 0 ? 1 : 0 }).format(size)} ${units[unit]}`;
}

/** "3 minutes ago", "yesterday"; a date once it is more than a week old. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return t("time.now");
  const relative = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return day(at);
}

export const day = (at: number): string => new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short", year: "numeric" }).format(at);
export const dateTime = (at: number): string => new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return tn("time.seconds", seconds);
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? tn("time.minutes", minutes) : tn("time.hours", Math.round(minutes / 60));
}

/** The first characters of a commit or a digest, for details only. */
export const shortHash = (value: string): string => value.replace(/^sha256:/u, "").slice(0, 8);

/** The state a goal or group is shown in: running, but with something under it waiting for a person, it needs one. */
export const shownState = (task: { readonly state: TaskState; readonly waitingForYou: number }): TaskState => (task.state === "running" && task.waitingForYou > 0 ? "needs_you" : task.state);

export const stateLabel = (state: TaskState): string => t(`state.${state}`);

/** A JSON value as one readable line or block. */
export const show = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");

/** A task's title for people. A Play's step is titled by its id (`open-pr`), shown as words ("Open pr"). */
export function titleOf(task: { readonly title: string; readonly stepId: string | null }): string {
  if (task.title !== task.stepId) return task.title;
  const words = task.title.replace(/[-_]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
