// Runs the actual G01-G08 gate commands and writes schema-valid per-gate
// VerificationRun manifests under artifacts/runtime/GNN/ so that
// scripts/verify_runtime_evidence.py evaluates real, current evidence.
// A gate passes only if every command exited 0, every bound check is covered
// by a clean command, and every required scenario's evidence tests actually
// ran without a vendor-unavailable skip.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

const fingerprintExcluded = new Set(["node_modules", "dist", "build", "__pycache__", ".git", ".cache"]);
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!fingerprintExcluded.has(entry.name)) walk(full, out);
    } else if (entry.isFile()) out.push(full);
  }
}
function productFingerprint() {
  const files = [];
  for (const dir of ["apps", "packages", "tests", "contracts", "sql", "scripts", "deploy"]) {
    const abs = join(ROOT, dir);
    if (existsSync(abs)) walk(abs, files);
  }
  for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"]) {
    const abs = join(ROOT, f);
    if (existsSync(abs)) files.push(abs);
  }
  const digest = createHash("sha256");
  for (const f of [...new Set(files)].map((f) => relative(ROOT, f)).sort()) {
    digest.update(f + "\0");
    digest.update(createHash("sha256").update(readFileSync(join(ROOT, f))).digest());
  }
  return "sha256:" + digest.digest("hex");
}
const sha = (abs) => "sha256:" + createHash("sha256").update(readFileSync(abs)).digest("hex");

// Skip signatures used by probes when an external vendor/endpoint is not
// actually exercised. Presence in the log demotes the affected scenario.
const skipSignatures = [
  "probe skipped", "docker unavailable", "skipped-model-unreachable",
  "endpoint unreachable", "unreachable at",
];

// Scenario evidence index: E-id -> test path, from the coverage audit.
const coverage = JSON.parse(readFileSync(join(ROOT, "tests/certification/coverage.json"), "utf8"));
const scenarioEvidence = Object.fromEntries(coverage.scenarios.map((s) => [s.id, s.evidence]));

/**
 * Gate specs. commands: argv executed verbatim; checks: gate assertions that
 * pass only when this command exits clean; scenarios: scenario ids executed by
 * this command's evidence (skip-signature-free). Extra scenario evidence files
 * are executed as `vitest run`/`playwright test` unless already covered.
 */
const GATES = {
  G01: {
    commands: [
      { name: "frozen-install", argv: ["pnpm", "install", "--frozen-lockfile"], checks: ["frozen-install", "strict-peers-and-engines"] },
      { name: "native-auth-imports", argv: ["pnpm", "exec", "vitest", "run", "tests/probes/dependencies"], checks: ["native-auth-imports"], scenarios: ["dependency-smoke"] },
      { name: "newui-production-build", argv: ["pnpm", "build"], checks: ["newui-production-build"] },
      { name: "sbom-licenses", argv: ["node", "scripts/generate_sbom.mjs", "artifacts/runtime/G01/sbom.json"], checks: ["sbom-licenses"] },
    ],
  },
  G02: {
    commands: [
      {
        name: "embedded-engine-versions", checks: ["embedded-engine-versions", "fts5-where-required"], argv: ["node", "-e",
          "const p=require('better-sqlite3');const db=p(':memory:');const v=db.prepare('select sqlite_version() v').get().v;" +
          "const o=db.prepare('pragma compile_options').all().map(r=>Object.values(r)[0]);" +
          "if(!o.includes('ENABLE_FTS5'))throw new Error('FTS5 not compiled in');" +
          "console.log('sqlite_version',v,'compile_options',o.join(','));"],
      },
      { name: "wal-fix-and-stress", argv: ["pnpm", "exec", "vitest", "run", "tests/integration/scenarios3.test.ts"], checks: ["wal-fix-and-stress"] },
    ],
  },
  G03: {
    commands: [
      { name: "mastra-six-primitives", argv: ["pnpm", "exec", "vitest", "run", "tests/integration/mastra-conformance.test.ts"], checks: ["six-primitives"] },
      { name: "gates-restart-wakes", argv: ["pnpm", "exec", "vitest", "run", "tests/chaos/gates100.test.ts"], checks: ["restart-100-waits", "early-duplicate-wakes", "cancel-persistence-faults"] },
    ],
  },
  G04: {
    env: { BRAIN_TENCENTDB_URL: "http://127.0.0.1:8420" },
    commands: [
      { name: "memory-tenant-gateway", argv: ["pnpm", "exec", "vitest", "run", "tests/probes/tencentdb/client.test.ts"], checks: ["memory-wiki-codegraph-export"] },
      { name: "tenant-acls-revocation", argv: ["pnpm", "exec", "vitest", "run", "tests/security/authz.test.ts"], checks: ["negative-tenant-acls", "revocation"] },
      { name: "service-footprint", argv: ["pnpm", "exec", "vitest", "run", "tests/integration/scenarios2.test.ts"], checks: ["service-footprint"] },
    ],
  },
  G05: {
    commands: [
      { name: "pi-start-stream-cancel", argv: ["pnpm", "exec", "vitest", "run", "tests/probes/harnesses/pi.test.ts"], checks: ["pi-start-stream-cancel"] },
      { name: "claude-start-stream-cancel", argv: ["pnpm", "exec", "vitest", "run", "tests/probes/harnesses/claude.test.ts"], checks: ["claude-start-stream-cancel"] },
      { name: "capability-matrix", argv: ["pnpm", "exec", "vitest", "run", "tests/probes/harnesses/conformance.test.ts"], checks: ["capability-matrix", "denied-bypass"] },
    ],
  },
  G06: {
    commands: [
      { name: "fixed-profiles-and-denials", argv: ["pnpm", "exec", "vitest", "run", "tests/probes/sandbox/launcher.test.ts"], checks: ["fixed-profiles", "cgroup-cleanup", "filesystem-denial"] },
      { name: "egress-denial", argv: ["pnpm", "exec", "vitest", "run", "tests/probes/sandbox/egress.test.ts"], checks: ["egress-denial"] },
    ],
  },
  G07: {
    commands: [
      { name: "hash-verified-restore", argv: ["pnpm", "exec", "vitest", "run", "tests/chaos/restore.test.ts"], checks: ["hash-verified-restore"] },
      { name: "suspended-waits-recovery", argv: ["pnpm", "exec", "vitest", "run", "tests/chaos/recovery.test.ts"], checks: ["suspended-waits"] },
      { name: "backup-completeness", argv: ["pnpm", "exec", "vitest", "run", "tests/chaos/backup.test.ts"], checks: ["old-authority-disabled", "completeness-inventory"] },
    ],
  },
  G08: {
    commands: [
      { name: "steady-trials-and-fault-load", argv: ["pnpm", "exec", "tsx", "benchmarks/steady.ts"], checks: ["three-comparable-runs", "latency-percentiles", "cpu-rss-wal", "fault-load"] },
    ],
  },
};

const executionPlan = JSON.parse(readFileSync(join(ROOT, "contracts/v1/execution-plan.json"), "utf8"));

function runCommand(cmd, gateDir, env) {
  const logPath = join(gateDir, `${cmd.name}.log`);
  const header = `$ ${cmd.argv.join(" ")}\n(cwd=${ROOT})\n`;
  const started = performance.now();
  const res = spawnSync(cmd.argv[0], cmd.argv.slice(1), {
    cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
  });
  const out = `${header}${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? String(res.error) : ""}`;
  writeFileSync(logPath, out.slice(0, 4 * 1024 * 1024));
  return { argv: cmd.argv, exitCode: res.status ?? 127, durationMs: Math.round(performance.now() - started), logPath, output: out };
}

function runGate(gateId) {
  const spec = GATES[gateId];
  const planGate = executionPlan.requiredLiveGates.find((g) => g.id === gateId);
  if (!spec || !planGate) throw new Error(`unknown gate ${gateId}`);
  const dir = join(ROOT, relative(ROOT, planGate.evidence).split("/").slice(0, 3).join("/"));
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const results = [];
  const checkStatus = {};
  const scenarioClean = {};
  for (const cmd of spec.commands) {
    const r = runCommand(cmd, dir, spec.env ?? {});
    results.push(r);
    const clean = r.exitCode === 0 && !skipSignatures.some((s) => r.output.includes(s));
    const partial = r.exitCode === 0;
    for (const c of cmd.checks ?? []) checkStatus[c] = (checkStatus[c] ?? true) && clean;
    for (const s of cmd.scenarios ?? []) scenarioClean[s] = clean;
    // Bind the scenario's own evidence file: if it differs from this command,
    // it will be executed by the evidence-file pass below.
    void partial;
  }

  // Map already-executed commands to the evidence files they ran, so a
  // scenario's evidence file is not executed twice per gate.
  const byFile = new Map<string, { clean: boolean }>();
  for (const [i, cmd] of spec.commands.entries()) {
    const r = results[i];
    const clean = r.exitCode === 0 && !skipSignatures.some((s) => r.output.includes(s));
    for (const arg of cmd.argv) if (arg.startsWith("tests/")) byFile.set(arg, { clean });
  }
  for (const cmd of spec.commands) for (const s of cmd.scenarios ?? []) scenarioClean[s] = scenarioClean[s] !== false;

  // Any required scenario not already proven clean gets its own evidence run.
  for (const sid of planGate.requiredScenarios) {
    if (scenarioClean[sid] === true) continue;
    const evidence = scenarioEvidence[sid];
    if (!evidence) { scenarioClean[sid] = false; continue; }
    const covered = byFile.get(evidence);
    if (covered) { scenarioClean[sid] = covered.clean; continue; }
    const isBrowser = evidence.endsWith(".spec.ts");
    const cmd = {
      name: `scenario-${sid}`,
      argv: isBrowser ? ["pnpm", "exec", "playwright", "test", evidence] : ["pnpm", "exec", "vitest", "run", evidence],
      checks: [],
    };
    const r = runCommand(cmd, dir, spec.env ?? {});
    results.push(r);
    scenarioClean[sid] = r.exitCode === 0 && !skipSignatures.some((s) => r.output.includes(s));
  }

  const checks = planGate.requiredAssertions.map((id) => ({ id, passed: checkStatus[id] === true }));
  const executed = planGate.requiredScenarios.filter((s) => scenarioClean[s] === true);
  const allChecks = checks.every((c) => c.passed);
  const allCommands = results.every((r) => r.exitCode === 0);
  const allScenarios = executed.length === planGate.requiredScenarios.length;
  const status = allChecks && allCommands && allScenarios ? "passed" : "failed";

  const artifacts = results.map((r) => ({ path: relative(ROOT, r.logPath).replaceAll("\\", "/"), digest: sha(r.logPath) }));
  const sbom = join(dir, "sbom.json");
  if (existsSync(sbom)) artifacts.push({ path: relative(ROOT, sbom).replaceAll("\\", "/"), digest: sha(sbom) });
  const manifest = {
    contractVersion: "brain.verification-run/v1",
    gateId: gateId,
    status,
    productFingerprint: productFingerprint(),
    lockDigest: sha(join(ROOT, "pnpm-lock.yaml")),
    startedAt,
    finishedAt: new Date().toISOString(),
    commands: results.map((r) => ({ argv: r.argv, exitCode: r.exitCode, durationMs: r.durationMs })),
    checks,
    artifacts,
    selectedScenarios: planGate.requiredScenarios,
    executedScenarios: executed,
    skippedScenarios: [],
  };
  writeFileSync(join(ROOT, planGate.evidence), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

const args = process.argv.slice(2);
const only = args.includes("--gates") ? args[args.indexOf("--gates") + 1].split(",") : Object.keys(GATES);
for (const gateId of only) {
  const m = runGate(gateId);
  console.log(`${gateId}: ${m.status} (${m.executedScenarios.length}/${m.selectedScenarios.length} scenarios, ${m.commands.length} commands)`);
}
