import { BrainError, nextCron, type ScheduleItem, type SnapshotManifest, type TaskState } from "@brain/contracts";
import { visibleWorkspaces } from "../access";
import type { Governor } from "../app";
import { tx } from "../db";
import type { Gov } from "../dispatch";
import { SYSTEM } from "../events";
import { activeManifest, manifestOf } from "../workspace/store";
import { settle } from "./orchestrator";
import { createFromPlay, TERMINAL, type TaskRow } from "./store";

/** Triggers (docs/architecture.md section 9): what starts a Play without a person. Schedules run here; webhook bindings are read by integrations/github.ts. */

/** A time that passed this long ago was missed (the Governor was not running) and is not made up for. */
const MISSED_AFTER_MS = 5 * 60_000;

/**
 * Keeps a workspace's triggers in step with the Plays of the snapshot being activated. A trigger that did not change keeps its last task
 * and a time that is already due; a time still to come is read again, in the workspace's time zone as it is now. A paused schedule keeps its
 * row (and so its last start) with no next time; resumed, it is given one.
 */
function refresh(gov: Gov, workspaceId: string, manifest: SnapshotManifest): void {
  const wanted = new Map<string, { kind: "schedule" | "webhook"; spec: string; paused: boolean }>();
  for (const [name, play] of Object.entries(manifest.plays)) {
    if (play.trigger?.schedule) wanted.set(name, { kind: "schedule", spec: play.trigger.schedule, paused: play.trigger.paused === true });
    else if (play.trigger?.webhook) wanted.set(name, { kind: "webhook", spec: play.trigger.webhook, paused: false });
  }
  const now = gov.clock.nowMs();
  const nextOf = (spec: string, paused: boolean): number | null => (paused ? null : (nextCron(spec, now, manifest.timezone) ?? null));
  for (const row of gov.db.prepare("SELECT play, kind, spec FROM triggers WHERE workspace_id=?").all(workspaceId) as Array<{ play: string; kind: string; spec: string }>) {
    const same = wanted.get(row.play);
    if (same?.kind === row.kind && same.spec === row.spec) {
      wanted.delete(row.play);
      if (row.kind !== "schedule") continue;
      if (same.paused) gov.db.prepare("UPDATE triggers SET next_run_at_ms=NULL WHERE workspace_id=? AND play=?").run(workspaceId, row.play);
      else gov.db.prepare("UPDATE triggers SET next_run_at_ms=? WHERE workspace_id=? AND play=? AND (next_run_at_ms IS NULL OR next_run_at_ms>?)").run(nextOf(row.spec, false), workspaceId, row.play, now);
    } else gov.db.prepare("DELETE FROM triggers WHERE workspace_id=? AND play=?").run(workspaceId, row.play);
  }
  for (const [play, { kind, spec, paused }] of wanted) {
    gov.db.prepare("INSERT INTO triggers(workspace_id, play, kind, spec, next_run_at_ms) VALUES (?,?,?,?,?)").run(workspaceId, play, kind, spec, kind === "schedule" ? nextOf(spec, paused) : null);
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
  gov.registry.query("schedules.list", (ctx) => {
    if (!ctx.user) throw new BrainError("UNAUTHENTICATED", "Sign in first");
    const rows = gov.db.prepare("SELECT workspace_id, play, kind, next_run_at_ms, last_run_at_ms, last_task_id FROM triggers").all() as Array<{ workspace_id: string; play: string; kind: "schedule" | "webhook"; next_run_at_ms: number | null; last_run_at_ms: number | null; last_task_id: string | null }>;
    const row = new Map(rows.map((trigger) => [`${trigger.workspace_id}/${trigger.play}`, trigger]));
    const taskOf = (id: string): { id: string; state: TaskState; at: number } | undefined => gov.db.prepare("SELECT id, state, created_at_ms AS at FROM tasks WHERE id=?").get(id) as { id: string; state: TaskState; at: number } | undefined;
    const schedules: ScheduleItem[] = [];
    for (const workspace of visibleWorkspaces(gov, ctx.user.id).filter((entry) => entry.status === "active")) {
      const manifest = activeManifest(gov, workspace.id);
      for (const [play, spec] of Object.entries(manifest.plays)) {
        const trigger = spec.trigger;
        if (!trigger) continue;
        const kind = trigger.schedule ? "schedule" : "webhook";
        const kept = row.get(`${workspace.id}/${play}`);
        // A schedule remembers its last task; a webhook's last start is the latest goal a trigger made of that Play.
        const last = kind === "schedule" ? (kept?.last_task_id ? taskOf(kept.last_task_id) : undefined)
          : (gov.db.prepare("SELECT id, state, created_at_ms AS at FROM tasks WHERE workspace_id=? AND parent_id IS NULL AND created_by=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(workspace.id, `trigger:${play}`) as { id: string; state: TaskState; at: number } | undefined);
        schedules.push({
          workspaceId: workspace.id, workspaceSlug: workspace.slug, workspaceName: workspace.name, timezone: manifest.timezone, role: workspace.role,
          play, title: spec.title, translations: spec.translations, source: spec.source, kind, spec: trigger.schedule ?? trigger.webhook ?? "", paused: trigger.paused === true,
          nextRunAt: kind === "schedule" && trigger.paused !== true ? (kept?.next_run_at_ms ?? null) : null,
          lastRunAt: last?.at ?? null, lastTask: last ? { id: last.id, state: last.state } : null,
          skipsNext: kind === "schedule" && trigger.paused !== true && last !== undefined && !TERMINAL.includes(last.state),
          steps: spec.step.map((step) => ({ id: step.id, agent: step.agent ?? (Array.isArray(step.candidates) ? step.candidates.join(", ") : "") })),
        });
      }
    }
    return { schedules: schedules.sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.workspaceName.localeCompare(b.workspaceName) || a.play.localeCompare(b.play)) };
  });
  gov.onActivate.push((workspaceId, manifest) => refresh(gov, workspaceId, manifest));
  governor.every(20_000, () => runSchedules(gov));
}
