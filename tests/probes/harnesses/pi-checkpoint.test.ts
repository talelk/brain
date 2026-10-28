import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiEngine } from "../../../apps/runner/src/engines/pi";
import type { EngineSessionSpec } from "@brain/contracts";

const MODEL_URL = process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1";
const DIGEST = `sha256:${"0".repeat(64)}`;

function spec(): EngineSessionSpec {
  return {
    contractVersion: "brain.engine/v1", organizationId: "org-pi", workspaceId: "ws-pi",
    dispatchId: "d-pi", jobId: "job-pi", attemptId: "att-pi", runnerId: "runner-pi",
    runnerEpoch: 1, leaseId: "lease-pi", jobFence: 1,
    engine: { id: "pi", version: "1.4.0", adapterDigest: DIGEST, features: ["sessions", "checkpoint"] },
    modelId: "qwen3.8-flash-next-a5b", sourceRevision: "sha256:" + "1".repeat(64), worktreeId: "wt-pi",
    configDigest: DIGEST, allowedTools: [],
    context: { artifactId: "ctx-pi", digest: DIGEST, bytes: 0, mediaType: "application/json", classification: "internal" },
    limits: { timeoutMs: 120_000, maxTokens: 8192, maxMicroUsd: 0, maxTurns: 8 },
  } as EngineSessionSpec;
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env["BRAIN_PI_AGENT_DIR"]; });

// T24: Pi checkpoint = digest-pinned durable session file; a fresh adapter
// instance resumes the exact conversation state and can recall it.
describe("pi checkpoint/resume (T24)", () => {
  it("checkpoints, disposes, resumes in a fresh instance and recalls context", async () => {
    let reachable = false;
    try {
      const res = await fetch(`${MODEL_URL}/models`, { signal: AbortSignal.timeout(5000) });
      reachable = res.ok;
    } catch { reachable = false; }
    if (!reachable) {
      console.warn(`local model endpoint unreachable at ${MODEL_URL}; Pi checkpoint probe skipped`);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "brain-pi-ckpt-"));
    dirs.push(dir);
    process.env["BRAIN_PI_AGENT_DIR"] = dir;

    const first = new PiEngine();
    const { sessionId } = await first.start(spec(), new AbortController().signal);
    await first.prompt("Remember this codeword exactly: ZEPHYR-42. Reply with exactly: STORED");
    const checkpoint = await first.checkpoint(sessionId);
    expect(checkpoint.contractVersion).toBe("brain.checkpoint/v1");
    expect(checkpoint.attemptId).toBe("att-pi");
    expect(checkpoint.diff.bytes).toBeGreaterThan(0);
    expect(checkpoint.diff.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await first.dispose();

    // Tampered digest must be refused before any session state changes.
    const second = new PiEngine();
    const started = await second.start(spec(), new AbortController().signal);
    await expect(second.resume(started.sessionId, { ...checkpoint.diff, digest: `sha256:${"f".repeat(64)}` })).rejects.toThrow();
    await second.resume(started.sessionId, checkpoint.diff);
    await second.prompt("What was the codeword I asked you to remember? Reply with exactly the codeword and nothing else.");
    let text = "";
    for await (const ev of second.events(started.sessionId, 0, new AbortController().signal)) {
      text += String((ev.payload as { text?: string }).text ?? "");
    }
    expect(text).toContain("ZEPHYR-42");
    await second.dispose();
  }, 300_000);
});
