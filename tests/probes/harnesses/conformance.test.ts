import { describe, expect, it } from "vitest";
import { FixtureEngine } from "../../../apps/runner/src/engines/fixture";
import { PiEngine } from "../../../apps/runner/src/engines/pi";
import { AcpEngine } from "../../../apps/runner/src/engines/acp";
import type { EngineAdapter, EngineSessionSpec } from "@brain/contracts";

const SPEC = {
  contractVersion: "brain.engine/v1", organizationId: "org-c", workspaceId: "ws-c",
  dispatchId: "d-1", jobId: "job-c", attemptId: "att-c", runnerId: "runner-c", runnerEpoch: 1,
  leaseId: "lease-c", jobFence: 1,
  engine: { id: "fixture", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: [] },
  modelId: "qwen3.8-flash-next-a5b", sourceRevision: "test", worktreeId: "wt-c",
  configDigest: `sha256:${"0".repeat(64)}`, allowedTools: [],
  context: { artifactId: "ctx", digest: `sha256:${"0".repeat(64)}`, bytes: 0, mediaType: "application/json", classification: "internal" },
  limits: { timeoutMs: 120000, maxTokens: 4096, maxMicroUsd: 0, maxTurns: 3 },
} as unknown as EngineSessionSpec;

async function modelReachable(): Promise<boolean> {
  try {
    const r = await fetch("http://tntungx10:8000/v1/models", { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

async function exercise(engine: EngineAdapter, needsModel: boolean): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const probe = await engine.probe();
  out["probe"] = probe.version !== "unavailable" ? "pass" : "unavailable";
  if (needsModel && !(await modelReachable())) {
    out["start"] = "skipped-model-unreachable";
    return out;
  }
  const ctrl = new AbortController();
  try {
    const { sessionId } = await engine.start(SPEC, ctrl.signal);
    out["start"] = sessionId ? "pass" : "fail";
    // Prompt path exists only on concrete adapters; events drain is the port contract.
    const pi = engine as unknown as { prompt?: (t: string) => Promise<void> };
    if (typeof pi.prompt === "function") {
      await pi.prompt("Reply with exactly: BRAIN_OK");
      out["prompt"] = "pass";
    }
    const evts: unknown[] = [];
    for await (const ev of engine.events(sessionId, 0, ctrl.signal)) evts.push(ev);
    out["events"] = "pass";
    try {
      await engine.checkpoint(sessionId);
      out["checkpoint"] = "pass";
    } catch (e) {
      out["checkpoint"] = (e as { code?: string }).code === "UNSUPPORTED_CAPABILITY" ? "explicit-unsupported" : "error";
    }
    const cancelled = await engine.cancel(sessionId, "conformance");
    out["cancel"] = cancelled.terminationConfirmed ? "pass" : "unconfirmed";
  } catch (e) {
    out["start"] = (e as { code?: string }).code === "UNSUPPORTED_CAPABILITY" ? "explicit-unsupported" : `error:${(e as Error).message?.slice(0, 80)}`;
  } finally {
    await engine.dispose("conformance-done");
    out["dispose"] = "pass";
  }
  return out;
}

describe("G05 harness conformance matrix, unsupported ops explicit (E061)", () => {
  it("fixture: full port surface", async () => {
    const r = await exercise(new FixtureEngine(), false);
    console.log("fixture", r);
    expect(r["probe"]).toBe("pass");
    expect(r["start"]).toBe("pass");
    expect(r["cancel"]).toBe("pass");
  }, 60_000);

  it("pi: probe/start/prompt/cancel against local model", async () => {
    const r = await exercise(new PiEngine(), true);
    console.log("pi", r);
    if (r["start"] !== "skipped-model-unreachable") {
      expect(r["start"]).toBe("pass");
      expect(["pass", "explicit-unsupported"]).toContain(r["checkpoint"]);
    }
  }, 240_000);

  it("Muse: probe/start/cancel against local Anthropic endpoint", async () => {
    // Explicit operator opt-in for the LAN endpoint (T25 gate; no silent default).
    process.env["BRAIN_ANTHROPIC_BASE_URL"] ??= "http://tntungx10:8000";
    process.env["BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY"] ??= "1";
    const { ClaudeEngine } = await import("../../../apps/runner/src/engines/claude.ts"); const r = await exercise(new ClaudeEngine(), true);
    console.log("Muse", r);
    if (r["start"] !== "skipped-model-unreachable") {
      expect(r["start"]).toBe("pass");
    }
  }, 240_000);

  it("acp: probe/start/prompt/cancel over opencode acp", async () => {
    const r = await exercise(new AcpEngine(), true);
    console.log("acp", r);
    if (r["start"] !== "skipped-model-unreachable" && r["probe"] !== "unavailable") {
      expect(r["start"]).toBe("pass");
      expect(["pass", "explicit-unsupported"]).toContain(r["checkpoint"]);
      expect(r["cancel"]).toBe("pass");
    }
  }, 300_000);
});
