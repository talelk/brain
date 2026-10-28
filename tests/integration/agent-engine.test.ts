import { describe, expect, it, vi } from "vitest";
import { runAgentExecution } from "../../apps/runner/src/engines/run";
import { FixtureEngine } from "../../apps/runner/src/engines/fixture";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";

function input(engine: EngineAdapter, overrides = {}) {
  return { engine, attemptId: "att-failures", jobFence: 1, leaseId: "lease-failures", runnerId: "runner-failures",
    organizationId: "org-failures", workspaceId: "ws-failures", jobId: "job-failures",
    configDigest: `sha256:${"d".repeat(64)}`, task: "diagnostic", timeoutMs: 100,
    emit: async () => undefined, signal: new AbortController().signal, ...overrides };
}
function adapter(events: (spec: EngineSessionSpec) => AsyncIterable<EngineEvent>): EngineAdapter {
  let spec: EngineSessionSpec;
  return { id: "fixture", probe: async () => ({ id: "fixture", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions"] }),
    start: async (value) => { spec = value; return { sessionId: "session-failures" }; }, events: () => events(spec),
    cancel: vi.fn(async () => ({ terminationConfirmed: true })), dispose: vi.fn(async () => undefined),
    checkpoint: async () => { throw new Error("unsupported"); } };
}

describe("agent engine execution lifecycle", () => {
  it("consumes instructions/task, emits events, pins output text, and completes", async () => {
    const events: unknown[] = [];
    const result = await runAgentExecution({
      engine: new FixtureEngine(), attemptId: "att-agent", jobFence: 1, leaseId: "lease-agent",
      runnerId: "runner-agent", runnerEpoch: 2, organizationId: "org-agent", workspaceId: "ws-agent",
      jobId: "job-agent", configDigest: `sha256:${"a".repeat(64)}`, sourceRevision: "sha256:" + "b".repeat(64),
      instructions: "Follow the diagnostic exactly.", task: "Reply with exactly: BRAIN_OK", timeoutMs: 1000,
      emit: async (kind, payload) => { events.push({ kind, payload }); }, signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(result.outputText).toBe("BRAIN_OK");
    expect(result.output).toBe("BRAIN_OK");
    expect(events.some((event) => (event as { payload: { kind?: string } }).payload.kind === "session.stopped")).toBe(true);
  });

  it("returns structured model output as JSON", async () => {
    const result = await runAgentExecution({
      engine: new FixtureEngine(), attemptId: "att-json", jobFence: 1, leaseId: "lease-json",
      runnerId: "runner-json", organizationId: "org-json", workspaceId: "ws-json", jobId: "job-json",
      configDigest: `sha256:${"c".repeat(64)}`, task: "Return a result", timeoutMs: 1000,
      emit: async () => undefined, signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ text: "fixture complete" });
  });
});

describe("agent lifecycle failure boundaries", () => {
  it("bounds a stalled event iterator even when the adapter ignores cancellation", async () => {
    const engine = adapter(async function* () { await new Promise(() => undefined); });
    const result = await runAgentExecution(input(engine, { timeoutMs: 20 }));
    expect(result.ok).toBe(false);
    expect(result.output).toEqual({ error: "agent execution deadline exceeded" });
    expect(engine.cancel).toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalled();
  });

  it("bounds stalled cancellation and disposal and reports cleanup as unconfirmed", async () => {
    const engine = adapter(async function* () { await new Promise(() => undefined); });
    engine.cancel = vi.fn(() => new Promise<{ terminationConfirmed: boolean }>(() => undefined));
    engine.dispose = vi.fn(() => new Promise<void>(() => undefined));
    const result = await runAgentExecution(input(engine, { timeoutMs: 20, cleanupTimeoutMs: 20 }));
    expect(result.ok).toBe(false);
    expect(result.cleanupConfirmed).toBe(false);
    expect(engine.cancel).toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalled();
  });

  it("does not start an engine after cancellation while probing", async () => {
    const engine = adapter(async function* () {});
    const start = vi.spyOn(engine, "start");
    const controller = new AbortController(); controller.abort(new Error("lease lost"));
    const result = await runAgentExecution(input(engine, { signal: controller.signal }));
    expect(result.ok).toBe(false); expect(start).not.toHaveBeenCalled();
  });

  it("rejects output without a terminal result", async () => {
    const engine = adapter(async function* () {
      yield { kind: "text", payload: { text: "looks successful" } } as EngineEvent;
    });
    const result = await runAgentExecution(input(engine));
    expect(result.ok).toBe(false);
    expect(result.output).toEqual({ error: "agent event stream ended without a terminal result" });
    expect(engine.dispose).toHaveBeenCalled();
  });

  it.each([false, true])("rejects unconfirmed termination or a mismatching output digest (%s)", async (terminationConfirmed) => {
    const engine = adapter(async function* () {
      yield { kind: "text", payload: { text: "output" } } as EngineEvent;
      yield { kind: "session.stopped", payload: { reason: "completed", terminationConfirmed,
        output: { digest: `sha256:${"0".repeat(64)}`, bytes: 6 } } } as EngineEvent;
    });
    expect((await runAgentExecution(input(engine))).ok).toBe(false);
    expect(engine.dispose).toHaveBeenCalled();
  });
});
