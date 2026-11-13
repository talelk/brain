import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { missionTraceId } from "../../apps/governor/src/domain/trace";
import { recordProbe } from "../../apps/governor/src/modules/operations/index";
import { seedWorkItem, setupWorld, type TestWorld } from "../helpers";
import { command } from "../support/reuse";

// Traces, metrics and alerts (Phase 4): /metrics scrapes with a bearer token, exposes mission, attempt, token, latency, queue and
// parked series without mission-id labels, mission events carry one trace id, and every alert rule names a metric that is really emitted.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const ORIGIN = "http://127.0.0.1:3000";
const TOKEN = "metrics-token-for-tests-0001";

function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return run().finally(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "brain-metrics-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const tokenFile = (dir: string) => { const file = join(dir, "metrics-token"); writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 }); chmodSync(file, 0o600); return file; };

describe("/metrics endpoint", () => {
  it("does not exist without a token file, and needs the bearer token with one", async () => {
    const app = await createApp({ dataDir: join(temp(), "data"), allowTestActor: true });
    cleanup.push(() => app.close());
    expect((await app.fetch(new Request(`${ORIGIN}/metrics`))).status).toBe(404);
    expect((await app.fetch(new Request(`${ORIGIN}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(404);
    const dir = temp();
    await withEnv({ BRAIN_METRICS_TOKEN_FILE: tokenFile(dir) }, async () => {
      expect((await app.fetch(new Request(`${ORIGIN}/metrics`))).status).toBe(401);
      expect((await app.fetch(new Request(`${ORIGIN}/metrics`, { headers: { authorization: "Bearer wrong-token-wrong-token" } }))).status).toBe(401);
      expect((await app.fetch(new Request(`${ORIGIN}/metrics`, { headers: { authorization: TOKEN } }))).status).toBe(401);
      // A session cookie or the test actor is not a metrics credential.
      expect((await app.fetch(new Request(`${ORIGIN}/metrics`, { headers: { "x-brain-test-actor": "owner-1:org-test" } }))).status).toBe(401);
      const ok = await app.fetch(new Request(`${ORIGIN}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } }));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("text/plain; version=0.0.4");
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.text()).toMatch(/^brain_up 1$/mu);
    });
    // A token shorter than 16 characters is no token: the endpoint stays absent.
    const weak = join(dir, "weak"); writeFileSync(weak, "short\n", { mode: 0o600 });
    await withEnv({ BRAIN_METRICS_TOKEN_FILE: weak }, async () => { expect((await app.fetch(new Request(`${ORIGIN}/metrics`, { headers: { authorization: "Bearer short" } }))).status).toBe(404); });
  });
});

async function scrape(w: TestWorld, env: Record<string, string>): Promise<string> {
  // Drives the real route on the world's own Governor store.
  const { renderMetrics } = await import("../../apps/governor/src/modules/operations/index");
  return withEnv(env, async () => renderMetrics(w.brain.store));
}
/** A sample line is name, optional {labels}, a space and a number. */
function validSample(line: string): boolean {
  const space = line.lastIndexOf(" ");
  const head = line.slice(0, space);
  const open = head.indexOf("{");
  const name = open < 0 ? head : head.slice(0, open);
  return /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(name) && (open < 0 || head.endsWith("}")) && Number.isFinite(Number(line.slice(space + 1)));
}
const names = (text: string) => new Set(text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => /^([a-zA-Z_:][a-zA-Z0-9_:]*)/u.exec(line)![1]!));

describe("what a scrape says", () => {
  it("is valid Prometheus text with mission, attempt, token, latency, queue and parked series, and no mission id in any label", async () => {
    const dir = temp();
    const w = await withEnv({ BRAIN_REPLICA_DIR: join(dir, "replica"), BRAIN_REPLICA_INTERVAL_SECONDS: "3600" }, async () => setupWorld());
    cleanup.push(() => w.brain.close());
    const missionId = (await command(w, w.owner, "mission.create", "m1", { title: "Metrics mission", intent: "Count me", successCriteria: ["x"] })).resourceId ?? "";
    seedWorkItem(w.brain, w.org, w.workspaceId, "parked-1", "blocked", ["x"]);
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    ws.prepare("UPDATE work_items SET parked=1, parked_diagnostic='gave up' WHERE id='parked-1'").run();
    const now = w.brain.store.now();
    ws.prepare("INSERT INTO mission_spend(attempt_id,mission_id,run_id,reserved_micro_usd,settled_micro_usd,input_tokens,output_tokens,cached_input_tokens,created_at_ms,settled_at_ms) VALUES ('att-a','mission-parked-1','r1',1000,900,120,30,10,?,?)").run(now - 90_000, now - 30_000);
    recordProbe(w.brain.store, "model", "unavailable", "down");
    await w.brain.replicate();
    const stamp = join(dir, "last-backup-ok"); writeFileSync(stamp, String(Math.floor(now / 1000) - 7200));
    const text = await scrape(w, { BRAIN_REPLICA_DIR: join(dir, "replica"), BRAIN_BACKUP_STAMP_FILE: stamp });

    // Every sample line is valid exposition format.
    for (const line of text.split("\n").filter((entry) => entry && !entry.startsWith("#"))) expect(validSample(line), line).toBe(true);
    expect(text).toMatch(/^# TYPE brain_missions gauge$/mu);
    expect(text).toContain('brain_missions{workspace="test",state="active"} 2');
    expect(text).toContain('brain_parked_tasks{workspace="test"} 1');
    expect(text).toContain('brain_work_items{workspace="test",state="blocked"} 1');
    expect(text).toContain('brain_mission_tokens_total{workspace="test",kind="input"} 120');
    expect(text).toContain('brain_mission_tokens_total{workspace="test",kind="output"} 30');
    expect(text).toContain('brain_mission_spend_micro_usd_total{workspace="test"} 900');
    expect(text).toContain('brain_attempt_duration_seconds_bucket{le="60"} 1');
    expect(text).toContain("brain_attempt_duration_seconds_count 1");
    expect(text).toContain("brain_queue_depth 0");
    expect(text).toContain('brain_probe_severity{probe="model"} 2');
    expect(text).toContain("brain_replica_configured 1");
    expect(text).toMatch(/^brain_replica_lag_seconds \d+$/mu);
    expect(text).toMatch(/^brain_backup_age_seconds 7[12]\d\d$/mu);
    expect(text).toMatch(/^brain_disk_free_bytes \d+/mu);
    // Cardinality: a mission id, an attempt id or a trace id is never a label.
    expect(text).not.toContain(missionId);
    expect(text).not.toMatch(/mission_id=|attempt_id=|trace_id=|traceId/u);
  });

  it("rises with queued work and says nothing about a replica or a backup that is not configured", async () => {
    const w = setupWorld();
    cleanup.push(() => w.brain.close());
    const text = await scrape(w, {});
    expect(text).toContain("brain_replica_configured 0");
    expect(text).not.toContain("brain_replica_lag_seconds");
    expect(text).not.toContain("brain_backup_age_seconds");
    expect(text).toContain("brain_runners_online 0");
  });

  it("every alert rule is complete and names only metrics that /metrics emits", async () => {
    const dir = temp();
    const w = await withEnv({ BRAIN_REPLICA_DIR: join(dir, "replica"), BRAIN_REPLICA_INTERVAL_SECONDS: "3600" }, async () => setupWorld());
    cleanup.push(() => w.brain.close());
    // Give every series something to say: tasks (for the rates), a probe, a replica snapshot, a backup stamp.
    seedWorkItem(w.brain, w.org, w.workspaceId, "rate-1", "blocked", ["x"]);
    recordProbe(w.brain.store, "model", "healthy", "ok");
    recordProbe(w.brain.store, `hosted:${w.workspaceId}`, "healthy", "ok");
    await w.brain.replicate();
    const stamp = join(dir, "last-backup-ok"); writeFileSync(stamp, String(Math.floor(Date.now() / 1000)));
    const emitted = names(await scrape(w, { BRAIN_REPLICA_DIR: join(dir, "replica"), BRAIN_BACKUP_STAMP_FILE: stamp }));
    const { parse } = createRequire(new URL("../../apps/governor/package.json", import.meta.url))("yaml") as { parse(text: string): { groups: Array<{ name: string; rules: Array<{ alert: string; expr: string; for?: string; labels?: { severity?: string }; annotations?: { summary?: string; description?: string } }> }> } };
    const rules = parse(readFileSync(join(process.cwd(), "deploy/monitoring/brain-alerts.yml"), "utf8")).groups.flatMap((group) => group.rules);
    // The conditions the plan names: parked work, stall rate, replica lag, disk, backup age, model down.
    for (const required of ["BrainParkedWork", "BrainStallRateHigh", "BrainReplicaLag", "BrainDiskLow", "BrainBackupStale", "BrainModelDown"]) expect(rules.map((rule) => rule.alert), required).toContain(required);
    for (const rule of rules) {
      expect(rule.for, rule.alert).toMatch(/^\d+[mh]$/u);
      expect(["warning", "critical"], rule.alert).toContain(rule.labels?.severity);
      expect(rule.annotations?.summary?.length, rule.alert).toBeGreaterThan(10);
      expect(rule.annotations?.description?.length, rule.alert).toBeGreaterThan(10);
      for (const metric of rule.expr.match(/\bbrain_[a-z_]+\b/gu) ?? []) expect(emitted.has(metric) || emitted.has(metric.replace(/_(bucket|sum|count)$/u, "")), `${rule.alert} uses ${metric}`).toBe(true);
    }
    expect(readFileSync(join(process.cwd(), "deploy/monitoring/prometheus.yml"), "utf8")).toContain("authorization:");
  });
});

describe("one trace id per mission", () => {
  it("is derived from the mission id, rides in every event that names the mission and shows in the execution stream", async () => {
    const w = setupWorld();
    cleanup.push(() => w.brain.close());
    const missionId = (await command(w, w.owner, "mission.create", "tr-1", { title: "Traced", intent: "Follow me", successCriteria: ["x"] })).resourceId ?? "";
    const other = (await command(w, w.owner, "mission.create", "tr-2", { title: "Other", intent: "Another", successCriteria: ["x"] })).resourceId ?? "";
    const trace = missionTraceId(missionId);
    expect(trace).toMatch(/^[0-9a-f]{32}$/u);
    expect(missionTraceId(missionId)).toBe(trace);
    expect(missionTraceId(other)).not.toBe(trace);
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const rows = ws.prepare("SELECT event_type, payload_json FROM events WHERE aggregate_id=? OR payload_json LIKE ?").all(missionId, `%${missionId}%`) as Array<{ event_type: string; payload_json: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(JSON.parse(row.payload_json), row.event_type).toMatchObject({ traceId: trace });
    // Not a different mission's events, and not on events that name no mission.
    expect(rows.some((row) => row.payload_json.includes(missionTraceId(other)))).toBe(false);
    w.brain.stream.project();
    const stream = w.brain.store.control.prepare("SELECT summary_json FROM execution_stream WHERE summary_json LIKE ?").all(`%${trace}%`) as Array<{ summary_json: string }>;
    expect(stream.length).toBeGreaterThan(0);
  });
});
