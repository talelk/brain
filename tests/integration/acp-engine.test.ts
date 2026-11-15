import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent, EngineSessionSpec, EngineToolBinding } from "@brain/contracts";
import { AcpEngine } from "../../apps/runner/src/engines/acp";
import { OpenCodeEngine } from "../../apps/runner/src/engines/opencode";
import { advertisedCapabilities, advertisedIsolationModes, engineIsolation } from "../../apps/runner/src/engines/isolation";
import { selectEngine } from "../../apps/runner/src/engines/run";
import { nativeToolName } from "../../apps/runner/src/engines/tool-calls";

// ADR 0035, at the runner's engine-adapter seam: a fake ACP agent (tests/support/fake-acp-agent.mjs) asks the adapter for permissions and
// for capabilities it never declared, and reports tool calls; the adapter's answers and what the agent received are checked. The real
// OpenCode is never started: BRAIN_ACP_COMMAND and BRAIN_OPENCODE_COMMAND both name the fake.

const AGENT = fileURLToPath(new URL("../support/fake-acp-agent.mjs", import.meta.url));
const BROKER = { id: "fixture.echo", digest: `sha256:${"a".repeat(64)}` };
const BROKER_NAME = nativeToolName(BROKER.id);
const BINDING = { release: BROKER, inputSchema: {}, effectClass: "read", target: { targetId: "t", environmentId: "e", kind: "read" } } as unknown as EngineToolBinding;

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-acp-"));
  for (const name of ["BRAIN_ACP_COMMAND", "BRAIN_OPENCODE_COMMAND", "FAKE_ACP_LOG"]) saved[name] = process.env[name];
  process.env["BRAIN_ACP_COMMAND"] = `${process.execPath} ${AGENT}`;
  process.env["BRAIN_OPENCODE_COMMAND"] = `${process.execPath} ${AGENT}`;
  process.env["FAKE_ACP_LOG"] = join(dir, "agent.log");
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(dir, { recursive: true, force: true });
});

const spec = (over: Partial<EngineSessionSpec> = {}): EngineSessionSpec => ({ ...(JSON.parse(readFileSync("examples/v1/transport/EngineSessionSpec.json", "utf8")) as EngineSessionSpec), allowedTools: [BROKER], ...over });
interface AgentLogEntry {
  event: string;
  clientCapabilities?: unknown;
  mcpServers?: unknown;
  env: { config: string | null; projectConfigOff: string | null; claudeCodeOff: string | null };
  method: string;
  params: { toolCall: { name?: string; kind?: string } };
  response: { result: { outcome: { outcome: string; optionId?: string } } | null; error: { code: number } | null };
}
const agentLog = (): AgentLogEntry[] => readFileSync(join(dir, "agent.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentLogEntry);
const answers = () => agentLog().filter((entry) => entry.event === "answer");
const permission = (name: string | undefined, kind: string, extra: Record<string, unknown> = {}) => ({
  request: {
    method: "session/request_permission",
    params: {
      toolCall: { toolCallId: `call-${name ?? "unnamed"}`, ...(name !== undefined ? { name } : {}), kind, title: name ?? "tool", status: "pending", rawInput: {} },
      options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "always", kind: "allow_always", name: "Always allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }],
      ...extra,
    },
  },
});

/** The attempt as the runner runs it: start (which prompts the agent with the steps as its task) and read the event stream to its end. */
async function play(engine: AcpEngine, steps: unknown[], over: Partial<EngineSessionSpec> = {}): Promise<EngineEvent[]> {
  const controller = new AbortController();
  const { sessionId } = await engine.start(spec({ task: JSON.stringify(steps), ...over }), controller.signal);
  const events: EngineEvent[] = [];
  for await (const event of engine.events(sessionId, 0, controller.signal)) events.push(event);
  return events;
}

describe("an ACP agent has no way to the host except broker tools (ADR 0035)", () => {
  it("declares no client capabilities, and no MCP servers for a job without tools", async () => {
    const engine = new AcpEngine({ toolBindings: [BINDING] });
    try { await play(engine, [], { allowedTools: [] }); } finally { await engine.dispose(); }
    const log = agentLog();
    expect(log.find((entry) => entry.event === "initialize")?.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(log.find((entry) => entry.event === "session/new")?.mcpServers).toEqual([]);
  });

  it("refuses the permission to run a shell command, edit a file or fetch a URL, and allows only the broker tool, once", async () => {
    const engine = new AcpEngine({ toolBindings: [BINDING] });
    let events: EngineEvent[];
    try {
      events = await play(engine, [
        permission("bash", "execute"),
        permission("edit", "edit"),
        permission("webfetch", "fetch"),
        permission(BROKER_NAME, "other"),
        // Everything else: a read, a tool of the release that the session does not allow, an unnamed call, a command that is named like a broker tool.
        permission("read", "read"),
        permission("brain_not_allowed", "other"),
        permission(undefined, "other"),
        permission(BROKER_NAME, "execute"),
      ]);
    } finally { await engine.dispose(); }
    const outcomes = answers().map((entry) => ({ tool: entry.params.toolCall.name ?? "unnamed", kind: entry.params.toolCall.kind, ...entry.response }));
    expect(outcomes).toEqual([
      { tool: "bash", kind: "execute", error: null, result: { outcome: { outcome: "selected", optionId: "reject" } } },
      { tool: "edit", kind: "edit", error: null, result: { outcome: { outcome: "selected", optionId: "reject" } } },
      { tool: "webfetch", kind: "fetch", error: null, result: { outcome: { outcome: "selected", optionId: "reject" } } },
      { tool: BROKER_NAME, kind: "other", error: null, result: { outcome: { outcome: "selected", optionId: "once" } } },
      { tool: "read", kind: "read", error: null, result: { outcome: { outcome: "selected", optionId: "reject" } } },
      { tool: "brain_not_allowed", kind: "other", error: null, result: { outcome: { outcome: "selected", optionId: "reject" } } },
      { tool: "unnamed", kind: "other", error: null, result: { outcome: { outcome: "selected", optionId: "reject" } } },
      { tool: BROKER_NAME, kind: "execute", error: null, result: { outcome: { outcome: "selected", optionId: "reject" } } },
    ]);
    // The refusals are on the diagnostic channel, so an operator sees them; none of them ends the session.
    const notes = events.filter((event) => event.kind === "text" && event.payload.channel === "diagnostic").map((event) => (event.payload as { text: string }).text);
    expect(notes).toHaveLength(7);
    expect(notes[0]).toContain("bash (execute)");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("cancels the permission when the agent offers no reject option, and never allows a broker tool for want of allow_once", async () => {
    const engine = new AcpEngine({ toolBindings: [BINDING] });
    const onlyAlways = [{ optionId: "always", kind: "allow_always", name: "Always" }];
    try {
      await play(engine, [permission("bash", "execute", { options: [] }), permission(BROKER_NAME, "other", { options: onlyAlways })]);
    } finally { await engine.dispose(); }
    expect(answers().map((entry) => entry.response.result)).toEqual([{ outcome: { outcome: "cancelled" } }, { outcome: { outcome: "cancelled" } }]);
  });

  it("allows nothing when the session's spec does not allow the release's tool, or the engine has no tools", async () => {
    for (const engine of [new AcpEngine({ toolBindings: [{ ...BINDING, release: { ...BROKER, digest: `sha256:${"b".repeat(64)}` } }] }), new AcpEngine()]) {
      try { await play(engine, [permission(BROKER_NAME, "other")]); } finally { await engine.dispose(); }
    }
    expect(answers().map((entry) => entry.response.result)).toEqual([{ outcome: { outcome: "selected", optionId: "reject" } }, { outcome: { outcome: "selected", optionId: "reject" } }]);
  });

  it("answers a request for a capability it never declared with method not found, whatever id the agent uses", async () => {
    const engine = new AcpEngine({ toolBindings: [BINDING] });
    try {
      // The agent's ids 1, 2 and 3 equal the ids of the client's own requests, the last of which (the prompt) is still waiting: none of them may be taken for its answer.
      await play(engine, [
        { request: { method: "fs/read_text_file", params: { path: "/etc/passwd" } } },
        { request: { method: "fs/write_text_file", params: { path: "/tmp/x", content: "x" } } },
        { request: { method: "terminal/create", params: { command: "id" } } },
        { request: { method: "elicitation/create", params: {} } },
      ]);
    } finally { await engine.dispose(); }
    for (const entry of answers()) expect(entry.response).toMatchObject({ result: null, error: { code: -32601 } });
    expect(answers().map((entry) => entry.method)).toEqual(["fs/read_text_file", "fs/write_text_file", "terminal/create", "elicitation/create"]);
  });

  it("stops an agent that runs a native tool, with or without having asked, and fails the session", async () => {
    for (const asked of [true, false]) {
      const engine = new AcpEngine({ toolBindings: [BINDING] });
      const call = { toolCallId: "call-bash", name: "bash", kind: "execute", title: "ls /" };
      // A call that was only attempted and refused is not a violation; one that runs is.
      const steps = [...(asked ? [permission("bash", "execute")] : []), { update: { sessionUpdate: "tool_call", ...call, status: "pending" } }, { update: { sessionUpdate: "tool_call_update", toolCallId: "call-bash", status: "in_progress" } }, { text: "never reached" }];
      const events = await play(engine, steps);
      expect(events.find((event) => event.kind === "error")).toMatchObject({ payload: { error: { code: "POLICY_DENIED", retryable: false, detail: expect.stringContaining("ran a native tool (bash, execute)") }, retryClass: "never" } });
      expect(events.at(-1)).toMatchObject({ kind: "session.stopped", payload: { reason: "error", terminationConfirmed: true } });
      expect(events.some((event) => event.kind === "text" && event.payload.channel === "assistant")).toBe(false);
      await engine.dispose();
    }
  });

  it("lets a refused or failed native tool call and a running broker tool pass", async () => {
    const engine = new AcpEngine({ toolBindings: [BINDING] });
    let events: EngineEvent[];
    try {
      events = await play(engine, [
        { update: { sessionUpdate: "tool_call", toolCallId: "refused", name: "bash", kind: "execute", status: "pending" } },
        { update: { sessionUpdate: "tool_call_update", toolCallId: "refused", status: "failed" } },
        { update: { sessionUpdate: "tool_call", toolCallId: "broker", name: BROKER_NAME, kind: "other", status: "pending" } },
        { update: { sessionUpdate: "tool_call_update", toolCallId: "broker", status: "in_progress" } },
        { update: { sessionUpdate: "tool_call_update", toolCallId: "broker", status: "completed" } },
        { text: "done" },
      ]);
    } finally { await engine.dispose(); }
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(events.filter((event) => event.kind === "text").map((event) => (event.payload as { text: string }).text)).toEqual(["done"]);
  });

  it("stops an agent that reports a broker tool as a command", async () => {
    const engine = new AcpEngine({ toolBindings: [BINDING] });
    const events = await play(engine, [{ update: { sessionUpdate: "tool_call", toolCallId: "spoof", name: BROKER_NAME, kind: "execute", status: "in_progress" } }]);
    expect(events.find((event) => event.kind === "error")).toMatchObject({ payload: { error: { code: "POLICY_DENIED" } } });
    await engine.dispose();
  });
});

describe("OpenCode starts with its native tools off and without any other configuration (ADR 0035)", () => {
  /** OpenCode's rules are ordered and later ones override earlier ones (scripts/run_model_qualification.ts): the effect of an action is its last matching rule. */
  const effectOf = (rules: Array<{ action: string; resource: string; effect: string }>, action: string): string | undefined =>
    rules.filter((rule) => (rule.action === "*" || rule.action === action) && rule.resource === "*").at(-1)?.effect;

  it("denies shell, edit, write, patch, fetch and search, and asks for everything else, in the settings it is started with", async () => {
    const engine = new OpenCodeEngine([BINDING]);
    try { await play(engine, []); } finally { await engine.dispose(); }
    const started = agentLog().find((entry) => entry.event === "started")!.env;
    const config = JSON.parse(started.config ?? "{}") as { permissions: Array<{ action: string; resource: string; effect: string }> };
    for (const action of ["shell", "edit", "write", "patch", "webfetch", "websearch", "read", "glob", "grep", "external_directory", "subagent"]) expect(effectOf(config.permissions, action), action).toBe("deny");
    expect(effectOf(config.permissions, BROKER_NAME)).toBe("ask");
    expect(effectOf(config.permissions, "anything-else")).toBe("ask");
    expect(started.projectConfigOff).toBe("1");
    expect(started.claudeCodeOff).toBe("1");
  });

  it("applies the same permission rules as the generic ACP engine, and the generic engine adds no settings", async () => {
    const opencode = new OpenCodeEngine([BINDING]);
    try { await play(opencode, [permission("bash", "execute"), permission(BROKER_NAME, "other")]); } finally { await opencode.dispose(); }
    expect(answers().map((entry) => entry.response.result?.outcome.optionId)).toEqual(["reject", "once"]);
    const generic = new AcpEngine();
    try { await play(generic, []); } finally { await generic.dispose(); }
    const started = agentLog().filter((entry) => entry.event === "started").at(-1)!.env;
    expect(started.config).toBeNull();
  });

  it("is selected with its tools by the runner, for both ACP engines", () => {
    expect(selectEngine("opencode", [BINDING])?.id).toBe("opencode");
    expect(selectEngine("acp", [BINDING])?.id).toBe("acp");
  });
});

describe("a runner states the isolation each engine really provides (ADR 0035, 0073)", () => {
  const probed = (...ids: string[]) => ids.map((id) => ({ id, features: ["sessions"] }));

  it("states trusted-local for every engine that runs in the runner process, except the fixture that runs no model or tool", () => {
    const capabilities = advertisedCapabilities(["os:linux", "isolation:ephemeral-container"], probed("fixture", "pi", "claude", "acp", "opencode"), false);
    expect(capabilities).toEqual(expect.arrayContaining([
      "engine-isolation:fixture:ephemeral-container", "engine-isolation:pi:trusted-local", "engine-isolation:claude:trusted-local",
      "engine-isolation:acp:trusted-local", "engine-isolation:opencode:trusted-local", "engine:opencode", "engine-feature:opencode:sessions", "os:linux",
    ]));
    expect(engineIsolation("a-new-engine", true)).toBe("trusted-local");
  });

  it("states ephemeral-container for every engine that runs in its own sandbox, ACP agents included", () => {
    const capabilities = advertisedCapabilities(["os:linux"], probed("fixture", "pi", "claude", "acp", "opencode"), true);
    expect(capabilities).toEqual(expect.arrayContaining([
      "engine-isolation:fixture:ephemeral-container", "engine-isolation:pi:ephemeral-container", "engine-isolation:claude:ephemeral-container",
      "engine-isolation:acp:ephemeral-container", "engine-isolation:opencode:ephemeral-container",
    ]));
    expect(capabilities.filter((capability) => capability.endsWith(":trusted-local"))).toEqual([]);
  });

  it("does not let an operator configure an engine's isolation, or an engine that was not probed", () => {
    const capabilities = advertisedCapabilities(["os:linux", "engine-isolation:opencode:ephemeral-container", "engine:pi", "engine-feature:pi:sessions"], probed("opencode"), false);
    expect(capabilities).toContain("engine-isolation:opencode:trusted-local");
    expect(capabilities).not.toContain("engine-isolation:opencode:ephemeral-container");
    expect(capabilities.filter((capability) => capability.startsWith("engine")).sort()).toEqual(["engine-feature:opencode:sessions", "engine-isolation:opencode:trusted-local", "engine:opencode"]);
  });

  it("lists the runner's isolation modes from what it runs", () => {
    expect(advertisedIsolationModes(probed("fixture", "pi"), true)).toEqual(["ephemeral-container"]);
    expect(advertisedIsolationModes(probed("pi", "opencode"), false).sort()).toEqual(["ephemeral-container", "trusted-local"]);
  });
});
