import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent, EngineSessionSpec, EngineToolBinding } from "@brain/contracts";
import { AcpEngine } from "../../apps/runner/src/engines/acp";
import { CodexEngine } from "../../apps/runner/src/engines/codex";
import { advertisedCapabilities, engineIsolation } from "../../apps/runner/src/engines/isolation";
import { runAgentExecution, selectEngine, type AgentExecutionInput } from "../../apps/runner/src/engines/run";
import { nativeToolName } from "../../apps/runner/src/engines/tool-calls";

// Spec #90, ticket 142: an ACP engine runs a whole attempt through the runner's runAgentExecution, and its broker tools reach the agent through
// the runner's MCP bridge. The fake agent (tests/support/fake-acp-agent.mjs) plays the steps it is given as its task; no real agent is started:
// BRAIN_ACP_COMMAND and BRAIN_CODEX_COMMAND both name the fake. Permission rules themselves are covered in acp-engine.test.ts.

const AGENT = fileURLToPath(new URL("../support/fake-acp-agent.mjs", import.meta.url));
const BROKER = { id: "fixture.echo", digest: `sha256:${"a".repeat(64)}` };
const BROKER_NAME = nativeToolName(BROKER.id);
const BINDING = { release: BROKER, inputSchema: {}, effectClass: "read", target: { targetId: "t", environmentId: "e", kind: "read" } } as unknown as EngineToolBinding;

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-acp-run-"));
  for (const name of ["BRAIN_ACP_COMMAND", "BRAIN_CODEX_COMMAND", "FAKE_ACP_LOG", "FAKE_ACP_MCP_HTTP"]) saved[name] = process.env[name];
  process.env["BRAIN_ACP_COMMAND"] = `${process.execPath} ${AGENT}`;
  process.env["BRAIN_CODEX_COMMAND"] = `${process.execPath} ${AGENT}`;
  process.env["FAKE_ACP_LOG"] = join(dir, "agent.log");
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(dir, { recursive: true, force: true });
});

const spec = (over: Partial<EngineSessionSpec> = {}): EngineSessionSpec => ({ ...(JSON.parse(readFileSync("examples/v1/transport/EngineSessionSpec.json", "utf8")) as EngineSessionSpec), allowedTools: [BROKER], ...over });
type AgentLogEntry = Record<string, unknown> & { event: string };
const agentLog = (): AgentLogEntry[] => readFileSync(join(dir, "agent.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentLogEntry);
const answers = () => agentLog().filter((entry) => entry.event === "answer") as unknown as Array<{ response: { result: { outcome: { optionId?: string } } } }>;
const permission = (name: string, kind: string) => ({
  request: {
    method: "session/request_permission",
    params: {
      toolCall: { toolCallId: `call-${name}`, name, kind, title: name, status: "pending", rawInput: {} },
      options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "reject", kind: "reject_once", name: "Reject" }],
    },
  },
});
const RECEIPT = (proposalId: string) => ({ invocationId: proposalId, attemptId: "att-1", jobFence: 1, result: "succeeded" as const, startedAt: new Date().toISOString(), effects: [] });

/** The attempt as the runner's supervisor runs it: runAgentExecution over the adapter, the steps as the job's task, every emitted engine event kept. */
async function attempt(engine: AcpEngine, steps: unknown[], over: Partial<AgentExecutionInput> = {}) {
  const emitted: Array<{ kind?: string; payload?: Record<string, unknown> }> = [];
  const result = await runAgentExecution({
    engine, attemptId: "att-1", jobFence: 1, leaseId: "lease-1", runnerId: "runner-1", organizationId: "org-1", workspaceId: "ws-1", jobId: "job-1",
    configDigest: `sha256:${"d".repeat(64)}`, instructions: "You are a careful agent.", task: JSON.stringify(steps), timeoutMs: 10_000, cleanupTimeoutMs: 3000,
    allowedTools: [BROKER], emit: async (kind, payload) => { if (kind === "engine") emitted.push(payload as { kind?: string; payload?: Record<string, unknown> }); },
    signal: new AbortController().signal, ...over,
  });
  return { result, emitted, kinds: emitted.map((event) => event.kind) };
}

describe("an ACP agent completes a run through the runner", () => {
  it("prompts with the job's instructions and task, streams what the agent says, and completes with the answer and the usage the agent reported", async () => {
    const { result, emitted, kinds } = await attempt(new AcpEngine({ toolBindings: [BINDING] }), [{ text: "Let me " }, { text: "think." }, { usage: { inputTokens: 120, outputTokens: 30, cachedReadTokens: 10 } }]);
    expect(result).toMatchObject({ ok: true, outputText: "Let me think.", cleanupConfirmed: true });
    const prompt = agentLog().find((entry) => entry.event === "prompt") as unknown as { text: string };
    expect(prompt.text).toMatch(/^You are a careful agent\.\n\nTask:\n\[/u);
    expect(kinds).toEqual(["session.started", "usage", "text", "artifact", "session.stopped"]);
    expect(emitted.find((event) => event.kind === "usage")?.payload).toMatchObject({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 10, accounting: "final-total", estimated: false });
  });

  it("charges the runner's flagged estimate when the agent reports no usage", async () => {
    const { result, emitted } = await attempt(new AcpEngine({ toolBindings: [BINDING] }), [{ text: "answer" }]);
    expect(result.ok).toBe(true);
    expect(emitted.filter((event) => event.kind === "usage").map((event) => event.payload?.["estimated"])).toEqual([true]);
  });

  it("counts only what the agent says after its last tool call as the answer, and keeps the narration as a diagnostic note", async () => {
    const { result, emitted } = await attempt(new AcpEngine({ toolBindings: [BINDING] }), [
      { text: "I will look first. " },
      { update: { sessionUpdate: "tool_call", toolCallId: "b", name: BROKER_NAME, kind: "other", status: "pending" } },
      { text: "{\"answer\":42}" },
    ]);
    expect(result).toMatchObject({ ok: true, outputText: "{\"answer\":42}", output: { answer: 42 } });
    expect(emitted.filter((event) => event.kind === "text").map((event) => event.payload?.["channel"])).toEqual(["diagnostic", "assistant"]);
  });

  it.each([
    ["refusal", "refused to do the task", "POLICY_DENIED", "error"],
    ["max_tokens", "stopped at its own limit (max_tokens)", "BUDGET_EXHAUSTED", "budget"],
    ["max_turn_requests", "stopped at its own limit (max_turn_requests)", "BUDGET_EXHAUSTED", "budget"],
    ["something_new", "unknown reason (something_new)", "DEPENDENCY_UNAVAILABLE", "error"],
  ])("fails the attempt with its failure class when the agent stops with %s", async (stopReason, detail, code, reason) => {
    const { result, emitted } = await attempt(new AcpEngine({ toolBindings: [BINDING] }), [{ text: "partial" }, { stopReason }]);
    expect(result.ok).toBe(false);
    expect(String((result.output as { error: string }).error)).toContain(detail);
    expect(emitted.find((event) => event.kind === "error")?.payload).toMatchObject({ error: { code } });
    expect(emitted.find((event) => event.kind === "session.stopped")?.payload).toMatchObject({ reason });
  });

  it("fails an attempt whose agent reports more tokens than the allowance", async () => {
    const { result, emitted } = await attempt(new AcpEngine({ toolBindings: [BINDING] }), [{ text: "answer" }, { usage: { inputTokens: 900, outputTokens: 200 } }], { maxTokens: 1000 });
    expect(result.ok).toBe(false);
    expect(emitted.find((event) => event.kind === "error")?.payload).toMatchObject({ error: { code: "BUDGET_EXHAUSTED" } });
  });

  it("fails the attempt when the agent process dies in the middle of the prompt, without waiting for the deadline", async () => {
    const started = Date.now();
    const { result, emitted } = await attempt(new AcpEngine({ toolBindings: [BINDING] }), [{ text: "x" }, { exit: true }]);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(emitted.find((event) => event.kind === "error")?.payload).toMatchObject({ error: { code: "DEPENDENCY_UNAVAILABLE", detail: expect.stringContaining("exited") } });
  });

  it("ends a prompt that outlasts the job's time limit and tells the agent to cancel", async () => {
    const { result } = await attempt(new AcpEngine({ toolBindings: [BINDING] }), [{ hang: true }], { timeoutMs: 600 });
    expect(result.ok).toBe(false);
    expect(agentLog().some((entry) => entry.event === "cancel")).toBe(true);
  });

  it("cancels: tells the agent, ends the stream with one cancelled stop, and stops the process", async () => {
    const engine = new AcpEngine({ toolBindings: [BINDING] });
    const controller = new AbortController();
    const { sessionId } = await engine.start(spec({ task: JSON.stringify([{ text: "working" }, { wait: "cancel" }]) }), controller.signal);
    const events: EngineEvent[] = [];
    const reading = (async () => { for await (const event of engine.events(sessionId, 0, controller.signal)) events.push(event); })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(engine.cancel()).resolves.toEqual({ terminationConfirmed: true });
    await reading;
    expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "cancelled", terminationConfirmed: true } });
    expect(events.filter((event) => event.kind === "session.stopped")).toHaveLength(1);
    expect(agentLog().some((entry) => entry.event === "cancel")).toBe(true);
  });

  it("cancels when the runner aborts the attempt", async () => {
    const controller = new AbortController();
    const running = attempt(new AcpEngine({ toolBindings: [BINDING] }), [{ wait: "cancel" }], { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort(new Error("lease lost"));
    const { result } = await running;
    expect(result.ok).toBe(false);
    expect(agentLog().some((entry) => entry.event === "cancel")).toBe(true);
  });

  it("denies a native tool permission during a full run, and the run still completes on the answer", async () => {
    const { result } = await attempt(new AcpEngine({ toolBindings: [BINDING] }), [permission("bash", "execute"), { text: "done" }]);
    expect(result).toMatchObject({ ok: true, outputText: "done" });
    expect(answers().map((entry) => entry.response.result.outcome.optionId)).toEqual(["reject"]);
  });
});

describe.each([["stdio relay", undefined], ["http", "1"]])("the broker bridge: an ACP agent reaches Brain's tools through MCP (%s)", (_name, http) => {
  const OTHER = { id: "fixture.other", digest: `sha256:${"c".repeat(64)}` };
  const OTHER_BINDING = { ...BINDING, release: OTHER } as EngineToolBinding;
  const engineWith = () => { if (http) process.env["FAKE_ACP_MCP_HTTP"] = http; return new AcpEngine({ toolBindings: [BINDING, OTHER_BINDING] }); };
  const call = (name: string, args: unknown = {}) => ({ mcp: { method: "tools/call", params: { name, arguments: args } } });
  type McpEntry = { method: string; response: { status?: number; body: { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { message: string } } | null } };
  const mcpLog = () => agentLog().filter((entry) => entry.event === "mcp") as unknown as McpEntry[];
  const servers = () => (agentLog().find((entry) => entry.event === "session/new") as unknown as { mcpServers: Array<Record<string, unknown>> }).mcpServers;

  it("tells the agent about one authenticated server, and lists only the tools the job declares", async () => {
    const { result } = await attempt(engineWith(), [{ mcp: { method: "tools/list" } }, { text: "ok" }]);
    expect(result.ok).toBe(true);
    expect(servers()).toHaveLength(1);
    expect(servers()[0]).toMatchObject({ name: "brain" });
    if (http) expect(servers()[0]).toMatchObject({ type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u), headers: [{ name: "Authorization", value: expect.stringMatching(/^Bearer [0-9a-f]{64}$/u) }] });
    else expect(servers()[0]).toMatchObject({ command: process.execPath, env: [{ name: "BRAIN_MCP_URL" }, { name: "BRAIN_MCP_TOKEN" }] });
    expect(mcpLog()[0]!.response.body?.result?.tools?.map((tool) => tool.name)).toEqual([BROKER_NAME]);
  });

  it("offers no server to a job that declares no tool", async () => {
    await attempt(engineWith(), [{ text: "ok" }], { allowedTools: [] });
    expect(servers()).toEqual([]);
  });

  it("runs a broker call through the runner's governed path and gives the agent its answer", async () => {
    const proposed: Array<{ proposalId: string; tool: { id: string }; input: unknown }> = [];
    const { result, emitted } = await attempt(engineWith(), [call(BROKER_NAME, { q: "x" }), { text: "done" }], {
      executeTool: async (proposal) => { proposed.push(proposal); return { proposalId: proposal.proposalId, invocationId: proposal.proposalId, output: { echoed: proposal.input }, receipt: RECEIPT(proposal.proposalId) }; },
    });
    expect(result).toMatchObject({ ok: true, outputText: "done" });
    expect(proposed).toMatchObject([{ tool: BROKER, input: { q: "x" } }]);
    expect(emitted.map((event) => event.kind)).toEqual(expect.arrayContaining(["tool.proposed", "tool.result"]));
    expect(mcpLog()[0]!.response.body?.result?.content?.[0]?.text).toContain("\"echoed\":{\"q\":\"x\"}");
  });

  it("refuses a tool the job does not declare, before anything reaches the governed path", async () => {
    let executed = 0;
    const { result, emitted } = await attempt(engineWith(), [call(nativeToolName(OTHER.id)), call("shell", { command: "id" }), { text: "done" }], {
      executeTool: async (proposal) => { executed += 1; return { proposalId: proposal.proposalId, invocationId: "i", output: {}, receipt: RECEIPT(proposal.proposalId) }; },
    });
    expect(result.ok).toBe(true);
    expect(executed).toBe(0);
    expect(emitted.filter((event) => event.kind === "tool.proposed")).toHaveLength(0);
    expect(mcpLog().map((entry) => entry.response.body?.error?.message)).toEqual([`unknown tool: ${nativeToolName(OTHER.id)}`, "unknown tool: shell"]);
  });

  it("fails the attempt, as for Pi and Claude, when the governed path refuses a call", async () => {
    const { result } = await attempt(engineWith(), [call(BROKER_NAME, { n: 1 }), { text: "done" }], {
      executeTool: async () => { throw new Error("Agent tool input rejected: nope"); },
    });
    expect(result.ok).toBe(false);
    expect(String((result.output as { error: string }).error)).toContain("nope");
  });

  it("stops serving calls past the job's call budget, telling the agent to write its answer", async () => {
    let executed = 0;
    const { result } = await attempt(engineWith(), [call(BROKER_NAME, { n: 1 }), call(BROKER_NAME, { n: 2 }), { text: "done" }], {
      maxTurns: 1,
      executeTool: async (proposal) => { executed += 1; return { proposalId: proposal.proposalId, invocationId: proposal.proposalId, output: { n: executed }, receipt: RECEIPT(proposal.proposalId) }; },
    });
    expect(result.ok).toBe(true);
    expect(executed).toBe(1);
    expect(mcpLog()[1]!.response.body?.result?.content?.[0]?.text).toContain("tool-call budget is used up");
  });

  if (http) {
    it("answers nothing to a caller without the attempt's token", async () => {
      const { result } = await attempt(engineWith(), [{ mcp: { method: "tools/list", noAuth: true } }, { text: "ok" }]);
      expect(result.ok).toBe(true);
      expect(mcpLog()[0]!.response.status).toBe(401);
    });
  }

  it("is closed when the attempt ends", async () => {
    await attempt(engineWith(), [{ text: "ok" }]);
    const server = servers()[0] as { url?: string; env?: Array<{ name: string; value: string }> };
    const url = server.url ?? server.env!.find((entry) => entry.name === "BRAIN_MCP_URL")!.value;
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

describe("Codex is an ACP engine with the same deny-by-default rules", () => {
  it("starts the command named by BRAIN_CODEX_COMMAND, passes no settings of its own, and runs an attempt", async () => {
    const engine = new CodexEngine([BINDING]);
    expect(engine.id).toBe("codex");
    const { result } = await attempt(engine, [permission("bash", "execute"), { text: "codex answer" }]);
    expect(result).toMatchObject({ ok: true, outputText: "codex answer" });
    expect((agentLog().find((entry) => entry.event === "started") as unknown as { env: { config: string | null } }).env.config).toBeNull();
    expect(answers().map((entry) => entry.response.result.outcome.optionId)).toEqual(["reject"]);
  });

  it("is selected by the runner as `codex` and states trusted-local isolation", () => {
    expect(selectEngine("codex", [BINDING])?.id).toBe("codex");
    expect(engineIsolation("codex")).toBe("trusted-local");
    expect(advertisedCapabilities([], [{ id: "codex", features: ["sessions"] }])).toEqual(expect.arrayContaining(["engine:codex", "engine-isolation:codex:trusted-local"]));
  });
});
