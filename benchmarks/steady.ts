// G08 doc-10 protocol: three comparable steady-state trials (default 10 min each)
// over the initial dataset, then a short 10x-history repeat and a fault-load phase.
// Env: BRAIN_BENCH_TRIAL_MS (default 600000), BRAIN_BENCH_TRIALS (default 3).
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir, cpus, platform, release } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { Brain } from "../apps/governor/src/application/brain";
import { scopesForPrincipal } from "../apps/governor/src/application/authz";
import { goldenDocs, seedOrganization } from "../tests/helpers";

const TRIAL_MS = Number(process.env["BRAIN_BENCH_TRIAL_MS"] ?? 600_000);
const TRIALS = Number(process.env["BRAIN_BENCH_TRIALS"] ?? 3);
const WS = 25, RUNNERS = 50, HISTORY = 100_000, APPROVALS = 1000;

function pct(s: number[], q: number): number {
  const x = [...s].sort((a, b) => a - b);
  return x[Math.min(x.length - 1, Math.floor(x.length * q))] ?? 0;
}
function stats(s: number[]) {
  return { p50: +pct(s, 0.5).toFixed(3), p95: +pct(s, 0.95).toFixed(3), p99: +pct(s, 0.99).toFixed(3), max: +Math.max(0, ...s).toFixed(3), n: s.length };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seed(brain: Brain, dir: string, history: number) {
  seedOrganization(brain, { organizationId: "org-steady", ownerId: "owner-steady" });
  const mk = (ws?: string) => ({
    kind: "human" as const, actorId: "owner-steady", organizationId: "org-steady",
    ...(ws ? { workspaceId: ws } : {}),
    scopes: scopesForPrincipal(brain.store, "owner-steady", "org-steady", ws),
    authMethod: "session" as const, authGeneration: 1,
  });
  const wsIds: string[] = [];
  for (let i = 0; i < WS; i++) {
    brain.createWorkspace(mk(), { workspaceId: `ws-st-${i}`, slug: `st-${i}` });
    wsIds.push(`ws-st-${i}`);
  }
  const { digest } = brain.stageRelease(mk(wsIds[0]!), goldenDocs(), "sha256:8e2074b44042cd1aacec30486b55509b816ecfd02d51243a048854f37c36dabe");
  brain.activateRelease(mk(wsIds[0]!), digest);
  const s = brain.store;
  s.inTx(s.control, () => {
    const insR = s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
      VALUES (?, 'org-steady', 'fixture-tools', 'bench', 'enabled', 'healthy', ?, 4000, 8192, 20480, 1)`);
    for (let i = 0; i < RUNNERS; i++) insR.run(`runner-st-${i}`, digest);
    const insJ = s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, created_at_ms, ready_at_ms, deadline_ms)
      VALUES (?, 'org-steady', ?, ?, 'run-st', 'echo', ?, ?, '{}', ?, 'read', ?, ?, ?)`);
    const states = ["succeeded", "succeeded", "succeeded", "failed", "succeeded"];
    for (let i = 0; i < history; i++) {
      const now = Date.now() - (history - i) * 10;
      insJ.run(`job-st-${i}`, wsIds[i % WS]!, `st-${i}`, states[i % states.length], digest, digest, now, now, now + 86400000);
    }
    const insA = s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
      VALUES (?, 'org-steady', ?, 'owner-steady', ?, '{}', 'pending', ?, ?)`);
    for (let i = 0; i < APPROVALS; i++) {
      insA.run(`apr-st-${i}`, wsIds[i % WS]!, `sha256:${String(i).padStart(64, "0").slice(0, 64)}`, Date.now() + 3600000 + i, Date.now());
    }
  });
  return { mk, wsIds, dir };
}

async function trial(brain: Brain, ctx: ReturnType<typeof seed>, durationMs: number, label: string) {
  const { mk, wsIds } = ctx;
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  const cpu0 = process.cpuUsage();
  const rssSamples: number[] = [];
  const rssTimer = setInterval(() => rssSamples.push(process.memoryUsage().rss / 1048576), 1000);
  const q: number[] = [], c: number[] = [];
  let errors = 0, ops = 0;
  const deadline = performance.now() + durationMs;
  let seq = 0;
  // 20 incoming ops/sec sustained (queries + commands), burst to 50 every 10s.
  while (performance.now() < deadline) {
    const tickStart = performance.now();
    const burst = Math.floor(tickStart / 10_000) % 6 === 5;
    const batch = burst ? 5 : 2; // per 100ms tick -> 20/s, bursts 50/s
    for (let i = 0; i < batch; i++) {
      seq++;
      const wsId = wsIds[seq % WS]!;
      try {
        if (seq % 3 === 0) {
          const t = performance.now();
          brain.executeCommand(mk(wsId), {
            contractVersion: "brain.command/v1", commandId: `st-${label}-${seq}`, commandType: "board.create",
            workspaceId: wsId, idempotencyKey: `st-${label}-${seq}`, payload: { title: "steady", criteria: ["x"] },
          }, "bench");
          c.push(performance.now() - t);
        } else {
          const t = performance.now();
          brain.executeQuery(mk(wsId), { queryType: seq % 2 ? "jobs.list" : "approvals.list", workspaceId: wsId, limit: 50 });
          q.push(performance.now() - t);
        }
        ops++;
      } catch { errors++; }
    }
    const elapsed = performance.now() - tickStart;
    if (elapsed < 100) await sleep(100 - elapsed);
  }
  clearInterval(rssTimer);
  eld.disable();
  const cpu = process.cpuUsage(cpu0);
  let walBytes = 0;
  try { walBytes = statSync(join(ctx.dir, "control.db-wal")).size; } catch { walBytes = 0; }
  return {
    label, durationMs, ops, errors, throughputPerSec: +(ops / (durationMs / 1000)).toFixed(2),
    query: stats(q), command: stats(c),
    eventLoopDelayMs: { p50: +(eld.percentile(50) / 1e6).toFixed(3), p99: +(eld.percentile(99) / 1e6).toFixed(3), max: +(eld.max / 1e6).toFixed(3) },
    cpuMs: { user: Math.round(cpu.user / 1000), system: Math.round(cpu.system / 1000) },
    rssMb: { p50: Math.round(pct(rssSamples, 0.5)), max: Math.round(Math.max(0, ...rssSamples)) },
    walBytes,
  };
}

const dir = mkdtempSync(join(tmpdir(), "brain-bench-steady-"));
const cold0 = performance.now();
const brain = new Brain({ dataDir: dir, allowTestActor: true });
const ctx = seed(brain, dir, HISTORY);
const coldMs = Math.round(performance.now() - cold0);
console.log(`[steady] seeded initial dataset in ${coldMs}ms; ${TRIALS} trials x ${TRIAL_MS}ms`);
const trials = [];
for (let i = 0; i < TRIALS; i++) {
  const t = await trial(brain, ctx, TRIAL_MS, `t${i + 1}`);
  trials.push(t);
  console.log(`[steady] trial ${i + 1} done`, JSON.stringify({ q95: t.query.p95, c95: t.command.p95, eld99: t.eventLoopDelayMs.p99, rssMax: t.rssMb.max, errors: t.errors }));
}
// Fault-load: 100 simultaneous approval wakes + above-capacity command burst.
const faultStart = performance.now();
let faultErrors = 0;
for (let i = 0; i < 100; i++) {
  try {
    brain.executeQuery(ctx.mk(ctx.wsIds[i % WS]!), { queryType: "approvals.list", workspaceId: ctx.wsIds[i % WS]!, limit: 100 });
  } catch { faultErrors++; }
}
const fault = { approvalWakeFanout100Ms: Math.round(performance.now() - faultStart), errors: faultErrors };
brain.close();

// 10x history repeat, same working set, short trial.
const dir10 = mkdtempSync(join(tmpdir(), "brain-bench-steady10-"));
const brain10 = new Brain({ dataDir: dir10, allowTestActor: true });
const ctx10 = seed(brain10, dir10, HISTORY * 10);
const trial10 = await trial(brain10, ctx10, Math.min(TRIAL_MS, 30_000), "x10");
brain10.close();
console.log("[steady] 10x history trial done", JSON.stringify({ q95: trial10.query.p95, q99: trial10.query.p99 }));

const med = (k: (t: (typeof trials)[number]) => number) => +pct(trials.map(k), 0.5).toFixed(3);
const result = {
  profile: "doc-10 G08 steady-state protocol (in-process Governor core; loopback HTTP excluded, noted)",
  environment: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, node: process.version },
  dataset: { workspaces: WS, runners: RUNNERS, historyRows: HISTORY, pendingApprovals: APPROVALS, history10xRows: HISTORY * 10 },
  coldStartMs: coldMs,
  trialMs: TRIAL_MS, trialsCount: TRIALS,
  medians: {
    queryP95: med((t) => t.query.p95), queryP99: med((t) => t.query.p99),
    commandP95: med((t) => t.command.p95), commandP99: med((t) => t.command.p99),
    eventLoopP99: med((t) => t.eventLoopDelayMs.p99), rssMaxMb: med((t) => t.rssMb.max),
    throughputPerSec: med((t) => t.throughputPerSec),
  },
  budgets: { queryP95Ms: 150, queryP99Ms: 400, commandP95Ms: 200, commandP99Ms: 500, eventLoopP99Ms: 50, rssMb: 1024 },
  trials, trial10x: trial10, faultLoad: fault, at: new Date().toISOString(),
};
mkdirSync("artifacts/runtime/G08", { recursive: true });
writeFileSync("artifacts/runtime/G08/bench-steady.json", JSON.stringify(result, null, 2));
console.log("[steady] RESULT", JSON.stringify(result.medians));
const m = result.medians, b = result.budgets;
const miss: string[] = [];
if (m.queryP95 > b.queryP95Ms) miss.push("queryP95");
if (m.queryP99 > b.queryP99Ms) miss.push("queryP99");
if (m.commandP95 > b.commandP95Ms) miss.push("commandP95");
if (m.commandP99 > b.commandP99Ms) miss.push("commandP99");
if (m.eventLoopP99 > b.eventLoopP99Ms) miss.push("eventLoopP99");
if (m.rssMaxMb > b.rssMb) miss.push("rss");
if (trials.some((t) => t.errors > 0)) miss.push("trialErrors");
if (trial10.query.p95 > b.queryP95Ms) miss.push("x10QueryP95");
if (miss.length) { console.error("[steady] BUDGET MISS", miss); process.exit(1); }
console.log("[steady] ALL BUDGETS PASS");
