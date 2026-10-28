import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Brain } from "../apps/governor/src/application/brain";
import { scopesForPrincipal } from "../apps/governor/src/application/authz";
import { goldenDocs } from "../tests/helpers";

function pct(samples: number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

const dir = mkdtempSync(join(tmpdir(), "brain-bench-"));
const brain = new Brain({ dataDir: dir, allowTestActor: true });
brain.bootstrap({ organizationId: "org-bench", ownerId: "owner-bench" });
const actor = {
  kind: "human" as const, actorId: "owner-bench", organizationId: "org-bench",
  scopes: scopesForPrincipal(brain.store, "owner-bench", "org-bench"),
  authMethod: "session" as const, authGeneration: 1,
};
brain.createWorkspace(actor, { workspaceId: "ws-bench", slug: "bench" });
const wsActor = { ...actor, workspaceId: "ws-bench", scopes: scopesForPrincipal(brain.store, "owner-bench", "org-bench", "ws-bench") };
const { digest } = brain.stageRelease(wsActor, goldenDocs(), "sha256:0437388c6d84aff171a0c05452ab6fb4e1b907e83ff4138f4c111df1ed627db8");
brain.activateRelease(wsActor, digest);

const querySamples: number[] = [];
for (let i = 0; i < 100; i++) {
  const t0 = performance.now();
  brain.executeQuery(wsActor, { queryType: "jobs.list", workspaceId: "ws-bench" });
  querySamples.push(performance.now() - t0);
}
const cmdSamples: number[] = [];
for (let i = 0; i < 50; i++) {
  const t0 = performance.now();
  brain.executeCommand(wsActor, {
    contractVersion: "brain.command/v1", commandId: `bench-${i}`, commandType: "board.create",
    workspaceId: "ws-bench", idempotencyKey: `bench-${i}`, payload: { title: `bench ${i}`, criteria: ["x"] },
  }, "bench");
  cmdSamples.push(performance.now() - t0);
}
const result = {
  profile: "starter (doc-10 full workload not yet seeded)",
  node: process.version,
  query: { n: querySamples.length, p50ms: pct(querySamples, 0.5), p95ms: pct(querySamples, 0.95), p99ms: pct(querySamples, 0.99) },
  command: { n: cmdSamples.length, p50ms: pct(cmdSamples, 0.5), p95ms: pct(cmdSamples, 0.95), p99ms: pct(cmdSamples, 0.99) },
  rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  at: new Date().toISOString(),
};
mkdirSync("artifacts/runtime/G08", { recursive: true });
writeFileSync("artifacts/runtime/G08/bench-starter.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
brain.close();
