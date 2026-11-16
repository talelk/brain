import type { SnapshotManifest } from "@brain/contracts";
import type { Governor } from "../app";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { SYSTEM } from "../events";
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

/**
 * The first minute after `afterMs` that a five-field cron expression names (minute, hour, day of month, month, day of week; lists, ranges
 * and steps), in the Governor's local time. When both day fields are restricted, either one matching is enough. Undefined for an
 * expression that names no time.
 */
export function nextCron(expression: string, afterMs: number): number | undefined {
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = expression.trim().split(/\s+/u);
  const minutes = field(minute, 0, 59);
  const hours = field(hour, 0, 23);
  const days = field(day, 1, 31);
  const months = field(month, 1, 12);
  const weekdays = field(weekday, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return undefined;
  const dayOk = (at: Date): boolean => {
    const inMonth = days.has(at.getDate());
    const inWeek = weekdays.has(at.getDay()) || (at.getDay() === 0 && weekdays.has(7));
    return day !== "*" && weekday !== "*" ? inMonth || inWeek : inMonth && inWeek;
  };
  const at = new Date(Math.floor(afterMs / 60_000) * 60_000 + 60_000);
  // Whole days and hours that cannot match are stepped over, so a year is a few thousand steps.
  for (let steps = 0; steps < 100_000; steps += 1) {
    if (!months.has(at.getMonth() + 1) || !dayOk(at)) at.setHours(24, 0, 0, 0);
    else if (!hours.has(at.getHours())) at.setHours(at.getHours() + 1, 0, 0, 0);
    else if (!minutes.has(at.getMinutes())) at.setMinutes(at.getMinutes() + 1, 0, 0);
    else return at.getTime();
  }
  return undefined;
}

/** A time that passed this long ago was missed (the Governor was not running) and is not made up for. */
const MISSED_AFTER_MS = 5 * 60_000;

/** Keeps a workspace's triggers in step with the Plays of the snapshot being activated. A trigger that did not change keeps its next time and its last task. */
function refresh(gov: Gov, workspaceId: string, manifest: SnapshotManifest): void {
  const wanted = new Map<string, { kind: "schedule" | "webhook"; spec: string }>();
  for (const [name, play] of Object.entries(manifest.plays)) {
    if (play.trigger?.schedule) wanted.set(name, { kind: "schedule", spec: play.trigger.schedule });
    else if (play.trigger?.webhook) wanted.set(name, { kind: "webhook", spec: play.trigger.webhook });
  }
  for (const row of gov.db.prepare("SELECT play, kind, spec FROM triggers WHERE workspace_id=?").all(workspaceId) as Array<{ play: string; kind: string; spec: string }>) {
    const same = wanted.get(row.play);
    if (same?.kind === row.kind && same.spec === row.spec) wanted.delete(row.play);
    else gov.db.prepare("DELETE FROM triggers WHERE workspace_id=? AND play=?").run(workspaceId, row.play);
  }
  for (const [play, { kind, spec }] of wanted) {
    gov.db.prepare("INSERT INTO triggers(workspace_id, play, kind, spec, next_run_at_ms) VALUES (?,?,?,?,?)").run(workspaceId, play, kind, spec, kind === "schedule" ? (nextCron(spec, gov.clock.nowMs()) ?? null) : null);
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
      const next = nextCron(trigger.spec, now) ?? null;
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
