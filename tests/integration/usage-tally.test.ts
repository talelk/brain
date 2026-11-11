import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { runAgentExecution } from "../../apps/runner/src/engines/run";
import { tallyUsage } from "../../apps/governor/src/modules/missions/usage";

// Every shape of usage report an engine can produce, run through the runner exactly as a real attempt does and tallied from the events
// the governor stores (the runner's { sequence, kind: "engine", payload: <engine event> } envelope).
type Shape = { name: string; usage: Array<Record<string, unknown>>; expect: Record<string, unknown> };
const PROMPT = "Write the report";
const REPLY = "x".repeat(400);

function fixture(usage: Array<Record<string, unknown>>): EngineAdapter {
  let spec: EngineSessionSpec | undefined;
  return {
    id: "fixture", probe: async () => ({ id: "fixture", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions"] }),
    start: async (value) => { spec = value; return { sessionId: "session-0" }; },
    events: () => (async function* () {
      void spec;
      for (const payload of usage) yield { kind: "usage", payload } as unknown as EngineEvent;
      yield { kind: "text", payload: { text: REPLY } } as EngineEvent;
      const bytes = new TextEncoder().encode(REPLY);
      yield { kind: "session.stopped", payload: { reason: "completed", terminationConfirmed: true, output: { digest: sha256Digest(bytes), bytes: bytes.length } } } as EngineEvent;
    })(),
    cancel: async () => ({ terminationConfirmed: true }), dispose: async () => undefined,
    checkpoint: async () => { throw new Error("unsupported"); },
  };
}

async function stored(usage: Array<Record<string, unknown>>): Promise<ReturnType<typeof tallyUsage>> {
  const events: Array<{ sequence: number; kind: string; payload: unknown }> = [];
  await runAgentExecution({
    engine: fixture(usage), attemptId: "att-tally", jobFence: 1, leaseId: "lease", runnerId: "runner", organizationId: "org", workspaceId: "ws", jobId: "job",
    configDigest: `sha256:${"d".repeat(64)}`, task: PROMPT, timeoutMs: 2000, signal: new AbortController().signal,
    emit: async (kind, payload) => { events.push({ sequence: events.length + 1, kind, payload }); },
  });
  return tallyUsage(JSON.parse(JSON.stringify(events)));
}

const shapes: Shape[] = [
  { name: "a final total with tokens and cost", usage: [{ usageId: "a", inputTokens: 900, outputTokens: 50, cachedInputTokens: 30, microUsd: 1200, accounting: "final-total", estimated: false }],
    expect: { inputTokens: 900, outputTokens: 50, cachedInputTokens: 30, microUsd: 1200, estimated: false, accounting: "final-total" } },
  { name: "incremental reports, a replayed usage id counted once", usage: [
      { usageId: "u1", inputTokens: 100, outputTokens: 20, microUsd: 0, accounting: "incremental" }, { usageId: "u1", inputTokens: 100, outputTokens: 20, microUsd: 0, accounting: "incremental" },
      { usageId: "u2", inputTokens: 50, outputTokens: 10, microUsd: 3, accounting: "incremental" }],
    expect: { inputTokens: 150, outputTokens: 30, microUsd: 3, estimated: false } },
  { name: "cost only, no tokens: the tokens are estimated", usage: [{ usageId: "c", microUsd: 500, accounting: "final-total", estimated: false }],
    expect: { inputTokens: Math.ceil((PROMPT.length) / 4), outputTokens: 100, estimated: true } },
  { name: "all-zero totals (an endpoint that streams no usage): estimated", usage: [{ usageId: "z", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0, accounting: "final-total", estimated: false }],
    expect: { inputTokens: Math.ceil(PROMPT.length / 4), outputTokens: 100, estimated: true } },
  { name: "no usage event at all: estimated", usage: [], expect: { inputTokens: Math.ceil(PROMPT.length / 4), outputTokens: 100, estimated: true, accounting: "final-total" } },
  { name: "a non-numeric payload: estimated", usage: [{ usageId: "n", inputTokens: "many", outputTokens: null, accounting: "final-total" }], expect: { outputTokens: 100, estimated: true } },
];

describe("usage reaches the ledger tally in every shape an engine reports it (#76)", () => {
  for (const shape of shapes) {
    it(shape.name, async () => { expect(await stored(shape.usage)).toMatchObject(shape.expect); });
  }
});
