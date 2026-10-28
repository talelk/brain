import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Brain } from "../apps/governor/src/application/brain";
import { scopesForPrincipal } from "../apps/governor/src/application/authz";
import { goldenDocs } from "../tests/helpers";

function pct(samples: number[], q: number): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
}

const WS = 25;
const CARDS_PER_WS = 40;
const dir = mkdtempSync(join(tmpdir(), "brain-bench-seeded-"));
const brain = new Brain({ dataDir: dir, allowTestActor: true });
brain.bootstrap({ organizationId: "org-bench", ownerId: "owner-bench" });
const mk = (ws?: string) => ({
  kind: "human" as const, actorId: "owner-bench", organizationId: "org-bench",
  ...(ws ? { workspaceId: ws } : {}),
  scopes: scopesForPrincipal(brain.store, "owner-bench", "org-bench", ws),
  authMethod: "session" as const, authGeneration: 1,
});

const tSeed0 = performance.now();
const wsIds: string[] = [];
for (let i = 0; i < WS; i++) {
  const id = `ws-bench-${i}`;
  brain.createWorkspace(mk(), { workspaceId: id, slug: `bench-${i}` });
  wsIds.push(id);
}
const first = mk(wsIds[0]!);
const { digest } = brain.stageRelease(first, goldenDocs(), "sha256:7b043b38859b892859852cb6f3aaec2abc87999cb0274798a96671294c067951");
brain.activateRelease(first, digest);

let cards = 0;
for (const wsId of wsIds) {
  const actor = mk(wsId);
  for (let i = 0; i < CARDS_PER_WS; i++) {
    brain.executeCommand(actor, {
      contractVersion: "brain.command/v1", commandId: `seed-${wsId}-${i}`, commandType: "board.create",
      workspaceId: wsId, idempotencyKey: `seed-${wsId}-${i}`,
      payload: { title: `seeded card ${i}`, criteria: ["bench"] },
    }, "bench");
    cards++;
  }
}
const seedMs = performance.now() - tSeed0;

const runs: Record<string, { p50: number; p95: number; p99: number }> = {};
for (let run = 0; run < 3; run++) {
  const samples: number[] = [];
  for (let i = 0; i < 100; i++) {
    const wsId = wsIds[i % wsIds.length]!;
    const t0 = performance.now();
    brain.executeQuery(mk(wsId), { queryType: "jobs.list", workspaceId: wsId, limit: 50 });
    samples.push(performance.now() - t0);
  }
  runs[`run${run + 1}`] = { p50: pct(samples, 0.5), p95: pct(samples, 0.95), p99: pct(samples, 0.99) };
}
const med = (k: "p50" | "p95" | "p99") => pct(Object.values(runs).map((r) => r[k]), 0.5);
const result = {
  profile: `seeded-light: ${WS} workspaces, ${cards} cards (doc-10 full: 25ws/5000 jobs/100k events)`,
  seedMs: Math.round(seedMs), cards,
  jobsListP50MedianMs: med("p50"), jobsListP95MedianMs: med("p95"), jobsListP99MedianMs: med("p99"),
  runs, rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  budgetNote: "doc-10 p95 targets: filtered lists <150ms, commands <250ms (in-process, loopback excluded)",
  at: new Date().toISOString(),
};
mkdirSync("artifacts/runtime/G08", { recursive: true });
writeFileSync("artifacts/runtime/G08/bench-seeded.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
brain.close();
