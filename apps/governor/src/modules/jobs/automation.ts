import { domainDigest } from "@brain/contracts";
import type { ActorContext, Automation, AutomationOccurrence, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { assertExpectedVersion, assertTransition } from "../../domain/states";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { nextCronFire, parseCron } from "../workflows/index";

/**
 * T52 unified automation: one durable scheduler for WorkItems and compiled
 * workflows. Triggers are cron, one-off delayed or manual; every planned
 * instant materializes as an immutable occurrence keyed by
 * (automation, revision, instant), so replay, Governor restart and lost
 * responses cannot duplicate a run — the occurrence id is the workflow
 * execution key. Revisions never rewrite the past: an upsert creates a new
 * revision whose cron anchor is the upsert instant, while existing
 * occurrences keep their original revision. Pause/resume and Run now are
 * governed SQLite operations on this same model.
 */

type AutomationRow = {
  id: string; title: string; state: "active" | "paused"; revision: number;
  target_kind: "workflow" | "workItem"; target_id: string;
  trigger_kind: "cron" | "once" | "manual"; cron: string | null; timezone: string | null;
  scheduled_at_ms: number | null; input_json: string | null;
  overlap: "skip" | "queue-one"; misfire: "skip" | "coalesce";
  execution_mode: "managed" | "personal-host"; runner_id: string | null; offline_policy: "wait" | "fail";
  created_by: string; version: number; revision_created_at_ms: number;
  created_at_ms: number; updated_at_ms: number;
};
type OccurrenceRow = {
  id: string; automation_id: string; revision: number; planned_at_ms: number;
  state: "pending" | "dispatched" | "skipped" | "failed";
  dispatch_ref: string | null; detail: string | null; fired_at_ms: number | null;
};

export interface AutomationCommand {
  readonly commandType: string;
  readonly workspaceId?: string;
  readonly expectedVersion?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AutomationDispatchDeps {
  resolveWorkflow: (organizationId: string, workflowId: string) => { workflow: unknown; configDigest: string };
  startRun: (input: { organizationId: string; workspaceId: string; actorId: string; workflowId: string; workflow: unknown; configDigest: string; runInput: JsonValue; executionKey: string; runnerId?: string }) => { runId: string };
}

const FINISHED_RUN_STATES = new Set(["succeeded", "failed", "cancelled", "partial"]);
const ONCE_LATE_GRACE_MS = 60_000;
/** Fires older than this horizon are "missed" for the skip misfire policy. */
const MISFIRE_GRACE_MS = 60_000;

export function occurrenceId(automationId: string, revision: number, plannedAtMs: number): string {
  return domainDigest("brain:automation-occurrence:v1", { automationId, revision, plannedAtMs } as unknown as JsonValue);
}

/** Due planned instants for one automation revision. */
export function plannedInstants(row: Pick<AutomationRow, "trigger_kind" | "cron" | "timezone" | "scheduled_at_ms" | "revision_created_at_ms" | "misfire">, lastPlannedMs: number | null, nowMs: number): { dispatch: number[]; markSkipped: number[] } {
  if (row.trigger_kind === "manual") return { dispatch: [], markSkipped: [] };
  if (row.trigger_kind === "once") {
    const at = row.scheduled_at_ms ?? 0;
    if (lastPlannedMs !== null || at > nowMs) return { dispatch: [], markSkipped: [] };
    if (row.misfire === "skip" && nowMs - at > ONCE_LATE_GRACE_MS) return { dispatch: [], markSkipped: [at] };
    return { dispatch: [at], markSkipped: [] };
  }
  if (!row.cron) return { dispatch: [], markSkipped: [] };
  const spec = parseCron(row.cron);
  // Enumerate every missed fire (bounded); the policy then decides dispatch.
  const missed: number[] = [];
  let cursor = lastPlannedMs ?? row.revision_created_at_ms;
  for (let i = 0; i < 10_000 && missed.length < 1000; i++) {
    const next = nextCronFire(spec, row.timezone ?? "UTC", cursor);
    if (next === null || next > nowMs) break;
    missed.push(next);
    cursor = next;
  }
  if (missed.length === 0) return { dispatch: [], markSkipped: [] };
  if (row.misfire !== "skip") return { dispatch: [missed[missed.length - 1]!], markSkipped: [] };
  // skip: missed fires (older than the grace horizon) are recorded as skipped
  // history; fires inside the horizon still dispatch.
  const horizon = nowMs - MISFIRE_GRACE_MS;
  return {
    dispatch: missed.filter((fire) => fire > horizon),
    markSkipped: missed.filter((fire) => fire <= horizon),
  };
}

export class AutomationService {
  constructor(private readonly store: Store, private readonly deps: AutomationDispatchDeps) {}

  private db(actor: ActorContext, workspaceId: string) {
    requireWorkspaceRead(this.store, actor, workspaceId);
    return this.store.workspaceDb(workspaceId, actor.organizationId);
  }

  private row(actor: ActorContext, workspaceId: string, id: string): AutomationRow {
    const row = this.db(actor, workspaceId).prepare("SELECT * FROM automations WHERE id=?").get(id) as AutomationRow | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "automation not found");
    return row;
  }

  private static automation(row: AutomationRow, nextOccurrences?: number[]): Automation {
    return {
      automationId: row.id, title: row.title, state: row.state, revision: row.revision,
      target: { kind: row.target_kind, id: row.target_id },
      trigger: row.trigger_kind === "cron" ? { kind: "cron", cron: row.cron ?? "", timezone: row.timezone ?? "UTC" }
        : row.trigger_kind === "once" ? { kind: "once", scheduledAt: iso(row.scheduled_at_ms ?? 0) }
        : { kind: "manual" },
      ...(row.input_json ? { input: JSON.parse(row.input_json) as JsonValue } : {}),
      overlap: row.overlap, misfire: row.misfire,
      execution: row.execution_mode === "personal-host" ? { mode: "personal-host", runnerId: row.runner_id ?? "", offlinePolicy: row.offline_policy } : { mode: "managed" },
      createdBy: row.created_by, version: row.version,
      ...(nextOccurrences ? { nextOccurrences: nextOccurrences.map(iso) } : {}),
      createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms),
    };
  }

  private static occurrence(workspaceId: string, row: OccurrenceRow): AutomationOccurrence {
    return {
      occurrenceId: row.id, automationId: row.automation_id, workspaceId, revision: row.revision,
      plannedAt: iso(row.planned_at_ms), state: row.state,
      ...(row.dispatch_ref ? { dispatchRef: row.dispatch_ref } : {}),
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.fired_at_ms ? { firedAt: iso(row.fired_at_ms) } : {}),
    };
  }

  apply(actor: ActorContext, command: AutomationCommand): string {
    const workspaceId = command.workspaceId;
    if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
    switch (command.commandType) {
      case "automation.upsert": return this.upsert(actor, workspaceId, command.payload, command.expectedVersion);
      case "automation.control": return this.control(actor, workspaceId, command.payload, command.expectedVersion);
      default: throw new BrainDomainError("INVALID_CONTRACT", `unsupported automation command ${command.commandType}`);
    }
  }

  private upsert(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const target = payload["target"] as { kind?: string; id?: string } | undefined;
    const trigger = payload["trigger"] as { kind?: string; cron?: string; timezone?: string; scheduledAt?: string } | undefined;
    if (!target?.id || (target.kind !== "workflow" && target.kind !== "workItem")) throw new BrainDomainError("INVALID_ARGUMENT", "target must be a workflow or workItem id");
    const kind = trigger?.kind;
    if (kind !== "cron" && kind !== "once" && kind !== "manual") throw new BrainDomainError("INVALID_ARGUMENT", "trigger kind must be cron, once or manual");
    let cron: string | null = null;
    let timezone: string | null = null;
    let scheduledAtMs: number | null = null;
    if (kind === "cron") {
      cron = String(trigger?.cron ?? "");
      timezone = String(trigger?.timezone ?? "UTC");
      try {
        const spec = parseCron(cron);
        if (!nextCronFire(spec, timezone, this.store.now())) throw new Error("no future fire");
      } catch {
        throw new BrainDomainError("INVALID_ARGUMENT", "trigger needs a valid cron expression and IANA timezone");
      }
    } else if (kind === "once") {
      scheduledAtMs = Date.parse(String(trigger?.scheduledAt ?? ""));
      if (!Number.isFinite(scheduledAtMs) || scheduledAtMs <= this.store.now()) throw new BrainDomainError("INVALID_ARGUMENT", "once trigger needs a future scheduledAt");
    }
    const overlap = payload["overlap"] === "queue-one" ? "queue-one" as const : "skip" as const;
    const misfire = payload["misfire"] === "coalesce" ? "coalesce" as const : "skip" as const;
    const execution = payload["execution"] as { mode?: string; runnerId?: string; offlinePolicy?: string } | undefined;
    const executionMode = execution?.mode === "personal-host" ? "personal-host" as const : execution?.mode === undefined || execution.mode === "managed" ? "managed" as const : undefined;
    if (!executionMode) throw new BrainDomainError("INVALID_ARGUMENT", "execution mode must be managed or personal-host");
    const runnerId = executionMode === "personal-host" ? String(execution?.runnerId ?? "") : null;
    if (executionMode === "personal-host" && (!runnerId || !this.store.control.prepare("SELECT 1 FROM runners WHERE id=? AND organization_id=?").get(runnerId, actor.organizationId))) {
      throw new BrainDomainError("NOT_FOUND", "personal-host runner not found in this organization");
    }
    const offlinePolicy = execution?.offlinePolicy === "fail" ? "fail" as const : "wait" as const;
    const input = payload["input"] === undefined ? null : JSON.stringify(payload["input"]);
    const db = this.db(actor, workspaceId);
    const existingId = payload["automationId"] ? String(payload["automationId"]) : "";
    const now = this.store.now();
    if (!existingId) {
      const id = this.store.id("auto");
      this.store.inTx(db, () => {
        db.prepare(`INSERT INTO automations(id,title,state,revision,target_kind,target_id,trigger_kind,cron,timezone,scheduled_at_ms,input_json,overlap,misfire,execution_mode,runner_id,offline_policy,created_by,version,revision_created_at_ms,created_at_ms,updated_at_ms)
          VALUES (?,?,'active',1,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
          .run(id, String(payload["title"] ?? "Automation"), target.kind, target.id, kind, cron, timezone, scheduledAtMs, input, overlap, misfire, executionMode, runnerId, offlinePolicy, actor.actorId, now, now, now);
        this.store.emit(db, { aggregateType: "automation", aggregateId: id, eventType: "automation.created", payload: { automationId: id } });
      });
      return id;
    }
    const existing = this.row(actor, workspaceId, existingId);
    assertExpectedVersion(existing.version, expectedVersion);
    this.store.inTx(db, () => {
      db.prepare(`UPDATE automations SET title=?,target_kind=?,target_id=?,trigger_kind=?,cron=?,timezone=?,scheduled_at_ms=?,input_json=?,overlap=?,misfire=?,execution_mode=?,runner_id=?,offline_policy=?,revision=revision+1,revision_created_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?`)
        .run(String(payload["title"] ?? existing.title), target.kind, target.id, kind, cron, timezone, scheduledAtMs, input, overlap, misfire, executionMode, runnerId, offlinePolicy, now, now, existing.id, existing.version);
      this.store.emit(db, { aggregateType: "automation", aggregateId: existing.id, eventType: "automation.revised", payload: { automationId: existing.id, revision: existing.revision + 1 } });
    });
    return existing.id;
  }

  private control(actor: ActorContext, workspaceId: string, payload: Readonly<Record<string, unknown>>, expectedVersion?: number): string {
    const automation = this.row(actor, workspaceId, String(payload["automationId"]));
    assertExpectedVersion(automation.version, expectedVersion);
    const action = String(payload["action"]);
    if (action !== "pause" && action !== "resume" && action !== "runNow") throw new BrainDomainError("INVALID_ARGUMENT", "action must be pause, resume or runNow");
    const db = this.db(actor, workspaceId);
    if (action === "pause" || action === "resume") {
      const next = action === "pause" ? "paused" : "active";
      if (automation.state !== next) {
        this.store.inTx(db, () => {
          db.prepare("UPDATE automations SET state=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?").run(next, this.store.now(), automation.id, automation.version);
          this.store.emit(db, { aggregateType: "automation", aggregateId: automation.id, eventType: `automation.${action}d`, payload: { automationId: automation.id } });
        });
      }
      return automation.id;
    }
    // runNow: an explicit occurrence at the current instant, dispatched through
    // the same governed path as pass-dispatched occurrences.
    const now = this.store.now();
    const id = occurrenceId(automation.id, automation.revision, now);
    this.store.inTx(db, () => {
      db.prepare("INSERT OR IGNORE INTO automation_occurrences(id,automation_id,revision,planned_at_ms,state) VALUES (?,?,?,?,'pending')").run(id, automation.id, automation.revision, now);
      this.store.emit(db, { aggregateType: "automation", aggregateId: automation.id, eventType: "automation.run_now", payload: { automationId: automation.id, occurrenceId: id } });
    });
    const fresh = this.row(actor, workspaceId, automation.id);
    this.dispatchDue(actor.organizationId, workspaceId, fresh, [occurrenceRowFor(id, automation.id, automation.revision, now)]);
    return automation.id;
  }

  /** Materialize due occurrences for every active automation, then dispatch them. */
  dispatchAll(): { dispatched: number; skipped: number } {
    let dispatched = 0;
    let skipped = 0;
    const now = this.store.now();
    const orgs = this.store.control.prepare("SELECT id FROM organizations").all() as Array<{ id: string }>;
    for (const { id: organizationId } of orgs) {
      const workspaces = this.store.control.prepare("SELECT id FROM workspaces WHERE organization_id=? AND status='active'").all(organizationId) as Array<{ id: string }>;
      for (const { id: workspaceId } of workspaces) {
        const db = this.store.workspaceDb(workspaceId, organizationId);
        const automations = db.prepare("SELECT * FROM automations WHERE state='active'").all() as AutomationRow[];
        for (const automation of automations) {
          const last = db.prepare("SELECT MAX(planned_at_ms) AS m FROM automation_occurrences WHERE automation_id=? AND revision=?").get(automation.id, automation.revision) as { m: number | null };
          const due = plannedInstants(automation, last.m, now);
          const rows: OccurrenceRow[] = [];
          for (const plannedAtMs of due.markSkipped) {
            const id = occurrenceId(automation.id, automation.revision, plannedAtMs);
            const ins = db.prepare("INSERT OR IGNORE INTO automation_occurrences(id,automation_id,revision,planned_at_ms,state,detail) VALUES (?,?,?,?,?,'missed under the skip misfire policy')").run(id, automation.id, automation.revision, plannedAtMs, "skipped");
            if (ins.changes > 0) rows.push({ ...occurrenceRowFor(id, automation.id, automation.revision, plannedAtMs), state: "skipped" });
          }
          for (const plannedAtMs of due.dispatch) {
            const id = occurrenceId(automation.id, automation.revision, plannedAtMs);
            const ins = db.prepare("INSERT OR IGNORE INTO automation_occurrences(id,automation_id,revision,planned_at_ms,state) VALUES (?,?,?,?,'pending')").run(id, automation.id, automation.revision, plannedAtMs);
            if (ins.changes > 0) rows.push(occurrenceRowFor(id, automation.id, automation.revision, plannedAtMs));
          }
          const pending = db.prepare("SELECT * FROM automation_occurrences WHERE automation_id=? AND state='pending' ORDER BY planned_at_ms,id").all(automation.id) as OccurrenceRow[];
          const occurrences = new Map(rows.map((row) => [row.id, row]));
          for (const row of pending) occurrences.set(row.id, row);
          const result = this.dispatchDue(organizationId, workspaceId, automation, [...occurrences.values()]);
          dispatched += result.dispatched;
          skipped += result.skipped;
        }
      }
    }
    return { dispatched, skipped };
  }

  private dispatchDue(organizationId: string, workspaceId: string, automation: AutomationRow, occurrences: OccurrenceRow[]): { dispatched: number; skipped: number } {
    let dispatched = 0;
    let skipped = 0;
    if (occurrences.length === 0) return { dispatched, skipped };
    const db = this.store.workspaceDb(workspaceId, organizationId);
    for (const occurrence of occurrences) {
      if (occurrence.state !== "pending") { skipped++; continue; }
      if (automation.target_kind === "workflow") {
        if (automation.execution_mode === "personal-host") {
          const runnerId = automation.runner_id ?? "";
          const runner = this.store.control.prepare("SELECT admin_state,health,last_heartbeat_ms FROM runners WHERE id=? AND organization_id=?").get(runnerId, organizationId) as
            | { admin_state: string; health: string; last_heartbeat_ms: number | null } | undefined;
          const available = runner?.admin_state === "enabled" && runner.health !== "unhealthy" && Number(runner.last_heartbeat_ms ?? 0) > this.store.now() - 45_000;
          if (!available) {
            const detail = `personal host ${runnerId} is offline or unavailable; offline policy ${automation.offline_policy}`;
            if (automation.offline_policy === "fail") {
              this.finish(db, occurrence, "failed", null, detail);
              skipped++;
            } else {
              db.prepare("UPDATE automation_occurrences SET detail=? WHERE id=? AND state='pending'").run(detail, occurrence.id);
            }
            continue;
          }
        }
        if (automation.overlap === "skip" && this.lastDispatchStillRunning(db, automation.id)) {
          this.finish(db, occurrence, "skipped", null, "previous occurrence is still running");
          skipped++;
          continue;
        }
        try {
          const { workflow, configDigest } = this.deps.resolveWorkflow(organizationId, automation.target_id);
          const { runId } = this.deps.startRun({
            organizationId, workspaceId, actorId: `automation:${automation.id}`, workflowId: automation.target_id, workflow, configDigest,
            runInput: (automation.input_json ? JSON.parse(automation.input_json) : null) as JsonValue,
            executionKey: occurrence.id,
            ...(automation.execution_mode === "personal-host" ? { runnerId: automation.runner_id ?? "" } : {}),
          });
          this.finish(db, occurrence, "dispatched", runId, null);
          dispatched++;
        } catch (reason) {
          this.finish(db, occurrence, "failed", null, reason instanceof Error ? reason.message.slice(0, 500) : "dispatch failed");
          skipped++;
        }
        continue;
      }
      // workItem target: the scheduled start releases a waiting work item.
      assertTransition("workItem", "backlog", "ready");
      const item = db.prepare("SELECT id,state FROM work_items WHERE id=?").get(automation.target_id) as { id: string; state: string } | undefined;
      if (!item || item.state !== "backlog") {
        this.finish(db, occurrence, "skipped", null, item ? `work item is ${item.state}` : "work item not found");
        skipped++;
        continue;
      }
      db.prepare("UPDATE work_items SET state='ready',next_action='Start this task',version=version+1,updated_at_ms=? WHERE id=? AND state='backlog'").run(this.store.now(), item.id);
      this.finish(db, occurrence, "dispatched", item.id, null);
      dispatched++;
    }
    return { dispatched, skipped };
  }

  private lastDispatchStillRunning(db: ReturnType<Store["workspaceDb"]>, automationId: string): boolean {
    const last = db.prepare("SELECT dispatch_ref FROM automation_occurrences WHERE automation_id=? AND state='dispatched' ORDER BY planned_at_ms DESC, id DESC LIMIT 1").get(automationId) as { dispatch_ref: string | null } | undefined;
    if (!last?.dispatch_ref) return false;
    const run = db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(last.dispatch_ref) as { state: string } | undefined;
    return Boolean(run && !FINISHED_RUN_STATES.has(run.state));
  }

  private finish(db: ReturnType<Store["workspaceDb"]>, occurrence: OccurrenceRow, state: OccurrenceRow["state"], dispatchRef: string | null, detail: string | null): void {
    db.prepare("UPDATE automation_occurrences SET state=?,dispatch_ref=?,detail=?,fired_at_ms=? WHERE id=? AND state='pending'")
      .run(state, dispatchRef, detail, this.store.now(), occurrence.id);
  }

  query(actor: ActorContext, queryType: string, workspaceId: string, resourceId?: string, limit = 100): JsonValue {
    const db = this.db(actor, workspaceId);
    if (queryType === "automations.list") {
      const rows = db.prepare("SELECT * FROM automations ORDER BY updated_at_ms DESC,id LIMIT ?").all(limit) as AutomationRow[];
      return { items: rows.map((row) => AutomationService.automation(row, this.preview(row))) } as unknown as JsonValue;
    }
    if (queryType === "automations.occurrences") {
      const rows = resourceId
        ? db.prepare("SELECT * FROM automation_occurrences WHERE automation_id=? ORDER BY planned_at_ms DESC,id LIMIT ?").all(resourceId, limit) as OccurrenceRow[]
        : db.prepare("SELECT * FROM automation_occurrences ORDER BY planned_at_ms DESC,id LIMIT ?").all(limit) as OccurrenceRow[];
      return { items: rows.map((row) => AutomationService.occurrence(workspaceId, row)) } as unknown as JsonValue;
    }
    throw new BrainDomainError("UNSUPPORTED_CAPABILITY", `unsupported automation query ${queryType}`);
  }

  /** Server-derived next planned instants; the UI never computes schedules. */
  private preview(row: AutomationRow): number[] {
    const now = this.store.now();
    if (row.state !== "active") return [];
    try {
      if (row.trigger_kind === "cron" && row.cron) {
        const spec = parseCron(row.cron);
        const fires: number[] = [];
        let cursor = now;
        while (fires.length < 5) {
          const next = nextCronFire(spec, row.timezone ?? "UTC", cursor);
          if (next === null) break;
          fires.push(next);
          cursor = next;
        }
        return fires;
      }
      if (row.trigger_kind === "once" && row.scheduled_at_ms && row.scheduled_at_ms > now) return [row.scheduled_at_ms];
    } catch { return []; }
    return [];
  }
}

function occurrenceRowFor(id: string, automationId: string, revision: number, plannedAtMs: number): OccurrenceRow {
  return { id, automation_id: automationId, revision, planned_at_ms: plannedAtMs, state: "pending", dispatch_ref: null, detail: null, fired_at_ms: null };
}
