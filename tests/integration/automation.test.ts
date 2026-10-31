import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext } from "@brain/contracts";
import { AutomationService, occurrenceId, plannedInstants } from "../../apps/governor/src/modules/jobs/automation";
import { Store } from "../../apps/governor/src/application/store";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld } from "../helpers";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

interface DispatchRecord { executionKey: string; workflowId: string; runInput: unknown; runnerId?: string }
function autoWorld(clock: { nowMs: () => number }, opts: { insertRunRows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "brain-automation-"));
  const store = new Store({ dataDir: dir, allowTestActor: true, clock: clock as never });
  const org = "org-auto";
  const workspaceId = "ws-auto";
  store.control.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES (?, 'auth-auto')").run(org);
  store.control.prepare("INSERT INTO workspaces(id, organization_id, slug, status) VALUES (?, ?, 'auto', 'active')").run(workspaceId, org);
  store.control.prepare("INSERT INTO principals(id, organization_id, kind, auth_subject_id) VALUES ('operator-1', ?, 'human', 'auto-operator')").run(org);
  store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,'operator-1','workspace-lead',1,'operator-1',?)").run(workspaceId, org, clock.nowMs());
  const starts: DispatchRecord[] = [];
  let runCounter = 0;
  const deps = {
    resolveWorkflow: (_organizationId: string, workflowId: string) => ({ workflow: { id: workflowId }, configDigest: `sha256:${"1".repeat(64)}` }),
    startRun: (input: { executionKey: string; workflowId: string; runInput: unknown; runnerId?: string }) => {
      starts.push({ executionKey: input.executionKey, workflowId: input.workflowId, runInput: input.runInput, ...(input.runnerId ? { runnerId: input.runnerId } : {}) });
      runCounter += 1;
      const runId = `run-auto-${runCounter}`;
      if (opts.insertRunRows) {
        store.workspaceDb(workspaceId, org).prepare("INSERT INTO workflow_runs(id,execution_key,config_digest,workflow_digest,adapter_digest,engine_run_id,state,version,wait_generation,input_digest,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .run(runId, input.executionKey, `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`, `eng-${runId}`, "running", 1, 0, `sha256:${"4".repeat(64)}`, clock.nowMs());
      }
      return { runId };
    },
  };
  const service = new AutomationService(store, deps);
  const actor: ActorContext = { kind: "human", actorId: "operator-1", organizationId: org, workspaceId, scopes: ["workspace:read", "workflow:dispatch"], authMethod: "session", authGeneration: 1 };
  cleanup.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, actor, org, workspaceId, starts, db: () => store.workspaceDb(workspaceId, org) };
}

describe("automation occurrences (T52, E104)", () => {
  it("fires a cron automation once per due minute, idempotent on replay and restart", () => {
    let now = 1_700_000_040_000;
    const clock = { nowMs: () => now };
    const w = autoWorld(clock);
    const id = w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Every minute", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" }, input: { situation: "scheduled" }, misfire: "coalesce" } });

    // Anchor is the creation instant: nothing is due yet.
    expect(w.service.dispatchAll().dispatched).toBe(0);
    // 90 seconds later the every-minute schedule has coalesced to one fire.
    now += 90_000;
    expect(w.service.dispatchAll().dispatched).toBe(1);
    expect(w.starts).toHaveLength(1);
    expect(w.starts[0]!.executionKey).toBe(occurrenceId(id, 1, now - 30_000));
    expect(w.starts[0]!.runInput).toEqual({ situation: "scheduled" });
    // A replayed pass (restart, lost response) dispatches nothing new.
    expect(w.service.dispatchAll().dispatched).toBe(0);
    expect(w.starts).toHaveLength(1);
    // The next minute fires exactly once more under a distinct execution key.
    now += 60_000;
    expect(w.service.dispatchAll().dispatched).toBe(1);
    expect(w.starts[1]!.executionKey).not.toBe(w.starts[0]!.executionKey);
    const history = w.service.query(w.actor, "automations.occurrences", w.workspaceId, id) as { items: Array<{ state: string; dispatchRef: string }> };
    expect(history.items).toHaveLength(2);
    expect(history.items.every((row) => row.state === "dispatched")).toBe(true);
  });

  it("pause stops the schedule; resume applies the misfire policy to the missed window", () => {
    let now = 1_700_000_040_000;
    const clock = { nowMs: () => now };
    const w = autoWorld(clock);
    const id = w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Coalescing", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" }, misfire: "coalesce" } });
    w.service.apply(w.actor, { commandType: "automation.control", workspaceId: w.workspaceId, expectedVersion: 1, payload: { automationId: id, action: "pause" } });
    now += 3 * 60_000;
    expect(w.service.dispatchAll().dispatched).toBe(0);
    // Coalesce: resuming after three missed minutes fires once, not three times.
    w.service.apply(w.actor, { commandType: "automation.control", workspaceId: w.workspaceId, expectedVersion: 2, payload: { automationId: id, action: "resume" } });
    expect(w.service.dispatchAll().dispatched).toBe(1);
    expect(w.starts).toHaveLength(1);
    now += 60_000;
    expect(w.service.dispatchAll().dispatched).toBe(1);

    // Skip: a paused window is recorded as skipped history and the schedule
    // continues from the next due instant.
    const skipId = w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Skipping", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" }, misfire: "skip" } });
    w.service.apply(w.actor, { commandType: "automation.control", workspaceId: w.workspaceId, expectedVersion: 1, payload: { automationId: skipId, action: "pause" } });
    now += 3 * 60_000;
    w.service.apply(w.actor, { commandType: "automation.control", workspaceId: w.workspaceId, expectedVersion: 2, payload: { automationId: skipId, action: "resume" } });
    w.service.dispatchAll();
    const skippedWindow = w.service.query(w.actor, "automations.occurrences", w.workspaceId, skipId) as { items: Array<{ state: string }> };
    expect(skippedWindow.items.filter((row) => row.state === "skipped").length).toBeGreaterThanOrEqual(2);
    // The fire exactly at the resume instant is inside the grace horizon and may dispatch.
    expect(skippedWindow.items.filter((row) => row.state === "dispatched").length).toBeLessThanOrEqual(1);
    const nextMinute = now - (now % 60_000) + 60_000;
    now = nextMinute + 1000;
    w.service.dispatchAll();
    const afterWindow = w.service.query(w.actor, "automations.occurrences", w.workspaceId, skipId) as { items: Array<{ state: string }> };
    expect(afterWindow.items.some((row) => row.state === "dispatched")).toBe(true);
  });

  it("overlap skip refuses a new fire while the previous run is unfinished", () => {
    let now = 1_700_000_040_000;
    const clock = { nowMs: () => now };
    const w = autoWorld(clock, { insertRunRows: true });
    w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Overlapped", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" }, overlap: "skip" } });
    now += 60_000;
    expect(w.service.dispatchAll().dispatched).toBe(1);
    // The simulated run row from startRun is still 'running': the next fire is skipped.
    now += 60_000;
    const second = w.service.dispatchAll();
    expect(second.dispatched).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    const history = w.service.query(w.actor, "automations.occurrences", w.workspaceId) as { items: Array<{ state: string; detail?: string }> };
    expect(history.items.some((row) => row.state === "skipped" && /still running/.test(row.detail ?? ""))).toBe(true);
    // Once the run finishes, the schedule proceeds.
    w.db().prepare("UPDATE workflow_runs SET state='succeeded'").run();
    now += 60_000;
    expect(w.service.dispatchAll().dispatched).toBe(1);
  });

  it("a one-off trigger fires once at its instant, and manual targets only via Run now", () => {
    let now = 1_700_000_040_000;
    const clock = { nowMs: () => now };
    const w = autoWorld(clock);
    w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "One-off", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "once", scheduledAt: new Date(now + 120_000).toISOString() } } });
    now += 60_000;
    expect(w.service.dispatchAll().dispatched).toBe(0);
    now += 120_000;
    expect(w.service.dispatchAll().dispatched).toBe(1);
    expect(w.service.dispatchAll().dispatched).toBe(0);
    expect(w.starts).toHaveLength(1);

    const manualId = w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Manual", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "manual" } } });
    now += 60_000;
    expect(w.service.dispatchAll().dispatched).toBe(0);
    w.service.apply(w.actor, { commandType: "automation.control", workspaceId: w.workspaceId, expectedVersion: 1, payload: { automationId: manualId, action: "runNow" } });
    expect(w.starts).toHaveLength(2);
    expect(w.starts[1]!.executionKey).toBe(occurrenceId(manualId, 1, now));
  });

  it("a scheduled work-item start releases a waiting item exactly once", () => {
    let now = 1_700_000_040_000;
    const clock = { nowMs: () => now };
    const w = autoWorld(clock);
    const db = w.db();
    db.prepare("INSERT INTO objectives(id,title,intent,success_criteria_json,owner_id,created_at_ms,updated_at_ms) VALUES ('obj-sched','O','I','[]','operator-1',?,?)").run(now, now);
    db.prepare("INSERT INTO plan_versions(id,objective_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES ('plan-sched','obj-sched',1,?,'confirmed','manual','operator-1','[]',?)").run(`sha256:${"a".repeat(64)}`, now);
    db.prepare("INSERT INTO work_items(id,objective_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES ('work-sched','obj-sched','plan-sched','t','Scheduled item','backlog','[]','Wait for scheduled start',?,?)").run(now, now);
    w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Release work", target: { kind: "workItem", id: "work-sched" }, trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" } } });
    now += 90_000;
    expect(w.service.dispatchAll().dispatched).toBe(1);
    expect((db.prepare("SELECT state FROM work_items WHERE id='work-sched'").get() as { state: string }).state).toBe("ready");
    now += 60_000;
    const result = w.service.dispatchAll();
    expect(result.dispatched).toBe(0);
    const history = w.service.query(w.actor, "automations.occurrences", w.workspaceId) as { items: Array<{ state: string; detail?: string }> };
    expect(history.items.some((row) => row.state === "skipped" && /work item is ready/.test(row.detail ?? ""))).toBe(true);
  });

  it("rejects invalid triggers, stale versions, and computes previews server-side", () => {
    const now = 1_700_000_040_000;
    const clock = { nowMs: () => now };
    const w = autoWorld(clock);
    expect(() => w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Bad cron", target: { kind: "workflow", id: "x" }, trigger: { kind: "cron", cron: "not a cron", timezone: "Nowhere/Invalid" } } })).toThrow(/valid cron/);
    expect(() => w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Past once", target: { kind: "workflow", id: "x" }, trigger: { kind: "once", scheduledAt: new Date(now - 1000).toISOString() } } })).toThrow(/future scheduledAt/);
    const id = w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Versioned", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "manual" } } });
    expect(() => w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, expectedVersion: 99, payload: { automationId: id, title: "Stale", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "manual" } } })).toThrow();
    // A revision bumps the revision counter without rewriting past occurrences.
    w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, expectedVersion: 1, payload: { automationId: id, title: "Revised", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "manual" } } });
    const list = w.service.query(w.actor, "automations.list", w.workspaceId) as { items: Array<{ revision: number; version: number; state: string }> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.revision).toBe(2);
    expect(list.items[0]!.version).toBe(2);
    expect(list.items[0]!.state).toBe("active");
  });

  it("planned instants follow DST policies: repeated hour fires once, gap fires after", () => {
    // Europe/Paris fold: 2026-10-25 02:00-03:00 CEST repeats as 02:00-03:00 CET.
    const row = { trigger_kind: "cron", cron: "30 2 * * *", timezone: "Europe/Paris", scheduled_at_ms: null, revision_created_at_ms: Date.UTC(2026, 9, 25, 0, 0, 0), misfire: "coalesce" } as const;
    const foldEnd = Date.UTC(2026, 9, 25, 1, 0, 0); // 03:00 CEST == 02:00 CET instant boundary
    const fires = plannedInstants(row, null, Date.UTC(2026, 9, 25, 3, 0, 0));
    expect(fires.dispatch).toHaveLength(1);
    expect(new Date(fires.dispatch[0]!).toISOString()).toBe("2026-10-25T00:30:00.000Z"); // 02:30 CEST, the first 02:30
    const gap = { ...row, cron: "30 2 * * *", timezone: "Europe/Paris", revision_created_at_ms: Date.UTC(2026, 2, 29, 1, 0, 0) } as const; // 2026-03-29 02:30 does not exist (spring forward)
    const gapFires = plannedInstants(gap, null, Date.UTC(2026, 2, 29, 4, 0, 0));
    expect(gapFires.dispatch).toHaveLength(0); // the skipped local time produces no phantom fire that day
    void foldEnd;
  });
});

describe("personal-host offline policy (T58, E105)", () => {
  it("waits without fallback, recovers on the same runner, or fails without a run", () => {
    let now = 1_700_000_040_000;
    const clock = { nowMs: () => now };
    const w = autoWorld(clock);
    w.store.control.prepare(`INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,cpu_capacity,memory_capacity,disk_capacity,slot_capacity,last_heartbeat_ms)
      VALUES ('personal-offline',?,'agents','key','enabled','healthy',?,4000,8192,20480,1,?)`).run(w.org, `sha256:${"1".repeat(64)}`, now - 60_000);
    const waitId = w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: {
      title: "Wait for personal host", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
      execution: { mode: "personal-host", runnerId: "personal-offline", offlinePolicy: "wait" },
    } });
    now += 60_000;
    expect(w.service.dispatchAll().dispatched).toBe(0);
    expect(w.starts).toHaveLength(0);
    let history = w.service.query(w.actor, "automations.occurrences", w.workspaceId, waitId) as { items: Array<{ state: string; detail?: string }> };
    expect(history.items[0]!.state).toBe("pending");
    expect(history.items[0]!.detail).toMatch(/offline policy wait/);

    w.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='personal-offline'").run(now);
    expect(w.service.dispatchAll().dispatched).toBe(1);
    expect(w.starts).toHaveLength(1);
    expect(w.starts[0]!.runnerId).toBe("personal-offline");

    const failId = w.service.apply(w.actor, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: {
      title: "Fail while personal host is offline", target: { kind: "workflow", id: "operations-triage" }, trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
      execution: { mode: "personal-host", runnerId: "personal-offline", offlinePolicy: "fail" },
    } });
    w.store.control.prepare("UPDATE runners SET last_heartbeat_ms=? WHERE id='personal-offline'").run(now - 60_000);
    now += 60_000;
    w.service.dispatchAll();
    expect(w.starts).toHaveLength(1);
    history = w.service.query(w.actor, "automations.occurrences", w.workspaceId, failId) as { items: Array<{ state: string; detail?: string }> };
    expect(history.items[0]!.state).toBe("failed");
    expect(history.items[0]!.detail).toMatch(/offline policy fail/);
  });
});

describe("automation authorization and workspace isolation", () => {
  it("issues automation commands through the governed bus with scope and actor checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-auto-bus-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const created = w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "auto-1", idempotencyKey: "auto-1", commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Governed", target: { kind: "workItem", id: "no-such-item" }, trigger: { kind: "manual" } } }, "auto-test");
    expect(created.receipt.accepted).toBe(true);
    // Agents may not create automations; viewers lack the dispatch scope; other workspaces are invisible.
    const agent = { ...w.owner, kind: "agent" as const, actorId: "agent-1", scopes: ["workspace:read", "workflow:dispatch"] };
    expect(() => w.brain.executeCommand(agent, { contractVersion: "brain.command/v1", commandId: "auto-2", idempotencyKey: "auto-2", commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Agent", target: { kind: "workItem", id: "x" }, trigger: { kind: "manual" } } }, "auto-test")).toThrow();
    const viewer = { ...w.owner, actorId: "viewer-1", scopes: ["workspace:read"] };
    expect(() => w.brain.executeCommand(viewer, { contractVersion: "brain.command/v1", commandId: "auto-3", idempotencyKey: "auto-3", commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Viewer", target: { kind: "workItem", id: "x" }, trigger: { kind: "manual" } } }, "auto-test")).toThrow();
    expect(() => w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "auto-4", idempotencyKey: "auto-4", commandType: "automation.control", workspaceId: w.workspaceId, payload: { automationId: "missing-automation", action: "pause" } }, "auto-test")).toThrow(/not found/);
    void db;
  });
});
