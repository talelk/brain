import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { runAgentExecution } from "../../apps/runner/src/engines/run";

// The corrective JSON session shares the attempt's allowance: it gets what is left, and is not tried when little is.

/** An engine whose first session answers with broken JSON and spends `firstTokens`; the token limit each session was given is recorded. */
function twice(firstTokens: number) {
  const limits: number[] = [];
  let session = -1;
  const engine = {
    id: "fixture", probe: async () => ({ id: "fixture", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions"] }),
    start: async (value: EngineSessionSpec) => { session++; limits.push(value.limits.maxTokens); return { sessionId: `s${session}` }; },
    events: () => (async function* () {
      const text = session === 0 ? '{"a":"x "y" z"}' : '{"a":"fixed"}';
      const bytes = new TextEncoder().encode(text);
      yield { kind: "usage", payload: { usageId: "u", accounting: "final-total", estimated: false, inputTokens: session === 0 ? firstTokens : 1000, outputTokens: 0, cachedInputTokens: 0, microUsd: 0 } } as unknown as EngineEvent;
      yield { kind: "text", payload: { text, channel: "assistant", provisional: true } } as unknown as EngineEvent;
      yield { kind: "session.stopped", payload: { reason: "completed", terminationConfirmed: true, output: { digest: sha256Digest(bytes), bytes: bytes.length } } } as unknown as EngineEvent;
    })(),
    cancel: async () => ({ terminationConfirmed: true }), dispose: async () => undefined, checkpoint: async () => { throw new Error("unsupported"); },
  } as unknown as EngineAdapter;
  return { engine, limits };
}
const go = (engine: EngineAdapter) => runAgentExecution({
  engine, attemptId: "att", jobFence: 1, leaseId: "l", runnerId: "r", organizationId: "o", workspaceId: "w", jobId: "j", configDigest: `sha256:${"d".repeat(64)}`,
  task: "t", timeoutMs: 2000, maxTokens: 100_000, emit: async () => undefined, signal: new AbortController().signal,
});

describe("the corrective session is part of the same allowance", () => {
  it("gets only what is left of the allowance", async () => {
    const { engine, limits } = twice(40_000);
    const result = await go(engine);
    expect(limits).toEqual([100_000, 60_000]);
    expect(result.output).toEqual({ a: "fixed" });
  });

  it("is not tried when the first session used more than 80% of it", async () => {
    const { engine, limits } = twice(90_000);
    await go(engine);
    expect(limits).toEqual([100_000]);
  });
});
