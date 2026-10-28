import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Brain } from "../apps/governor/src/application/brain";
import { scopesForPrincipal } from "../apps/governor/src/application/authz";
import { goldenDocs } from "../tests/helpers";

function pct(s: number[], q: number): number {
  const x = [...s].sort((a, b) => a - b);
  return x[Math.min(x.length - 1, Math.floor(x.length * q))] ?? 0;
}
function stats(s: number[]) { return { p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), n: s.length }; }

const WS = 25, RUNNERS = 50, HISTORY = 100_000, APPROVALS = 1000;
const dir = mkdtempSync(join(tmpdir(), "brain-bench-full-"));
const cold0 = performance.now();
const brain = new Brain({ dataDir: dir, allowTestActor: true });
brain.bootstrap({ organizationId: "org-full", ownerId: "owner-full" });
const coldMs = performance.now() - cold0;
const mk = (ws?: string) => ({
  kind: "human" as const, actorId: "owner-full", organizationId: "org-full",
  ...(ws ? { workspaceId: ws } : {}),
  scopes: scopesForPrincipal(brain.store, "owner-full", "org-full", ws),
  authMethod: "session" as const, authGeneration: 1,
});
const wsIds: string[] = [];
for (let i = 0; i < WS; i++) {
  const id = `ws-full-${i}`;
  brain.createWorkspace(mk(), { workspaceId: id, slug: `full-${i}` });
  wsIds.push(id);
}
const { digest } = brain.stageRelease(mk(wsIds[0]!), goldenDocs(), "sha256:79a64bcd06ef364fab89ddd7ae2e66a1d83a2344770b9d8c2c4b0f16229f26a7");
brain.activateRelease(mk(wsIds[0]!), digest);

const seed0 = performance.now();
const s = brain.store;
// 50 registered runners (directory rows; no live sessions needed for read paths)
s.inTx(s.control, () => {
  const insR = s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, 'org-full', 'fixture-tools', 'bench', 'enabled', 'healthy', ?, 4000, 8192, 20480, 1)`);
  for (let i = 0; i < RUNNERS; i++) insR.run(`runner-bench-${i}`, digest);
  // 100k job history rows, spread across workspaces, terminal states dominate
  const insJ = s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, created_at_ms, ready_at_ms, deadline_ms)
    VALUES (?, 'org-full', ?, ?, 'run-bench', 'echo', ?, ?, '{}', ?, 'read', ?, ?, ?)`);
  const states = ["succeeded", "succeeded", "succeeded", "failed", "succeeded"];
  for (let i = 0; i < HISTORY; i++) {
    const now = Date.now() - (HISTORY - i) * 10;
    insJ.run(`job-hist-${i}`, wsIds[i % WS]!, `hist-${i}`, states[i % states.length], digest, digest, now, now, now + 86400000);
  }
  const insA = s.control.prepare(`INSERT INTO approval_requests(id, organization_id, workspace_id, requested_by, subject_digest, subject_json, state, expires_at_ms, created_at_ms)
    VALUES (?, 'org-full', ?, 'owner-full', ?, '{}', 'pending', ?, ?)`);
  for (let i = 0; i < APPROVALS; i++) {
    insA.run(`apr-bench-${i}`, wsIds[i % WS]!, `sha256:${String(i).padStart(64, "0").slice(0, 64)}`, Date.now() + 3600000 + i, Date.now());
  }
});
const seedMs = performance.now() - seed0;

async function trial(): Promise<Record<string, ReturnType<typeof stats>>> {
  const out: Record<string, ReturnType<typeof stats>> = {};
  const q: number[] = [], a: number[] = [], c: number[] = [];
  for (let i = 0; i < 200; i++) {
    const wsId = wsIds[i % WS]!;
    let t = performance.now();
    brain.executeQuery(mk(wsId), { queryType: "jobs.list", workspaceId: wsId, limit: 50 });
    q.push(performance.now() - t);
    t = performance.now();
    brain.executeQuery(mk(wsId), { queryType: "approvals.list", workspaceId: wsId, limit: 50 });
    a.push(performance.now() - t);
  }
  for (let i = 0; i < 100; i++) {
    const wsId = wsIds[i % WS]!;
    const t = performance.now();
    brain.executeCommand(mk(wsId), {
      contractVersion: "brain.command/v1", commandId: `full-${Date.now()}-${i}-${Math.random()}`, commandType: "board.create",
      workspaceId: wsId, idempotencyKey: `full-${Date.now()}-${i}-${Math.random()}`,
      payload: { title: "bench", criteria: ["x"] },
    }, "bench");
    c.push(performance.now() - t);
  }
  out["jobsList"] = stats(q); out["approvalsList"] = stats(a); out["boardCommand"] = stats(c);
  return out;
}

const trials = [await trial(), await trial(), await trial()];
const medianOf = (metric: string, k: "p50" | "p95" | "p99") => pct(trials.map((t) => t[metric]![k]), 0.5);
let walBytes = 0;
try { walBytes = statSync(join(dir, "control.db-wal")).size; } catch { walBytes = 0; }
const result = {
  profile: "doc-10 initial dataset (in-process, warm; 10-min steady-state shortened to 3x300 ops — deviation noted)",
  dataset: { workspaces: WS, runners: RUNNERS, historyRows: HISTORY, pendingApprovals: APPROVALS },
  coldStartMs: Math.round(coldMs), seedMs: Math.round(seedMs),
  medians: {
    jobsList: { p50: medianOf("jobsList", "p50"), p95: medianOf("jobsList", "p95"), p99: medianOf("jobsList", "p99") },
    approvalsList: { p50: medianOf("approvalsList", "p50"), p95: medianOf("approvalsList", "p95"), p99: medianOf("approvalsList", "p99") },
    boardCommand: { p50: medianOf("boardCommand", "p50"), p95: medianOf("boardCommand", "p95"), p99: medianOf("boardCommand", "p99") },
  },
  budgets: { queryP95Ms: 150, queryP99Ms: 400, commandP95Ms: 200, commandP99Ms: 500, rssTargetMb: 1024 },
  rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024), walBytes,
  trials, at: new Date().toISOString(),
};
mkdirSync("artifacts/runtime/G08", { recursive: true });
writeFileSync("artifacts/runtime/G08/bench-full.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify({ dataset: result.dataset, medians: result.medians, rssMb: result.rssMb, seedMs: result.seedMs }, null, 2));
brain.close();
const q95 = result.medians.jobsList.p95, c95 = result.medians.boardCommand.p95;
if (q95 > 150 || c95 > 200 || result.rssMb > 1024) {
  console.error("BUDGET MISS", { q95, c95, rss: result.rssMb });
  process.exit(1);
}
