import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { CheckResult, EvaluationAssignment, JsonValue } from "@brain/contracts";
import type { RunnerConfig } from "../supervisor";
import type { LauncherClient } from "../launcher-client";
import { resolveSecretRefs, scrubSecrets } from "./secrets";

const TOOL_SCRIPTS: Record<string, string> = {
  "fixture.echo": "fixture.echo/run.sh",
  "fixture.verify": "fixture.verify/run.sh",
  "fixture-evaluator": "fixture.verify/run.sh",
};

// The pinned fixture evaluator emits its own small tool schema. Normalize that
// actual result once at the adapter boundary before committing a Brain receipt.
export function normalizeEvaluation(output: JsonValue, assignment: EvaluationAssignment): JsonValue {
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
    oracleDigest: assignment.evaluatorRelease.digest,artifacts:[],detail: observed.has(checkId) ? "Pinned evaluator executed this check" : "Pinned evaluator omitted this check" }));
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

export interface ToolExecution {
  offer: { payload: { input?: Record<string, unknown>; step?: Record<string, unknown>; invocationId?: string }; execution: { kind: string }; workspaceId?: string };
  cfg: RunnerConfig;
  /** Aborted at the monotonic deadline or on a lost lease; kills the child. */
  signal?: AbortSignal | undefined;
  /** The constrained launcher, when this runner is configured with one. */
  launcher?: LauncherClient | undefined;
  /**
   * Effect authority for non-read tool classes: without a permit (or a
   * launcher to present it to) the invocation is refused, never run unbounded.
   */
  permit?: { token: string; permitId: string } | undefined;
  /** Pinned tool digests from the job offer (T22); empty in unpinned worlds. */
  toolPins?: Record<string, string> | undefined;
  /** Fetches and verifies the pinned script bytes for one tool. */
  fetchPinnedTool?: ((toolId: string, digest: string) => Promise<{ entrypoint: string; bytes: Uint8Array }>) | undefined;
  /** Content-addressed cache root for verified tool scripts. */
  toolCacheDir?: string | undefined;
  /** Tool-broker boundary: re-validate the permit immediately before exec. */
  validatePermit?: ((token: string, invocationId: string) => Promise<boolean>) | undefined;
}

export async function executeToolPayload(
  tool: ToolExecution,
): Promise<{ ok: boolean; output: JsonValue }> {
  const { offer, cfg, signal, launcher, permit } = tool;
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
  if (effectClass !== "read" && !launcher) {
    // Fail closed: an effect-class tool never runs as unsandboxed host bash.
    return { ok: false, output: { error: "effect-class tool requires the constrained launcher (BRAIN_LAUNCHER_SOCKET); execution refused" } as unknown as JsonValue };
  }
  if (effectClass !== "read" && !permit) {
    return { ok: false, output: { error: `effect-class tool ${effectClass} executed without an effect permit; invocation refused` } as unknown as JsonValue };
  }
  const secrets = resolveSecretRefs(input["secretRefs"], offer.workspaceId, effectClass);
  if (!secrets.ok) return { ok: false, output: { error: secrets.error } as unknown as JsonValue };
  const toolInput: Record<string, unknown> = { ...input };
  delete toolInput["secretRefs"];
  const uses = step["uses"] as { release?: { id?: string } } | undefined;
  const evaluator = step["evaluator"] as { id?: string } | undefined;
  const toolId = uses?.release?.id ?? evaluator?.id ?? "";
  const rel = TOOL_SCRIPTS[toolId] ?? `${toolId}/run.sh`;
  // T22: in a pinned world the tool executes only bytes fetched from the
  // release and verified against the offer's digest; an unpinned tool is
  // refused under the launcher. Dev worlds without pins keep the local dir.
  let script = join(toolsRoot(cfg), rel);
  let sandboxToolsDir: string | undefined;
  if (tool.toolPins && Object.keys(tool.toolPins).length > 0 && tool.fetchPinnedTool) {
    const pin = tool.toolPins[toolId];
    if (!pin) {
      return { ok: false, output: { error: `tool ${toolId} is not pinned in the job's release; execution refused` } as unknown as JsonValue };
    }
    const cacheDir = join(tool.toolCacheDir ?? join(cfg.stateDir, "tool-cache"), pin.slice(7, 19));
    script = join(cacheDir, "run.sh");
    if (!existsSync(script)) {
      const fetched = await tool.fetchPinnedTool(toolId, pin);
      const digest = (await import("node:crypto")).createHash("sha256").update(fetched.bytes).digest("hex");
      if (`sha256:${digest}` !== pin) {
        return { ok: false, output: { error: `pinned tool ${toolId} bytes do not match the offer digest; refusing` } as unknown as JsonValue };
      }
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(script, fetched.bytes, { mode: 0o755 });
    }
    sandboxToolsDir = cacheDir;
  }
  if (!existsSync(script)) return { ok: false, output: { error: `tool script missing ${rel}` } as unknown as JsonValue };
  const stdin = JSON.stringify(toolInput);
  if (Buffer.byteLength(stdin, "utf8") > 64 * 1024) return { ok: false, output: { error: "tool input too large" } as unknown as JsonValue };
  // Sandbox path: the launcher executes the pinned script inside an ephemeral
  // read-only container with the tools root mounted read-only at /tools.
  if (launcher) {
    // Tool-broker boundary (T23): the permit is validated against *current*
    // Governor authority immediately before the sandboxed invocation — a
    // permit captured earlier may already be expired, fenced or revoked.
    if (effectClass !== "read" && permit && tool.validatePermit) {
      const valid = await tool.validatePermit(permit.token, permit.permitId === "" ? "" : (offer.payload as { invocationId?: string }).invocationId ?? permit.permitId);
      if (!valid) {
        return { ok: false, output: { error: "effect permit is no longer current at the broker boundary; invocation refused" } as unknown as JsonValue };
      }
    }
    const profile = effectClass === "privileged" ? "privileged-tool" as const : offer.execution.kind === "eval" ? "evaluator" as const : "agent" as const;
    try {
      const { sandboxId } = await launcher.createSandbox({ profile, requestId: `exec-${offer.execution.kind}-${Math.random().toString(36).slice(2, 10)}`, toolsDir: sandboxToolsDir ?? toolsRoot(cfg), network: "none" });
      try {
        const inContainer = sandboxToolsDir ? join("/tools", "run.sh") : join("/tools", rel);
        const result = await launcher.exec(sandboxId, inContainer, stdin, 60_000);
        if (result.exitCode !== 0) return { ok: false, output: { error: `tool exit ${result.exitCode}`, stderr: scrubSecrets(result.stderr, secrets.resolved.values).slice(0, 2000) } as unknown as JsonValue };
        const stdout = scrubSecrets(result.stdout, secrets.resolved.values);
        if (Buffer.byteLength(stdout, "utf8") > 1024 * 1024) return { ok: false, output: { error: "tool output too large" } as unknown as JsonValue };
        return { ok: true, output: JSON.parse(stdout) as JsonValue };
      } finally {
        await launcher.stop(sandboxId).catch(() => undefined);
      }
    } catch (e) {
      return { ok: false, output: { error: `sandboxed execution failed: ${e instanceof Error ? e.message : "launcher error"}` } as unknown as JsonValue };
    }
  }
  try {
    const result = await execa("/bin/bash", [script], {
      input: stdin, timeout: 60_000, maxBuffer: 1024 * 1024,
      // extendEnv:false is load-bearing: execa otherwise merges the runner's
      // own environment (credentials included) into the tool's env.
      extendEnv: false,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8", ...secrets.resolved.env },
      shell: false, reject: false,
      ...(signal ? { cancelSignal: signal } : {}),
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
