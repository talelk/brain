import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { CheckResult, EvaluationAssignment, JsonValue } from "@brain/contracts";
import type { RunnerConfig } from "../supervisor";
import { resolveSecretRefs, scrubSecrets } from "./secrets";

const TOOL_SCRIPTS: Record<string, string> = {
  "fixture.echo": "fixture.echo/run.sh",
  "fixture.verify": "fixture.verify/run.sh",
  "fixture-evaluator": "fixture.verify/run.sh",
};

// The pinned fixture evaluator emits its own small tool schema. Normalize that
// actual result once at the adapter boundary before committing a Brain receipt.
export function normalizeFixtureEvaluation(output: JsonValue, assignment: EvaluationAssignment): JsonValue {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("evaluator result must be an object");
  const raw = (output as { readonly [key:string]:JsonValue })["checks"];
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("evaluator checks missing or excessive");
  const observed = new Map<string, boolean>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item["id"] !== "string" || typeof item["passed"] !== "boolean" || observed.has(item["id"]) || !assignment.requiredChecks.includes(item["id"])) throw new Error("malformed or unexpected evaluator check");
    observed.set(item["id"],item["passed"]);
  }
  const checks: CheckResult[] = assignment.requiredChecks.map((checkId) => ({ criterionId: assignment.criteria[checkId]!,checkId,
    status: observed.has(checkId) ? observed.get(checkId) ? "passed" : "failed" : "missing",
    oracleDigest: assignment.evaluatorRelease.digest,artifacts:[],detail: observed.has(checkId) ? "Pinned fixture evaluator executed this check" : "Pinned fixture evaluator omitted this check" }));
  return { passed:checks.every((c) => c.status === "passed"),checks:checks as unknown as JsonValue };
}

function toolsRoot(cfg: RunnerConfig): string {
  const candidates = [
    cfg.groupToolsDir,
    process.env["BRAIN_TOOLS_DIR"],
    join(process.cwd(), "examples/v1/golden-release/tools"),
    join(process.cwd(), "../examples/v1/golden-release/tools"),
  ].filter((x): x is string => !!x);
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0] ?? "examples/v1/golden-release/tools";
}

export async function executeToolPayload(
  offer: { payload: { input?: Record<string, unknown>; step?: Record<string, unknown> }; execution: { kind: string }; workspaceId?: string },
  cfg: RunnerConfig,
): Promise<{ ok: boolean; output: JsonValue }> {
  const step = offer.payload.step ?? {};
  const input = (offer.payload.input ?? {}) as Record<string, unknown>;
  // Secret references move only through the exact `secretRefs` channel. Any
  // other secret-shaped top-level key (alternate spellings included) fails
  // closed instead of passing through to the tool unrecognized.
  for (const key of Object.keys(input)) {
    if (key !== "secretRefs" && /secret/iu.test(key)) {
      return { ok: false, output: { error: `unrecognized secret channel in tool input: ${key}` } as unknown as JsonValue };
    }
  }
  const effectClass = typeof step["effectClass"] === "string" ? String(step["effectClass"]) : "read";
  const secrets = resolveSecretRefs(input["secretRefs"], offer.workspaceId, effectClass);
  if (!secrets.ok) return { ok: false, output: { error: secrets.error } as unknown as JsonValue };
  const toolInput: Record<string, unknown> = { ...input };
  delete toolInput["secretRefs"];
  const uses = step["uses"] as { release?: { id?: string } } | undefined;
  const evaluator = step["evaluator"] as { id?: string } | undefined;
  const toolId = uses?.release?.id ?? evaluator?.id ?? "";
  const rel = TOOL_SCRIPTS[toolId];
  if (!rel) {
    return { ok: false, output: { error: `unsupported tool ${toolId}` } as unknown as JsonValue };
  }
  const script = join(toolsRoot(cfg), rel);
  if (!existsSync(script)) return { ok: false, output: { error: `tool script missing ${rel}` } as unknown as JsonValue };
  const stdin = JSON.stringify(toolInput);
  if (Buffer.byteLength(stdin, "utf8") > 64 * 1024) return { ok: false, output: { error: "tool input too large" } as unknown as JsonValue };
  try {
    const result = await execa("/bin/bash", [script], {
      input: stdin, timeout: 60_000, maxBuffer: 1024 * 1024,
      // extendEnv:false is load-bearing: execa otherwise merges the runner's
      // own environment (credentials included) into the tool's env.
      extendEnv: false,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8", ...secrets.resolved.env },
      shell: false, reject: false,
    });
    if (result.exitCode !== 0) return { ok: false, output: { error: `tool exit ${result.exitCode}`, stderr: scrubSecrets(String(result.stderr), secrets.resolved.values).slice(0, 2000) } as unknown as JsonValue };
    const stdout = scrubSecrets(String(result.stdout), secrets.resolved.values);
    if (Buffer.byteLength(stdout, "utf8") > 1024 * 1024) return { ok: false, output: { error: "tool output too large" } as unknown as JsonValue };
    const parsed = JSON.parse(stdout) as JsonValue;
    return { ok: true, output: parsed };
  } catch (e) {
    return { ok: false, output: { error: e instanceof Error ? e.message : "tool execution failed" } as unknown as JsonValue };
  }
}
