import { describe, expect, it } from "vitest";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue } from "@brain/contracts";
import { engineFailureDetail } from "../../apps/runner/src/engines/failure-detail";
import { classifyFailure } from "../../apps/governor/src/domain/failure";
import { holdsCompleteObject } from "../../apps/runner/src/engines/json-reply";
import { PiEngine } from "../../apps/runner/src/engines/pi";
import { attemptLimitsNotice, criteriaIn, finalTurnNotice, overAllowanceReason, REPEAT_BUDGET, toolCallCeiling, wrapUpReason } from "../../apps/runner/src/engines/limits";
import { runAgentExecution } from "../../apps/runner/src/engines/run";
import { boundedToolText, GovernedToolCalls, TOOL_RESULT_CHARS } from "../../apps/runner/src/engines/tool-calls";

// The live blow-up (a synthesis task using 277k tokens per attempt, then "agent ended with error" although the report was written): what a
// model is shown of a tool answer is bounded, a repeated read is not paid for twice, the attempt's allowance is judged while it runs, and an
// engine that fails says why.

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const release = (id: string) => ({ id, digest: digest("a") });
const binding = (id: string, effectClass: EngineToolBinding["effectClass"] = "read"): EngineToolBinding => ({
  release: release(id), inputSchema: { type: "object" }, effectClass, target: { targetId: "t", environmentId: "e", preconditionDigest: digest("b") },
} as EngineToolBinding);
const spec = (tools: string[], maxTurns = 30): EngineSessionSpec => ({ allowedTools: tools.map(release), limits: { timeoutMs: 1000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns } } as unknown as EngineSessionSpec);
const answer = (proposalId: string, output: JsonValue, result: "succeeded" | "failed" = "succeeded"): EngineToolExecutionResult => ({
  proposalId, invocationId: `inv-${proposalId}`, output, receipt: { result } as never,
});

/** A broker that answers each proposal the way the runner supervisor does, and records which calls reached it. */
function broker(calls: GovernedToolCalls, output: (n: number) => JsonValue, result: "succeeded" | "failed" = "succeeded") {
  const proposed: string[] = [];
  const push = (kind: string, payload: unknown) => {
    if (kind === "tool.proposed") { const id = (payload as { proposalId: string }).proposalId; proposed.push(id); queueMicrotask(() => calls.complete(answer(id, output(proposed.length), result))); }
  };
  return { proposed, push };
}
function governed(tools: EngineToolBinding[], policy: ConstructorParameters<typeof GovernedToolCalls>[3], output: (n: number) => JsonValue, result: "succeeded" | "failed" = "succeeded", maxTurns = 30) {

  const sink = { proposed: [] as string[], push: (_kind: string, _payload: unknown) => undefined as void };
  const calls = new GovernedToolCalls(tools, spec(tools.map((tool) => tool.release.id), maxTurns), (kind, payload) => sink.push(kind, payload), policy);
  const live = broker(calls, output, result);
  sink.push = live.push; sink.proposed = live.proposed;
  return { calls, proposed: live.proposed };
}

describe("what a model is shown of a tool answer", () => {
  it("is cut to a bounded size with a plain note, and short answers are untouched", () => {
    const small = { output: "ok" };
    expect(boundedToolText(small)).toBe(JSON.stringify(small));
    const text = boundedToolText({ output: "x".repeat(60_000) });
    expect(text.length).toBeLessThan(TOOL_RESULT_CHARS + 300);
    expect(text).toMatch(/\[cut: the answer is \d+ characters long and only the first 16000 are shown/u);
  });

  it("the broker still receives the whole answer; only the model's copy is cut", async () => {
    const { calls } = governed([binding("host.exec")], {}, () => ({ output: "y".repeat(40_000) }));
    const shown = await calls.execute("brain_host_exec", "c1", { command: "docker.ps" });
    expect(shown.length).toBeLessThan(TOOL_RESULT_CHARS + 300);
    expect(shown).toContain("[cut:");
  });
});

describe("a model that asks again", () => {
  it("is told a repeated read was already answered, and that repeat is no second call on record", async () => {
    const { calls, proposed } = governed([binding("host.exec")], {}, () => ({ output: "containers" }));
    expect(await calls.execute("brain_host_exec", "c1", { command: "docker.ps" })).toContain("containers");
    const again = JSON.parse(await calls.execute("brain_host_exec", "c2", { command: "docker.ps" })) as { refused: boolean; error: string };
    expect(again).toMatchObject({ refused: true });
    expect(again.error).toMatch(/You already have this.*Do not call it again; write your answer now/u);
    expect(proposed).toEqual(["c1"]);
    // A different argument is a different call.
    expect(await calls.execute("brain_host_exec", "c3", { command: "docker.stats" })).toContain("containers");
    expect(proposed).toEqual(["c1", "c3"]);
  });

  it("may retry a call that failed, and never has a change tool answered from memory", async () => {
    const failing = governed([binding("host.read")], {}, () => ({ error: "boom" }), "failed");
    await failing.calls.execute("brain_host_read", "r1", { op: "list" });
    await failing.calls.execute("brain_host_read", "r2", { op: "list" });
    expect(failing.proposed).toEqual(["r1", "r2"]);
    const change = governed([binding("host.restart", "write")], {}, () => ({ held: true }));
    await change.calls.execute("brain_host_restart", "w1", { container: "a" });
    await change.calls.execute("brain_host_restart", "w2", { container: "a" });
    expect(change.proposed).toEqual(["w1", "w2"]);
  });

  it("is refused past its call allowance, with the instruction to write the answer, and the call never reaches the broker", async () => {
    const { calls, proposed } = governed([binding("host.read")], { maxCalls: 2 }, (n) => ({ n }), "succeeded", 2);
    await calls.execute("brain_host_read", "a", { path: "1" });
    await calls.execute("brain_host_read", "b", { path: "2" });
    const refused = JSON.parse(await calls.execute("brain_host_read", "c", { path: "3" })) as { refused: boolean; error: string };
    expect(refused.refused).toBe(true);
    expect(refused.error).toMatch(/Stop calling tools now and write the answer/u);
    expect(proposed).toEqual(["a", "b"]);
  });

  it("is refused while the engine says the attempt's allowance is nearly used", async () => {
    const state: { reason?: string } = {};
    const { calls, proposed } = governed([binding("host.read")], { refuse: () => state.reason }, () => ({ ok: true }));
    await calls.execute("brain_host_read", "a", { path: "1" });
    state.reason = "allowance nearly used";
    expect(JSON.parse(await calls.execute("brain_host_read", "b", { path: "2" }))).toEqual({ refused: true, error: "allowance nearly used" });
    expect(proposed).toEqual(["a"]);
  });
});

describe("the attempt's allowance, judged while it runs", () => {
  const limits = { maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 30 };
  it("lets a normal attempt (about 65k of 100k) call tools freely", () => {
    expect(wrapUpReason({ tokens: 65_000, microUsd: 0, turns: 8, lastTurnTokens: 9_000 }, limits)).toBeUndefined();
    expect(overAllowanceReason({ tokens: 65_000, microUsd: 0, turns: 8 }, limits)).toBeUndefined();
  });
  it("asks for the answer at 80% of the tokens, when the next turn would not fit, or on the last turn", () => {
    expect(wrapUpReason({ tokens: 80_000, microUsd: 0, turns: 8 }, limits)).toMatch(/write your complete final answer/u);
    expect(wrapUpReason({ tokens: 75_000, microUsd: 0, turns: 8, lastTurnTokens: 26_000 }, limits)).toBeDefined();
    expect(wrapUpReason({ tokens: 20_000, microUsd: 0, turns: 29 }, limits)).toBeDefined();
    expect(wrapUpReason({ tokens: 20_000, microUsd: 85, turns: 3 }, { ...limits, maxMicroUsd: 100 })).toBeDefined();
  });
  it("stops an attempt still calling tools past its allowance, naming the numbers", () => {
    expect(overAllowanceReason({ tokens: 277_102, microUsd: 0, turns: 12 }, limits)).toBe("the attempt used its allowance (277102 of 100000 tokens) and was still calling tools, so no complete answer was written");
    expect(overAllowanceReason({ tokens: 10, microUsd: 0, turns: 31 }, limits)).toContain("31 of 30 turns");
  });
});

describe("an engine failure says what it was", () => {
  it("leads with the cause and keeps the engine's own words", () => {
    expect(engineFailureDetail("400 This model's maximum context length is 262144 tokens")).toMatch(/^context overflow: /u);
    expect(engineFailureDetail("reply does not meet the required output contract")).toMatch(/^schema mismatch: /u);
    expect(engineFailureDetail("Agent tool input rejected: must have required property 'op'")).toMatch(/^tool error: /u);
    expect(engineFailureDetail("agent execution deadline exceeded")).toMatch(/^stopped: /u);
    expect(engineFailureDetail("the attempt used its allowance (1 of 1 tokens)")).toMatch(/^budget: /u);
    expect(engineFailureDetail("something unexpected")).toBe("something unexpected");
    expect(engineFailureDetail("   ")).toBe("no detail reported");
  });

  /** An engine that writes an answer and then fails with the given error event. */
  function failing(detail: string, text = ""): EngineAdapter {
    const events = (): EngineEvent[] => [
      ...(text ? [{ kind: "text", payload: { text, channel: "assistant", provisional: true } } as unknown as EngineEvent] : []),
      { kind: "error", payload: { error: { code: "DEPENDENCY_UNAVAILABLE", detail, retryable: true, correlationId: "c" }, phase: "stream", retryClass: "new-attempt" } } as unknown as EngineEvent,
      { kind: "session.stopped", payload: { reason: "error", terminationConfirmed: true } } as unknown as EngineEvent,
    ];
    return {
      id: "fixture", probe: async () => ({ id: "fixture", version: "1", adapterDigest: digest("0"), features: ["sessions"] }),
      start: async () => ({ sessionId: "s" }), events: () => (async function* () { for (const event of events()) yield event; })(),
      cancel: async () => ({ terminationConfirmed: true }), dispose: async () => undefined, checkpoint: async () => { throw new Error("unsupported"); },
    } as unknown as EngineAdapter;
  }
  const run = (engine: EngineAdapter) => runAgentExecution({
    engine, attemptId: "att", jobFence: 1, leaseId: "l", runnerId: "r", organizationId: "o", workspaceId: "w", jobId: "j", configDigest: digest("d"),
    task: "t", timeoutMs: 2000, emit: async () => undefined, signal: new AbortController().signal,
  });

  it("carries the engine's error into the step error instead of a bare 'agent ended with error'", async () => {
    const result = await run(failing("budget: the attempt used its allowance (277102 of 100000 tokens) and was still calling tools, so no complete answer was written", "{\"summary\":\"partial\"}"));
    expect(result.ok).toBe(false);
    expect(result.output).toEqual({ error: "agent ended with error: budget: the attempt used its allowance (277102 of 100000 tokens) and was still calling tools, so no complete answer was written" });
  });

  it("never sends more than 500 characters", async () => {
    const result = await run(failing("x".repeat(5000)));
    expect(((result.output as { error: string }).error).length).toBeLessThanOrEqual(500);
  });

  it("an engine with no detail keeps the plain reason", async () => {
    const engine = failing("");
    const result = await run(engine);
    expect((result.output as { error: string }).error).toBe("agent ended with error");
  });
});

describe("the cause words never change how the Governor classifies a failure", () => {
  const signals = (errorText: string) => ({ requiredTools: [], agentTools: undefined, calls: { succeeded: 0, failed: 0, outageLike: 0 }, failedChecks: [], earlierSameChecks: 0, tokensUsed: 10, tokenCap: 200_000, errorText });
  it.each([
    "agent ended with error: budget: the attempt used its allowance (277102 of 100000 tokens) and was still calling tools, so no complete answer was written",
    "agent ended with error: context overflow: 400 This model's maximum context length is 262144 tokens",
    "agent ended with error: tool error: Agent tool input rejected: must have required property 'op'",
  ])("%s stays unclassified (a plain retry), never a tool outage", (text) => {
    expect(classifyFailure(signals(text))).toBe("unclassified");
  });
});

describe("a deliverable that stopping cannot cut short", () => {
  it("is a complete JSON object, as written, fenced or inside a sentence", () => {
    expect(holdsCompleteObject('{"summary":"s","deliverable":"# Report"}')).toBe(true);
    expect(holdsCompleteObject('Here: {"summary":"s"} done')).toBe(true);
    expect(holdsCompleteObject('{"summary":"s","deliverable":"# Rep')).toBe(false);
    expect(holdsCompleteObject("# A report in plain words")).toBe(false);
    expect(holdsCompleteObject("")).toBe(false);
  });
});

/** The Pi engine's allowance check, driven with a stand-in vendor session (no model): what happens at each tool call. */
describe("the Pi engine judges its allowance at each tool call", () => {
  type Internals = { session: unknown; output: string; failure?: string; keepAnswer: boolean; allowanceStop: (spec: EngineSessionSpec) => string | undefined };
  function pi(totals: { tokens: number }, output = "") {
    const engine = new PiEngine([]) as unknown as Internals;
    const log = { steered: [] as string[], aborted: 0, toolSets: [] as string[][] };
    engine.session = {
      getSessionStats: () => ({ assistantMessages: 3, tokens: { input: totals.tokens, output: 0, cacheRead: 0, total: totals.tokens }, cost: 0 }),
      steer: async (text: string) => { log.steered.push(text); }, setActiveToolsByName: (names: string[]) => { log.toolSets.push(names); }, abort: async () => { log.aborted++; }, dispose: () => undefined,
    };
    engine.output = output;
    return { engine, log };
  }
  const pinned = { limits: { timeoutMs: 1000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 30 } } as unknown as EngineSessionSpec;

  it("lets a normal attempt (65k of 100k) call tools and touches nothing", () => {
    const totals = { tokens: 30_000 };
    const { engine, log } = pi(totals);
    expect(engine.allowanceStop(pinned)).toBeUndefined();
    totals.tokens = 65_000;
    expect(engine.allowanceStop(pinned)).toBeUndefined();
    expect(log).toEqual({ steered: [], aborted: 0, toolSets: [] });
  });

  it("at 80% refuses the call and steers the model to answer, once", () => {
    const totals = { tokens: 81_000 };
    const { engine, log } = pi(totals);
    expect(engine.allowanceStop(pinned)).toMatch(/tool-call budget is used up/u);
    totals.tokens = 85_000;
    expect(engine.allowanceStop(pinned)).toBeDefined();
    expect(log.steered).toHaveLength(1);
    expect(engine.failure).toBeUndefined();
  });

  it("past the allowance and still calling tools with no complete answer: fails with the numbers", () => {
    const { engine, log } = pi({ tokens: 277_102 }, "I will now check one more thing");
    engine.allowanceStop(pinned);
    expect(engine.failure).toBe("the attempt used its allowance (277102 of 100000 tokens) and was still calling tools, so no complete answer was written");
    expect(log.aborted).toBe(1);
    expect(engine.keepAnswer).toBe(false);
  });

  it("past the allowance with the whole JSON report already written: stops the session and keeps the report", () => {
    const { engine, log } = pi({ tokens: 277_102 }, '{"summary":"s","deliverable":"# Report","criteria":[],"assumptions":[]}');
    engine.allowanceStop(pinned);
    expect(engine.failure).toBeUndefined();
    expect(engine.keepAnswer).toBe(true);
    expect(log.aborted).toBe(1);
  });
});
