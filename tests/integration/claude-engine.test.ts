import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { ClaudeEngine } from "../../apps/runner/src/engines/claude";

const sdk = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), tool: vi.fn(), createSdkMcpServer: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query, tool: sdk.tool, createSdkMcpServer: sdk.createSdkMcpServer }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function spec(): EngineSessionSpec {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-credential");
  vi.stubEnv("BRAIN_ANTHROPIC_API_KEY_FILE", "");
  vi.stubEnv("BRAIN_ANTHROPIC_BASE_URL", "");
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  return JSON.parse(readFileSync("examples/v1/transport/EngineSessionSpec.json", "utf8")) as EngineSessionSpec;
}
function messages(values: unknown[]) {
  sdk.query.mockImplementation(() => ({ close: sdk.close, async *[Symbol.asyncIterator]() { yield* values; } }));
}
async function execute(engine: ClaudeEngine, value: EngineSessionSpec) {
  const { sessionId } = await engine.start(value, new AbortController().signal);
  const events: EngineEvent[] = [];
  for await (const event of engine.events(sessionId, 0, new AbortController().signal)) events.push(event);
  return { sessionId, events };
}
describe("Claude SDK lifecycle mapping", () => {
  it("passes pinned task/instructions and limits, disables native tools, and emits digest-bound terminal output", async () => {
    const value = spec(), engine = new ClaudeEngine();
    messages([{ type: "assistant", message: { content: [{ type: "text", text: "BRAIN_OK" }] } }, { type: "result", subtype: "success", result: "BRAIN_OK", total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 3 } }]);
    const { events } = await execute(engine, value);
    const args = sdk.query.mock.calls[0]![0];
    const first = (await (args.prompt as AsyncIterable<{ type: string; message: { content: string } }>)[Symbol.asyncIterator]().next()).value as { type: string; message: { content: string } };
    expect(first.type).toBe("user"); expect(first.message.content).toContain(value.instructions); expect(first.message.content).toContain(value.task);
    expect(args.options.maxTurns).toBe(value.limits.maxTurns);
    expect(args.options.tools).toEqual([]); expect(args.options.settingSources).toEqual([]);
    expect(await args.options.canUseTool()).toMatchObject({ behavior: "deny" });
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "completed", terminationConfirmed: true, output: { digest: sha256Digest(new TextEncoder().encode("BRAIN_OK")), bytes: 8 } } });
    await expect(engine.checkpoint()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await engine.dispose(); expect(sdk.close).toHaveBeenCalled();
  });
  it("does not charge provider estimates to a zero-cost local endpoint", async () => {
    const base = spec(), value = { ...base, limits: { ...base.limits, maxTokens: 16384 } }, engine = new ClaudeEngine();
    vi.stubEnv("BRAIN_ANTHROPIC_BASE_URL", "http://localhost:8096/claude-code/default");
    messages([{ type: "assistant", message: { content: [{ type: "text", text: "BRAIN_OK" }] } }, { type: "result", subtype: "success", result: "BRAIN_OK", total_cost_usd: 0.0151, usage: { input_tokens: 3470, output_tokens: 61 } }]);
    const { events } = await execute(engine, value);
    expect(events.find((event) => event.kind === "usage")?.payload).toMatchObject({ microUsd: 0 });
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "completed" } });
    await engine.dispose();
  });
  it.each(["error-result", "missing-result", "over-budget", "unbound-tools"])("fails closed for %s", async (scenario) => {
    let value = spec(); const engine = new ClaudeEngine();
    messages(scenario === "missing-result" ? [] : [{ type: "result", subtype: scenario === "error-result" ? "error_max_turns" : "success", result: "partial", total_cost_usd: scenario === "over-budget" ? 1 : 0 }]);
    if (scenario === "unbound-tools") value = { ...value, allowedTools: [{ id: "unbound", digest: value.configDigest }] };
    const { events } = await execute(engine, value);
    expect(events.some((event) => event.kind === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "error" } });
    await engine.dispose();
  });
  it("propagates cancellation to the SDK controller and closes its execution", async () => {
    const value = spec(), engine = new ClaudeEngine();
    let finish!: () => void;
    sdk.query.mockImplementation(() => ({ close: () => { sdk.close(); finish(); }, async *[Symbol.asyncIterator]() { await new Promise<void>((resolve) => { finish = resolve; }); } }));
    const { sessionId } = await engine.start(value, new AbortController().signal);
    for await (const event of engine.events(sessionId, 0, new AbortController().signal)) {
      if (event.kind === "session.started") { await new Promise((resolve) => setTimeout(resolve, 0)); break; }
    }
    expect(await engine.cancel()).toEqual({ terminationConfirmed: true });
    expect(sdk.query.mock.calls[0]![0].options.abortController.signal.aborted).toBe(true);
    expect(sdk.close).toHaveBeenCalled(); await engine.dispose();
  });
  it("steers a live turn through streaming input and refuses when no turn is live (#31)", async () => {
    const value = spec(), engine = new ClaudeEngine();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sdk.query.mockImplementation(() => ({ close: sdk.close, async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", session_id: "sdk-session-1" };
      await gate;
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
    } }));
    const { sessionId } = await engine.start(value, new AbortController().signal);
    await vi.waitFor(() => expect(engine.nativeSession).toBe("sdk-session-1"));
    await engine.steer(sessionId, "m1", "Prefer the existing table");
    const prompt = sdk.query.mock.calls[0]![0].prompt as AsyncIterable<{ message: { content: string }; priority?: string }>;
    const iterator = prompt[Symbol.asyncIterator]();
    await iterator.next();
    expect((await iterator.next()).value).toMatchObject({ message: { content: "[steer:m1] Prefer the existing table" }, priority: "next" });
    release();
    for await (const event of engine.events(sessionId, 0, new AbortController().signal)) void event;
    await expect(engine.steer(sessionId, "m2", "Too late")).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await engine.dispose();
  });
});
