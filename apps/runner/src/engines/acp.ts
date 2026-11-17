import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JsonValue, NativeLevel } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";
import { engineFailureDetail } from "./failure-detail";
import { BrokerBridge } from "./mcp-bridge";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, StopReason } from "./port";
import { boundedToolText, ToolRequests } from "./tool-calls";

// ACP adapter over a stdio Agent Client Protocol agent. Speaks line-delimited JSON-RPC 2.0: initialize, session/new, session/prompt,
// session/cancel. `start` runs the whole attempt: it starts the agent, prompts it with the agent's instructions and the task, streams
// the agent's updates as engine events, and ends the stream with exactly one `stopped`.
//
// Workspace tools reach the agent through an MCP server of this process (mcp-bridge.ts) that the agent is told about in session/new.
// The agent's own tools are judged by the kind the agent reports for each call (read, search, edit, execute, ...):
// - the client declares no capabilities, so the agent reads, writes and runs commands itself, inside its sandbox, never through the runner;
// - a permission request is allowed when it is for a workspace tool or for a kind the agent's native level includes, and refused otherwise;
// - an agent that completes a tool of a kind its level does not include (it never asked, or ignored the refusal) is stopped and the session
//   fails. A call that is only announced or in progress is not judged yet: an agent reports those for a tool it then refuses itself.
// Some agents do not offer MCP tools to the model directly but through a tool of their own that carries the call (OpenCode's `execute`);
// such a carrier is allowed at every level, and is reported like any other of the agent's own tools.
interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }

export interface AcpEngineOptions {
  readonly id: string;
  /** The environment variable that names the agent's command line, and the command when it is not set. */
  readonly commandEnv: string;
  readonly defaultCommand: string;
  /** The agent's own settings for one session: where its model is and which of its tools are on. */
  readonly env: (spec: EngineSessionSpec) => Readonly<Record<string, string>>;
  /** The agent's own tools through which the model reaches workspace tools, by the name the agent reports. */
  readonly carriers?: readonly string[];
}

/** The kinds of its own tools an agent may run at each native level. */
const NATIVE_KINDS: Readonly<Record<NativeLevel, ReadonlySet<string>>> = {
  none: new Set(),
  read: new Set(["read", "search", "think"]),
  all: new Set(["read", "search", "think", "edit", "delete", "move", "execute"]),
};

/** What this client declares at initialize: nothing the agent could use to read, write or run anything through the runner. */
const ACP_CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false } as const;
const METHOD_NOT_FOUND = -32601;
/** Tool-call statuses in which an agent's tool is running or has run. */
const RAN = new Set(["in_progress", "completed", "failed"]);
/** What the agent process inherits from the runner: how to find programs and the network, nothing that is a credential. */
const INHERITED = ["PATH", "HOME", "LANG", "TMPDIR", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "NODE_USE_ENV_PROXY"] as const;

interface AgentToolCall { label?: string; kind?: string; input?: JsonValue; reported?: boolean; done?: boolean }
type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export class AcpEngine implements EngineAdapter {
  readonly id: string;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId = "";
  private stream = new EngineEventStream();
  /** Assistant text since the agent last did something else: the answer is what follows its last tool call. */
  private textBuffer = "";
  private terminated = false;
  private running: Promise<void> = Promise.resolve();
  private requests: ToolRequests | undefined;
  private bridge: BrokerBridge | undefined;
  private native: NativeLevel = "none";
  private turns = 1;
  /** What the agent said about each tool call it made, by its call id, so an update that carries only the id and a status is still judged. */
  private readonly toolCalls = new Map<string, AgentToolCall>();
  private violation = "";

  constructor(private readonly options: AcpEngineOptions) { this.id = options.id; }

  private spawnAgent(cwd: string, env: Readonly<Record<string, string>>): ChildProcess {
    const [file = "", ...args] = (process.env[this.options.commandEnv] ?? this.options.defaultCommand).split(/\s+/u);
    const inherited = Object.fromEntries(INHERITED.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
    const proc = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...inherited, ...env } });
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at + 1);
        if (line) this.onLine(line);
      }
    });
    const gone = (reason: string): void => {
      for (const waiting of this.pending.values()) waiting.reject(new Error(reason));
      this.pending.clear();
      if (this.proc === proc) this.proc = null;
    };
    // A binary that cannot be started is the agent being unavailable, not an uncaught exception in the runner.
    proc.on("error", (error) => gone(`ACP agent could not start: ${error.message}`));
    proc.on("exit", () => gone(this.violation || "ACP agent exited"));
    this.buffer = "";
    this.proc = proc;
    return proc;
  }

  private onLine(line: string): void {
    if (this.violation) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = message["id"];
    // A message with a method is the agent speaking, whatever its id: its request ids are its own and may equal ours.
    if (typeof message["method"] === "string") {
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      if (typeof id === "number" || typeof id === "string") this.onAgentRequest(id, message["method"], params);
      else if (message["method"] === "session/update") this.onUpdate((params["update"] ?? {}) as Record<string, unknown>);
      return;
    }
    if (typeof id !== "number") return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if (message["error"]) waiting.reject(new Error(JSON.stringify(message["error"])));
    else waiting.resolve((message["result"] ?? {}) as Record<string, unknown>);
  }

  private reply(id: number | string, body: { result: unknown } | { error: { code: number; message: string } }): void {
    this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  }

  /** A request from the agent. A permission request is decided here; anything else needs a client capability this client does not declare. */
  private onAgentRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === "session/request_permission") this.reply(id, { result: { outcome: this.decidePermission(params) } });
    else this.reply(id, { error: { code: METHOD_NOT_FOUND, message: `${method} is not supported: this client declares no capabilities` } });
  }

  /** What the agent calls the tool: ACP has a title; some agents also send a name. A workspace tool is known by the name the bridge serves it under. */
  private workspaceTool(label: string | undefined): boolean {
    if (!label || !this.requests) return false;
    return this.requests.names().some((name) => label === name || label.endsWith(`_${name}`));
  }

  private allowedCall(call: AgentToolCall): boolean {
    if (call.label !== undefined && this.options.carriers?.includes(call.label)) return true;
    return this.workspaceTool(call.label) ? call.kind === undefined || call.kind === "other" : call.kind !== undefined && NATIVE_KINDS[this.native].has(call.kind);
  }

  private remember(update: Record<string, unknown>): AgentToolCall {
    const callId = String(update["toolCallId"] ?? "");
    const seen = this.toolCalls.get(callId) ?? {};
    const label = typeof update["name"] === "string" ? update["name"] : typeof update["title"] === "string" ? update["title"] : undefined;
    if (label !== undefined && seen.label === undefined) seen.label = label.slice(0, 200);
    if (typeof update["kind"] === "string") seen.kind = update["kind"];
    if (update["rawInput"] !== undefined) seen.input = update["rawInput"] as JsonValue;
    this.toolCalls.set(callId, seen);
    return seen;
  }

  /** Allow once a workspace tool or one of the agent's own tools of an allowed kind; refuse everything else with the agent's own reject option. */
  private decidePermission(params: Record<string, unknown>): PermissionOutcome {
    const call = this.remember((params["toolCall"] ?? {}) as Record<string, unknown>);
    const options = Array.isArray(params["options"]) ? params["options"] as Array<Record<string, unknown>> : [];
    const optionOf = (kind: string) => options.find((option) => option["kind"] === kind && typeof option["optionId"] === "string")?.["optionId"] as string | undefined;
    const allow = this.allowedCall(call) ? optionOf("allow_once") : undefined;
    if (allow) return { outcome: "selected", optionId: allow };
    this.push({ kind: "text", channel: "diagnostic", text: `Refused the agent's own tool ${call.label ?? "unnamed"}${call.kind ? ` (${call.kind})` : ""}: the agent's native tools are "${this.native}".` });
    const refusal = optionOf("reject_once");
    return refusal ? { outcome: "selected", optionId: refusal } : { outcome: "cancelled" };
  }

  private onUpdate(update: Record<string, unknown>): void {
    const kind = update["sessionUpdate"];
    if (kind === "agent_message_chunk") {
      const content = update["content"] as { type?: string; text?: string } | undefined;
      if (content?.type === "text") this.textBuffer += content.text ?? "";
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      // What the agent said before it used a tool was narration, not the answer.
      this.flushText("diagnostic");
      this.watchToolCall(update);
    }
  }

  private flushText(channel: "assistant" | "diagnostic"): void {
    if (!this.textBuffer) return;
    const text = this.textBuffer;
    this.textBuffer = "";
    this.push({ kind: "text", channel, text });
  }

  /**
   * One of the agent's own tools that runs is reported as a native call and, once it ends, its result. A tool of a kind the native level
   * does not include that runs anyway means the agent did what this client refuses: the session is stopped.
   */
  private watchToolCall(update: Record<string, unknown>): void {
    const callId = String(update["toolCallId"] ?? "");
    const call = this.remember(update);
    const status = typeof update["status"] === "string" ? update["status"] : "";
    if (!RAN.has(status) || this.workspaceTool(call.label) && this.allowedCall(call)) return;
    if (!this.allowedCall(call)) {
      // Only a call that completed has run: one the agent announces and then fails was refused by the agent itself.
      if (status !== "completed") return;
      this.violation = `the ACP agent ran its own tool ${call.label ?? "unnamed"}${call.kind ? ` (${call.kind})` : ""} although the agent's native tools are "${this.native}", so the session was stopped`;
      this.stop("error", this.violation);
      this.kill();
      return;
    }
    if (!call.reported) { call.reported = true; this.turns += 1; this.push({ kind: "native.call", callId, name: call.label ?? call.kind ?? "tool", input: call.input ?? {} }); }
    if ((status === "completed" || status === "failed") && !call.done) {
      call.done = true;
      const content = Array.isArray(update["content"]) ? update["content"] as Array<{ type?: string; content?: { type?: string; text?: string } }> : [];
      const text = content.map((part) => (part.type === "content" && part.content?.type === "text" ? part.content.text ?? "" : "")).join("");
      this.push({ kind: "native.result", callId, ok: status === "completed", output: boundedToolText(text || ((update["rawOutput"] ?? "") as JsonValue)) });
    }
  }

  /** The one terminal event of the session. Later calls do nothing. */
  private stop(reason: StopReason, detail?: string): void {
    if (this.terminated) return;
    this.push({ kind: "stopped", reason, ...(detail ? { detail } : {}) });
    this.terminated = true;
    this.stream.close();
    this.bridge?.close();
    this.requests?.clear();
  }

  private push(event: EngineEvent): void { if (!this.terminated) this.stream.push(event); }

  private request(method: string, params: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const proc = this.proc;
    if (!proc?.stdin) return Promise.reject(new Error("ACP agent not running"));
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`ACP ${method} timed out`), { timedOut: true })); }, timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private initialize(): Promise<Record<string, unknown>> {
    return this.request("initialize", { protocolVersion: 1, clientInfo: { name: "brain-runner", version: "0.1.0" }, clientCapabilities: ACP_CLIENT_CAPABILITIES }, 20_000);
  }

  /** Starts the agent once to ask what it is, then ends it: a session gets its own process with its own settings. */
  async probe() {
    try {
      this.spawnAgent(process.cwd(), {});
      const info = ((await this.initialize())["agentInfo"] ?? {}) as { version?: string };
      const version = typeof info.version === "string" && info.version.length > 0 && info.version.length <= 64 ? info.version : undefined;
      return { id: this.id, ...(version ? { version } : {}), ready: true };
    } catch {
      return { id: this.id, ready: false };
    } finally {
      this.kill();
    }
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<void> {
    this.kill();
    this.stream = new EngineEventStream();
    this.terminated = false;
    this.violation = "";
    this.textBuffer = "";
    this.turns = 1;
    this.toolCalls.clear();
    this.native = spec.native;
    const cwd = spec.workDir ?? spec.stateDir;
    const requests = new ToolRequests(spec.tools, (event) => this.push(event), { ...(spec.limits.maxTurns > 0 ? { maxCalls: spec.limits.maxTurns } : {}) });
    this.requests = requests;
    try {
      this.spawnAgent(cwd, this.options.env(spec));
      const capabilities = ((await this.initialize())["agentCapabilities"] ?? {}) as { mcpCapabilities?: { http?: unknown } };
      if (signal.aborted) throw new Error("aborted");
      // Only the tools this agent may use are served, and only when there are any: an agent with none is told about no server.
      const mcpServers: unknown[] = [];
      let listed: Promise<void> | undefined;
      if (spec.tools.length > 0) {
        const bridge = new BrokerBridge(requests.entries().map(([name, tool]) => ({ name, tool })), (name, input) => {
          // A call that came through a carrier was counted with the carrier.
          if (!this.options.carriers?.length) this.turns += 1;
          return requests.execute(name, input);
        });
        this.bridge = bridge;
        const { url } = await bridge.listen();
        listed = bridge.listed;
        mcpServers.push(capabilities.mcpCapabilities?.http === true
          ? { type: "http", name: "brain", url, headers: [{ name: "Authorization", value: `Bearer ${bridge.token}` }] }
          : { name: "brain", command: process.execPath, args: [fileURLToPath(new URL("./mcp-relay.mjs", import.meta.url))], env: [{ name: "BRAIN_MCP_URL", value: url }, { name: "BRAIN_MCP_TOKEN", value: bridge.token }] });
      }
      this.sessionId = String((await this.request("session/new", { cwd, mcpServers }, 30_000))["sessionId"] ?? "");
      if (!this.sessionId) throw new Error("ACP session/new returned no sessionId");
      // The agent connects to the bridge on its own time; the prompt waits a moment for it to have read the tool list, so the first turn knows the tools.
      if (listed) await Promise.race([listed, new Promise<void>((resolve) => { setTimeout(resolve, 5000).unref(); })]);
    } catch (error) {
      this.stop("error", engineFailureDetail(error instanceof Error ? error.message : "the ACP agent could not start"));
      this.kill();
      return;
    }
    signal.addEventListener("abort", () => { void this.cancel(); }, { once: true });
    this.running = this.run(spec);
  }

  /** One prompt turn: the agent's instructions and the task, then the one terminal event for however it ended. */
  private async run(spec: EngineSessionSpec): Promise<void> {
    const prompt = `${spec.instructions.trim()}\n\n# Task\n${spec.task}`.trim();
    let result: Record<string, unknown>;
    try {
      result = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: prompt }] }, spec.limits.timeoutMs);
    } catch (error) {
      const timedOut = (error as { timedOut?: boolean }).timedOut === true;
      this.flushText("diagnostic");
      this.stop(timedOut ? "timeout" : "error", engineFailureDetail(error instanceof Error ? error.message : "ACP prompt failed"));
      this.kill();
      return;
    }
    if (this.terminated) return;
    // Usage as the ACP prompt result states it; an agent that reports none leaves the figures to the gateway.
    const usage = (result["usage"] ?? {}) as { inputTokens?: unknown; outputTokens?: unknown; cachedReadTokens?: unknown };
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
    const inputTokens = count(usage.inputTokens), outputTokens = count(usage.outputTokens), cachedInputTokens = count(usage.cachedReadTokens);
    this.push({ kind: "usage", inputTokens, outputTokens, cachedInputTokens, microUsd: 0, turns: this.turns });
    const stopReason = result["stopReason"];
    if (stopReason === "end_turn") { this.flushText("assistant"); this.stop("completed"); return; }
    this.flushText("diagnostic");
    if (stopReason === "cancelled") this.stop("cancelled", "the session was cancelled");
    else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") this.stop("limit", `the agent stopped at its own limit (${String(stopReason)})`);
    else this.stop("error", stopReason === "refusal" ? "the agent refused to do the task" : `the agent ended its turn with an unknown reason (${typeof stopReason === "string" ? stopReason : "none"})`);
  }

  events(signal: AbortSignal): AsyncIterable<EngineEvent> { return this.stream.read(signal); }

  async toolResult(callId: string, text: string): Promise<void> {
    if (!this.requests) throw new Error("no ACP session is running");
    this.requests.complete(callId, text);
  }

  /** Asks the agent to stop, gives it a moment to say so, then ends the process. */
  async cancel(): Promise<void> {
    if (!this.terminated && this.sessionId && this.proc) {
      this.proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } })}\n`);
      await Promise.race([this.running, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    }
    this.stop("cancelled", "the session was cancelled");
    this.kill();
  }

  private kill(): void {
    try { this.proc?.kill("SIGTERM"); } catch { /* already gone */ }
    this.proc = null;
  }

  async dispose(): Promise<void> {
    this.bridge?.close();
    this.requests?.clear();
    this.stream.close();
    this.kill();
  }
}
