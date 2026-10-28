import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Produces artifacts/implementation/verification-run.json — an honest
// in-repo self-verification record (NOT an independent third-party
// certification). Re-runnable; every check is executed, digested and timed.
interface CheckResult {
  id: string;
  command: string;
  exitCode: number;
  startedAt: string;
  durationMs: number;
  outputDigest: string;
  tail: string;
}

function run(id: string, file: string, args: string[]): CheckResult {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let output = "";
  let exitCode = 0;
  try {
    output = execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    exitCode = err.status ?? 1;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  return {
    id,
    command: `${file} ${args.join(" ")}`,
    exitCode,
    startedAt,
    durationMs: Date.now() - t0,
    outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}`,
    tail: output.slice(-1500),
  };
}

function digestOf(path: string): string | null {
  if (!existsSync(path)) return null;
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

const checks: CheckResult[] = [
  run("typecheck", "pnpm", ["typecheck"]),
  run("lint", "pnpm", ["lint"]),
  run("verify-full", "pnpm", ["verify:full"]),
  run("probes", "pnpm", ["exec", "vitest", "run", "tests/probes"]),
  run("pack", "python3", ["scripts/verify_implementation_pack.py"]),
];

const coveragePath = "tests/certification/coverage.json";
const coverage = existsSync(coveragePath) ? (JSON.parse(readFileSync(coveragePath, "utf8")) as unknown) : null;
const record = {
  contractVersion: "brain.verification-run/v1",
  kind: "in-repo-self-verification",
  independent: false,
  note: "Executed by the implementation repository itself. Independent certification still requires a trusted external VerificationRun; this record is evidence input, not third-party attestation.",
  generatedAt: new Date().toISOString(),
  status: checks.every((c) => c.exitCode === 0) ? "passed" : "failed",
  checks,
  artifacts: {
    coverage: { path: coveragePath, digest: digestOf(coveragePath), scenarios: Array.isArray(coverage) ? coverage.length : null },
    ledger: digestOf("artifacts/implementation/ledger.json"),
    gates: ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08"].map((g) => ({
      gate: g,
      digest: digestOf(`artifacts/runtime/${g}/manifest.json`),
    })),
  },
};
writeFileSync("artifacts/implementation/verification-run.json", `${JSON.stringify(record, null, 2)}\n`);
console.log(`verification-run: ${record.status}`);
for (const c of checks) console.log(`  ${c.id}: exit ${c.exitCode} (${c.durationMs}ms)`);
process.exit(record.status === "passed" ? 0 : 1);
