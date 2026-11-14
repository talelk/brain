import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { ClaudeEngine } from "../../apps/runner/src/engines/claude";
import { overCostCap } from "../../apps/runner/src/engines/limits";

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
  it("treats a zero per-attempt cost cap as unbounded so a paid run completes (#79)", async () => {
    const base = spec(), value = { ...base, limits: { ...base.limits, maxMicroUsd: 0 } }, engine = new ClaudeEngine();
    messages([{ type: "assistant", message: { content: [{ type: "text", text: "BRAIN_OK" }] } }, { type: "result", subtype: "success", result: "BRAIN_OK", total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 3 } }]);
    const { events } = await execute(engine, value);
    expect(sdk.query.mock.calls[0]![0].options.maxBudgetUsd).toBeUndefined();
    expect(events.find((event) => event.kind === "usage")?.payload).toMatchObject({ microUsd: 250000 });
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "completed" } });
    await engine.dispose();
  });
  it.each(["error-result", "missing-result", "over-budget", "unbound-tools"])("fails closed for %s", async (scenario) => {
    let value = spec(); const engine = new ClaudeEngine();
    messages(scenario === "missing-result" ? [] : [{ type: "result", subtype: scenario === "error-result" ? "error_max_turns" : "success", result: "partial", total_cost_usd: scenario === "over-budget" ? 1 : 0 }]);
    if (scenario === "over-budget") value = { ...value, limits: { ...value.limits, maxMicroUsd: 100 } };
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

describe("a hosted-model route is per attempt, never process-global (ADR 0023, backlog 83)", () => {
  const route = { baseUrl: "https://models.acme.example/anthropic", model: "acme-large", inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 };
  const answer = [{ type: "assistant", message: { content: [{ type: "text", text: "CHECKED" }] } }, { type: "result", subtype: "success", result: "CHECKED", total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 3 } }];

  it("sends the attempt to the routed model with the runner's hosted key, leaves the process environment alone, and counts the cost", async () => {
    const value = spec();
    vi.stubEnv("BRAIN_HOSTED_MODEL_API_KEY", "hosted-key-for-tests");
    vi.stubEnv("BRAIN_ANTHROPIC_BASE_URL", "http://localhost:8096/claude-code/default");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-team-id: local-team");
    messages(answer);
    const { events } = await execute(new ClaudeEngine([], route), value);
    const options = sdk.query.mock.calls[0]![0].options;
    expect(options.model).toBe("acme-large");
    expect(options.env).toMatchObject({ ANTHROPIC_BASE_URL: route.baseUrl, ANTHROPIC_API_KEY: "hosted-key-for-tests", ANTHROPIC_AUTH_TOKEN: "hosted-key-for-tests" });
    // Nothing of the local gateway reaches the vendor, and the process keeps its own configuration for the next attempt.
    expect(options.env.BRAIN_ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("test-credential");
    expect(process.env["ANTHROPIC_BASE_URL"]).toBe("");
    // A vendor is not free: its cost is counted from the route's prices (10 in x $3/M + 3 out x $15/M, rounded up); the local endpoint's is zero.
    expect(events.find((event) => event.kind === "usage")?.payload).toMatchObject({ microUsd: 75 });
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "completed" } });
  });

  it("keeps two attempts at once apart: the routed one and a self-hosted one each get their own endpoint", async () => {
    const value = spec();
    vi.stubEnv("BRAIN_HOSTED_MODEL_API_KEY", "hosted-key-for-tests");
    vi.stubEnv("BRAIN_ANTHROPIC_BASE_URL", "http://localhost:8096/claude-code/default");
    // The routed attempt is still running when the self-hosted one starts (and sets up the process environment for itself).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    sdk.query.mockImplementation(() => { const mine = ++started; return { close: sdk.close, async *[Symbol.asyncIterator]() { if (mine === 1) await gate; else release(); yield* answer; } }; });
    const routed = execute(new ClaudeEngine([], route), value);
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1));
    await Promise.all([routed, execute(new ClaudeEngine(), value)]);
    const envs = sdk.query.mock.calls.map((call) => call[0].options.env as Record<string, string>);
    expect(envs.map((env) => env["ANTHROPIC_BASE_URL"]).sort()).toEqual([route.baseUrl, "http://localhost:8096/claude-code/default"].sort());
    expect(envs.find((env) => env["ANTHROPIC_BASE_URL"] === route.baseUrl)!["ANTHROPIC_API_KEY"]).toBe("hosted-key-for-tests");
    expect(envs.find((env) => env["ANTHROPIC_BASE_URL"] !== route.baseUrl)!["ANTHROPIC_API_KEY"]).toBe("test-credential");
  });

  it("refuses to send anything when the runner has no hosted key, or the route is not https", async () => {
    const value = spec();
    vi.stubEnv("BRAIN_HOSTED_MODEL_API_KEY", "");
    messages(answer);
    await expect(new ClaudeEngine([], route).start(value, new AbortController().signal)).rejects.toThrow(/BRAIN_HOSTED_MODEL_API_KEY/u);
    vi.stubEnv("BRAIN_HOSTED_MODEL_API_KEY", "hosted-key-for-tests");
    await expect(new ClaudeEngine([], { ...route, baseUrl: "http://models.acme.example/v1" }).start(value, new AbortController().signal)).rejects.toThrow(/https/u);
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it("is chosen by the supervisor for a check or a second attempt only, and reaches the Claude engine through selectEngine", async () => {
    const { hostedRouteOf } = await import("../../apps/runner/src/supervisor");
    const { selectEngine } = await import("../../apps/runner/src/engines/run");
    expect(hostedRouteOf({ ...route, tier: "hosted", role: "evaluator" })).toEqual(route);
    expect(hostedRouteOf({ ...route, tier: "hosted", role: "second-attempt" })).toEqual(route);
    expect(hostedRouteOf({ ...route, tier: "hosted", role: "planner" })).toBeUndefined();
    expect(hostedRouteOf({ ...route, tier: "local", role: "evaluator" })).toBeUndefined();
    expect(hostedRouteOf(undefined)).toBeUndefined();
    const value = spec();
    vi.stubEnv("BRAIN_HOSTED_MODEL_API_KEY", "hosted-key-for-tests");
    messages(answer);
    await execute(selectEngine("claude", [], route) as ClaudeEngine, value);
    expect(sdk.query.mock.calls[0]![0].options.env.ANTHROPIC_BASE_URL).toBe(route.baseUrl);
  });
});

describe("per-attempt cost cap rule shared by Claude and Pi (#79)", () => {
  it("enforces only a positive cap", () => {
    expect(overCostCap(5_000_000, 0)).toBe(false);
    expect(overCostCap(100, 100)).toBe(false);
    expect(overCostCap(101, 100)).toBe(true);
  });
});
