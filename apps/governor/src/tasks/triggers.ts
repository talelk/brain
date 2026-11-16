import type { SnapshotManifest } from "@brain/contracts";
import type { Governor } from "../app";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { SYSTEM } from "../events";
import { manifestOf } from "../workspace/store";
import { settle } from "./orchestrator";
import { createFromPlay, TERMINAL, type TaskRow } from "./store";

/** Triggers (docs/architecture.md section 9): what starts a Play without a person. Schedules run here; webhook bindings are read by integrations/github.ts. */

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

/** A time that passed this long ago was missed (the Governor was not running) and is not made up for. */
const MISSED_AFTER_MS = 5 * 60_000;

/**
 * Keeps a workspace's triggers in step with the Plays of the snapshot being activated. A trigger that did not change keeps its last task
 * and a time that is already due; a time still to come is read again, in the workspace's time zone as it is now.
 */
function refresh(gov: Gov, workspaceId: string, manifest: SnapshotManifest): void {
  const wanted = new Map<string, { kind: "schedule" | "webhook"; spec: string }>();
  for (const [name, play] of Object.entries(manifest.plays)) {
    if (play.trigger?.schedule) wanted.set(name, { kind: "schedule", spec: play.trigger.schedule });
    else if (play.trigger?.webhook) wanted.set(name, { kind: "webhook", spec: play.trigger.webhook });
  }
  const now = gov.clock.nowMs();
  for (const row of gov.db.prepare("SELECT play, kind, spec FROM triggers WHERE workspace_id=?").all(workspaceId) as Array<{ play: string; kind: string; spec: string }>) {
    const same = wanted.get(row.play);
    if (same?.kind === row.kind && same.spec === row.spec) {
      wanted.delete(row.play);
      if (row.kind === "schedule") gov.db.prepare("UPDATE triggers SET next_run_at_ms=? WHERE workspace_id=? AND play=? AND next_run_at_ms>?").run(nextCron(row.spec, now, manifest.timezone) ?? null, workspaceId, row.play, now);
    } else gov.db.prepare("DELETE FROM triggers WHERE workspace_id=? AND play=?").run(workspaceId, row.play);
  }
  for (const [play, { kind, spec }] of wanted) {
    gov.db.prepare("INSERT INTO triggers(workspace_id, play, kind, spec, next_run_at_ms) VALUES (?,?,?,?,?)").run(workspaceId, play, kind, spec, kind === "schedule" ? (nextCron(spec, now, manifest.timezone) ?? null) : null);
  }
}

/** Starts every scheduled Play whose time has come. Times missed while the Governor was down are not replayed; an occurrence is skipped while the one before it still runs. */
export function runSchedules(gov: Gov): void {
  tx(gov.db, () => {
    const now = gov.clock.nowMs();
    const due = gov.db.prepare(`SELECT g.workspace_id, g.play, g.spec, g.next_run_at_ms AS at, g.last_task_id, w.active_snapshot FROM triggers g JOIN workspaces w ON w.id = g.workspace_id
      WHERE g.kind='schedule' AND g.next_run_at_ms<=? AND w.status='active'`).all(now) as Array<{ workspace_id: string; play: string; spec: string; at: number; last_task_id: string | null; active_snapshot: string }>;
    for (const trigger of due) {
      const last = trigger.last_task_id === null ? undefined : (gov.db.prepare("SELECT state FROM tasks WHERE id=?").get(trigger.last_task_id) as Pick<TaskRow, "state"> | undefined);
      const next = nextCron(trigger.spec, now, manifestOf(gov, trigger.active_snapshot).timezone) ?? null;
      if (now - trigger.at > MISSED_AFTER_MS || (last && !TERMINAL.includes(last.state))) {
        gov.db.prepare("UPDATE triggers SET next_run_at_ms=? WHERE workspace_id=? AND play=?").run(next, trigger.workspace_id, trigger.play);
        continue;
      }
      const root = createFromPlay(gov, SYSTEM, { workspaceId: trigger.workspace_id, snapshotDigest: trigger.active_snapshot, play: trigger.play, inputs: {}, createdBy: `trigger:${trigger.play}` });
      gov.db.prepare("UPDATE triggers SET next_run_at_ms=?, last_run_at_ms=?, last_task_id=? WHERE workspace_id=? AND play=?").run(next, now, root.id, trigger.workspace_id, trigger.play);
      settle(gov, trigger.workspace_id);
    }
  });
}

export function registerTriggers(governor: Governor): void {
  const { gov } = governor;
  gov.onActivate.push((workspaceId, manifest) => refresh(gov, workspaceId, manifest));
  governor.every(20_000, () => runSchedules(gov));
}
