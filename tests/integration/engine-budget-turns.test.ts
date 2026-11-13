import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue } from "@brain/contracts";
import { PiEngine } from "../../apps/runner/src/engines/pi";
import { attemptLimitsNotice, criteriaIn, finalTurnNotice, REPEAT_BUDGET, toolCallCeiling } from "../../apps/runner/src/engines/limits";
import { runAgentExecution } from "../../apps/runner/src/engines/run";
import { GovernedToolCalls } from "../../apps/runner/src/engines/tool-calls";

// The live overrun of a task as small as "Run docker.ps" (110k tokens per attempt, tool answers of 2 KB): the cost is turns, each of which re-sends
// the whole prompt, and a model that keeps looking for something the tools do not show. Real-model check: scripts/probe-sre-attempt.ts.

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const release = (id: string) => ({ id, digest: digest("a") });
const binding = (id: string, effectClass: EngineToolBinding["effectClass"] = "read"): EngineToolBinding => ({
  release: release(id), inputSchema: { type: "object" }, effectClass, target: { targetId: "t", environmentId: "e", preconditionDigest: digest("b") },
} as EngineToolBinding);
const spec = (tools: string[]): EngineSessionSpec => ({ allowedTools: tools.map(release), limits: { timeoutMs: 1000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 30 } } as unknown as EngineSessionSpec);

/** Governed calls whose broker answers each proposal at once; the policy under test is the only thing that differs. */
function governed(policy: ConstructorParameters<typeof GovernedToolCalls>[3]) {
  const proposed: string[] = [];
  const sink = { push: (_kind: string, _payload: unknown) => undefined as void };
  const calls = new GovernedToolCalls([binding("host.exec")], spec(["host.exec"]), (kind, payload) => sink.push(kind, payload), policy);
  sink.push = (kind, payload) => {
    if (kind !== "tool.proposed") return;
    const id = (payload as { proposalId: string }).proposalId;
    proposed.push(id);
    queueMicrotask(() => calls.complete({ proposalId: id, invocationId: `inv-${id}`, output: { output: `answer ${proposed.length}` } as JsonValue, receipt: { result: "succeeded" } as never } as EngineToolExecutionResult));
  };
  return { calls, proposed };
}

describe("what a task may spend in tool calls", () => {
  const criteria = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. Criterion ${i + 1}`).join("\n");
  it("counts the numbered acceptance criteria, in plain text and in a task shown as JSON", () => {
    expect(criteriaIn(`Run docker.ps\nAcceptance criteria:\n${criteria(3)}`)).toBe(3);
    expect(criteriaIn(JSON.stringify({ situation: `Run docker.ps\nAcceptance criteria:\n${criteria(4)}\n\nUpstream results:\n1. not a criterion` }))).toBe(4);
    expect(criteriaIn("No criteria listed")).toBe(0);
    expect(criteriaIn("# Context\nAcceptance criteria:\n1. a\n2. b\n\n# Task\nAcceptance criteria:\n1. only one")).toBe(1);
  });
  it("is 8 calls when no criteria are listed, else one per criterion and one to check (3 to 12), never above the agent's own turn limit", () => {
    expect(toolCallCeiling("Run docker.ps", 30)).toBe(8);
    expect(toolCallCeiling(`x\nAcceptance criteria:\n${criteria(1)}`, 30)).toBe(3);
    expect(toolCallCeiling(`x\nAcceptance criteria:\n${criteria(2)}`, 30)).toBe(3);
    expect(toolCallCeiling(`x\nAcceptance criteria:\n${criteria(4)}`, 30)).toBe(5);
    expect(toolCallCeiling(`x\nAcceptance criteria:\n${criteria(20)}`, 30)).toBe(12);
    expect(toolCallCeiling("Run docker.ps", 5)).toBe(5);
  });
  it("tells the model its limits up front, and in the final turn exactly how many tokens are left", () => {
    expect(attemptLimitsNotice(8, 100_000)).toMatch(/at most 8 tool calls and about 100,000 tokens/u);
    const final = finalTurnNotice("That was your last tool call.", 15_432);
    expect(final).toContain("about 15,432 tokens left");
    expect(final).toMatch(/No tools are available any more/u);
    expect(final).toMatch(/"met" to false/u);
    expect(finalTurnNotice("x", -5)).toContain("about 0 tokens left");
  });
});

describe("a model that will not stop calling tools", () => {
  function exhaustible(policy: NonNullable<ConstructorParameters<typeof GovernedToolCalls>[3]>) {
    const reasons: string[] = [];
    return { ...governed({ ...policy, exhausted: (why) => reasons.push(why) }), reasons };
  }

  it("has its tools taken away after the last call it may make, and the call after that is refused unexecuted", async () => {
    const { calls, proposed, reasons } = exhaustible({ maxCalls: 2 });
    await calls.execute("brain_host_exec", "a", { command: "docker.ps" });
    expect(reasons).toEqual([]);
    expect(await calls.execute("brain_host_exec", "b", { command: "docker.stats" })).toContain("answer 2");
    expect(reasons).toEqual(["That was your last tool call."]);
    expect(JSON.parse(await calls.execute("brain_host_exec", "c", { command: "docker.df" }))).toMatchObject({ refused: true });
    expect(proposed).toEqual(["a", "b"]);
  });

  it("is told firmly that it already has a repeated answer, and loses its tools at the second repeat", async () => {
    const { calls, proposed, reasons } = exhaustible({ maxRepeats: REPEAT_BUDGET });
    await calls.execute("brain_host_exec", "a", { command: "docker.ps" });
    const first = JSON.parse(await calls.execute("brain_host_exec", "b", { command: "docker.ps" })) as { refused: boolean; error: string };
    expect(first.error).toMatch(/You already have this.*write your answer now/u);
    expect(reasons).toEqual([]);
    await calls.execute("brain_host_exec", "c", { command: "docker.ps" });
    expect(reasons).toEqual(["You keep repeating a call you already have the answer to."]);
    expect(proposed).toEqual(["a"]);
  });

  it("counts a refused repeat against the call ceiling, because it costs a whole turn", async () => {
    const { calls, proposed, reasons } = exhaustible({ maxCalls: 3, maxRepeats: 5 });
    await calls.execute("brain_host_exec", "a", { command: "docker.ps" });
    await calls.execute("brain_host_exec", "b", { command: "docker.ps" });
    await calls.execute("brain_host_exec", "c", { command: "docker.ps" });
    expect(reasons).toEqual(["That was your last tool call."]);
    expect(JSON.parse(await calls.execute("brain_host_exec", "d", { command: "docker.stats" }))).toMatchObject({ refused: true });
    expect(proposed).toEqual(["a"]);
  });

  it("sees on every executed answer how much of the attempt is used, and never on a refusal", async () => {
    const { calls } = exhaustible({ maxCalls: 2, note: (used) => `tool calls used: ${used} of 2` });
    expect(await calls.execute("brain_host_exec", "a", { command: "docker.ps" })).toMatch(/answer 1.*\n\[tool calls used: 1 of 2\]$/su);
    await calls.execute("brain_host_exec", "b", { command: "docker.stats" });
    expect(await calls.execute("brain_host_exec", "c", { command: "docker.df" })).not.toContain("[tool calls used");
  });
});

describe("the Pi engine ends tool use, tells the model what is left and keeps only the last message as the answer", () => {
  type Internals = {
    session: unknown; output: string; spec?: unknown; sessionId: string; stream: { values: Array<{ payload: { text: string; channel: string } }> };
    endTools: (spec: EngineSessionSpec, why: string) => void; guardRequests: (session: unknown) => void; allowanceStop: (spec: EngineSessionSpec) => string | undefined;
    observe: (event: unknown) => void; complete: (spec: EngineSessionSpec) => Promise<void>;
  };
  const pinned = { attemptId: "att", instructions: "THE INSTRUCTIONS", task: '{"situation":"Run docker.ps\\nAcceptance criteria:\\n1. a\\n2. b"}', allowedTools: [release("host.exec")], limits: { timeoutMs: 1000, maxTokens: 100_000, maxMicroUsd: 0, maxTurns: 30 } } as unknown as EngineSessionSpec;
  function pi(tokens: number, bindings: EngineToolBinding[] = []) {
    const engine = new PiEngine(bindings) as unknown as Internals;
    const log = { steered: [] as string[], prompts: [] as string[] };
    engine.session = {
      getSessionStats: () => ({ assistantMessages: 3, tokens: { input: tokens, output: 0, cacheRead: 0, total: tokens }, cost: 0 }),
      steer: async (text: string) => { log.steered.push(text); }, agent: {},
      prompt: async (text: string) => { log.prompts.push(text); }, abort: async () => undefined, dispose: () => undefined,
    };
    engine.spec = pinned; engine.sessionId = "s";
    engine.guardRequests(engine.session);
    return { engine, log };
  }

  it("removes every tool and steers once with the exact tokens left", () => {
    const { engine, log } = pi(84_568);
    engine.endTools(pinned, "That was your last tool call.");
    engine.endTools(pinned, "again");
    expect(log.steered).toHaveLength(1);
    expect(log.steered[0]).toContain("about 15,432 tokens left");
    expect(log.steered[0]).toMatch(/^That was your last tool call\. No tools are available/u);
  });

  it("does the same at 80% of the allowance, instead of refusing call after call", () => {
    const { engine, log } = pi(81_000);
    expect(engine.allowanceStop(pinned)).toMatch(/tool-call budget is used up/u);
    expect(engine.allowanceStop(pinned)).toBeDefined();
    expect(log.steered).toHaveLength(1);
    expect(log.steered[0]).toContain("about 19,000 tokens left");
  });

  it("sends the model's requests without a tool list once tools have ended (a server rejects an empty one), and with it before", async () => {
    const { engine } = pi(10_000);
    const onPayload = (engine.session as { agent: { onPayload: (payload: unknown, model: unknown) => Promise<unknown> } }).agent.onPayload;
    const request = { model: "m", messages: [{ role: "user" }], tools: [{ type: "function" }], tool_choice: "auto" };
    expect(await onPayload(request, {})).toEqual(request);
    engine.endTools(pinned, "That was your last tool call.");
    const after = await onPayload(request, {}) as Record<string, unknown>;
    expect(after).toEqual({ model: "m", messages: [{ role: "user" }] });
    expect("tools" in after).toBe(false);
  });

  it("sends the task once as the message (the instructions are the system prompt) with the attempt's limits", async () => {
    const { engine, log } = pi(1_000, [binding("host.exec")]);
    await engine.complete(pinned);
    expect(log.prompts).toHaveLength(1);
    expect(log.prompts[0]).not.toContain("THE INSTRUCTIONS");
    expect(log.prompts[0]).toContain('"situation":"Run docker.ps');
    expect(log.prompts[0]).toMatch(/at most 3 tool calls and about 100,000 tokens/u);
  });

  it("keeps the last message as the answer; what the model said while calling tools is diagnostic narration", () => {
    const { engine } = pi(1_000);
    const message = (content: unknown[], stopReason = "stop") => ({ type: "message_end", message: { role: "assistant", stopReason, content } });
    engine.observe(message([{ type: "text", text: "I will run docker.ps." }, { type: "toolCall", name: "brain_host_exec" }], "toolUse"));
    expect(engine.output).toBe("I will run docker.ps.");
    engine.observe(message([{ type: "thinking", thinking: "hmm" }, { type: "text", text: '{"summary":"s"}' }]));
    expect(engine.output).toBe('{"summary":"s"}');
    expect(engine.stream.values.map((event) => [event.payload.channel, event.payload.text])).toEqual([["diagnostic", "I will run docker.ps."], ["assistant", '{"summary":"s"}']]);
  });
});

describe("the runner takes the answer from the assistant channel only", () => {
  it("does not mix tool-calling narration into the JSON deliverable", async () => {
    const answer = '{"summary":"s","deliverable":"# D","criteria":[],"assumptions":[]}';
    const bytes = new TextEncoder().encode(answer);
    const out = { artifactId: "a", digest: sha256Digest(bytes), bytes: bytes.length, mediaType: "text/plain", classification: "internal" };
    const text = (channel: string, value: string) => ({ kind: "text", payload: { text: value, channel, provisional: true } }) as unknown as EngineEvent;
    const events = [text("diagnostic", "Let me check { the host"), text("assistant", answer),
      { kind: "session.stopped", payload: { reason: "completed", terminationConfirmed: true, output: out } } as unknown as EngineEvent];
    const engine = {
      id: "fixture", probe: async () => ({ id: "fixture", version: "1", adapterDigest: digest("0"), features: ["sessions"] }),
      start: async () => ({ sessionId: "s" }), events: () => (async function* () { for (const event of events) yield event; })(),
      cancel: async () => ({ terminationConfirmed: true }), dispose: async () => undefined, checkpoint: async () => { throw new Error("unsupported"); },
    } as unknown as EngineAdapter;
    const result = await runAgentExecution({
      engine, attemptId: "att", jobFence: 1, leaseId: "l", runnerId: "r", organizationId: "o", workspaceId: "w", jobId: "j", configDigest: digest("d"),
      task: "t", timeoutMs: 2000, emit: async () => undefined, signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ summary: "s" });
  });
});
