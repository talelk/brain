import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, EngineToolBinding } from "@brain/contracts";
import { nativeToolName } from "./tool-calls";

// ACP adapter over a stdio Agent Client Protocol agent (default:
// `opencode acp`). Speaks line-delimited JSON-RPC 2.0: initialize,
// session/new, session/prompt, session/cancel.
//
// The agent reaches the host only through Brain broker tools (ADR 0035):
// - the client declares no capabilities, and every agent request other than a permission request is refused (-32601);
// - every permission request is refused unless it names exactly a broker tool this session may use, and then only allow_once is chosen;
// - an agent that runs a native tool anyway (it never asked, or ignored the refusal) is stopped and the session ends in error.
interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

export interface AcpEngineOptions {
  readonly id?: string;
  readonly commandEnv?: string;
  readonly defaultCommand?: string;
  /** The broker tools of the agent's release; a session may use only those its spec allows. */
  readonly toolBindings?: readonly EngineToolBinding[];
  /** What the agent process gets on top of the runner's environment: the agent's own settings that turn its native tools off. */
  readonly env?: Readonly<Record<string, string>>;
}

/** What this client declares at initialize: nothing the agent could use to read, write or run anything through the runner. */
const ACP_CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false } as const;

const METHOD_NOT_FOUND = -32601;
/** Tool-call statuses in which an agent's tool is running or has run. */
const RAN = new Set(["in_progress", "completed"]);

interface AgentToolCall { name?: string; kind?: string }
type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** The digest of this adapter's own code, as the other engines state theirs. */
const adapterDigest = (): string => sha256Digest(new Uint8Array(readFileSync(new URL(import.meta.url))));

export class AcpEngine implements EngineAdapter {
  readonly id: string;
  private readonly commandEnv: string;
  private readonly defaultCommand: string;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId = "";
  private attemptId = "";
  private seq = 0;
  private readonly eventsBuffer: EngineEvent[] = [];
  /** What the agent said about itself in `initialize`; absent until probed and when it states no version. */
  private agentVersion: string | undefined;
  private probed = false;
  private readonly bindings: readonly EngineToolBinding[];
  private readonly agentEnv: Readonly<Record<string, string>>;
  /** The broker tool names this session may use: the release's tools that the session spec allows, by id and digest. Empty until start. */
  private allowedNames = new Set<string>();
  /** What the agent said about each tool call it made, by its call id, so an update that carries only the id and a status is still judged. */
  private readonly toolCalls = new Map<string, AgentToolCall>();
  /** Set when the agent ran a native tool: the reason the session was stopped. */
  private violation = "";
  /** What the agent advertised at initialize; nothing beyond it is ever offered (#32). */
  private negotiated: { loadSession: boolean; resume: boolean; fork: boolean } = { loadSession: false, resume: false, fork: false };

  constructor(options: AcpEngineOptions = {}) {
    this.id = options.id ?? "acp";
    this.commandEnv = options.commandEnv ?? "BRAIN_ACP_COMMAND";
    this.defaultCommand = options.defaultCommand ?? "opencode acp";
    this.bindings = options.toolBindings ?? [];
    this.agentEnv = options.env ?? {};
  }

  private command(): { file: string; args: string[] } {
    const raw = process.env[this.commandEnv] ?? this.defaultCommand;
    const [file, ...args] = raw.split(/\s+/);
    return { file: file ?? "opencode", args };
  }

  private ensureProc(cwd: string): ChildProcess {
    if (this.proc) return this.proc;
    const { file, args } = this.command();
    const proc = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...this.agentEnv } });
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.onLine(line);
        idx = this.buffer.indexOf("\n");
      }
    });
    proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error(this.violation || "ACP agent exited"));
      this.pending.clear();
      this.proc = null;
    });
    this.proc = proc;
    return proc;
  }

  private onLine(line: string): void {
    if (this.violation) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = msg["id"];
    // A message with a method is the agent speaking, whatever its id: its request ids are its own and may equal ours.
    if (typeof msg["method"] === "string") {
      const params = (msg["params"] ?? {}) as Record<string, unknown>;
      if (typeof id === "number" || typeof id === "string") this.onAgentRequest(id, msg["method"], params);
      else this.onNotification(msg["method"], params);
      return;
    }
    if (typeof id !== "number") return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg["error"]) p.reject(new Error(JSON.stringify(msg["error"])));
    else p.resolve((msg["result"] ?? {}) as Record<string, unknown>);
  }

  private reply(id: number | string, body: { result: unknown } | { error: { code: number; message: string } }): void {
    this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  }

  /** A request from the agent. A permission request is decided here; anything else needs a client capability this client does not declare. */
  private onAgentRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === "session/request_permission") {
      this.reply(id, { result: { outcome: this.decidePermission(params) } });
      return;
    }
    this.reply(id, { error: { code: METHOD_NOT_FOUND, message: `${method} is not supported: this client declares no capabilities` } });
  }

  /**
   * Allow only a broker tool: the request names (toolCall.name) exactly the tool of a binding this session's spec allows, does not call itself
   * a command, edit or fetch, and the agent offers allow_once (never allow_always). The title and the input, which the agent writes freely,
   * decide nothing. Everything else is refused with the agent's own reject_once option, or cancelled when it offers none.
   */
  private decidePermission(params: Record<string, unknown>): PermissionOutcome {
    const call = (params["toolCall"] ?? {}) as Record<string, unknown>;
    const name = typeof call["name"] === "string" ? call["name"] : undefined;
    const options = Array.isArray(params["options"]) ? params["options"] as Array<Record<string, unknown>> : [];
    const optionOf = (kind: string) => options.find((option) => option["kind"] === kind && typeof option["optionId"] === "string")?.["optionId"] as string | undefined;
    // The name is what the agent calls the tool; a broker tool is an MCP tool, which an agent reports as "other". A call the agent itself
    // reports as running a command, editing or fetching is refused whatever it is named.
    const broker = name !== undefined && this.allowedNames.has(name) && (call["kind"] === undefined || call["kind"] === "other");
    if (typeof call["toolCallId"] === "string") this.toolCalls.set(call["toolCallId"], { ...(name !== undefined ? { name } : {}), ...(typeof call["kind"] === "string" ? { kind: call["kind"] } : {}) });
    const allow = broker ? optionOf("allow_once") : undefined;
    if (allow) return { outcome: "selected", optionId: allow };
    if (!broker) this.note(`Refused a native tool: ${name ?? "unnamed"}${typeof call["kind"] === "string" ? ` (${call["kind"]})` : ""}. ACP engines may use Brain broker tools only.`);
    const refusal = optionOf("reject_once");
    return refusal ? { outcome: "selected", optionId: refusal } : { outcome: "cancelled" };
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const update = params["update"] as Record<string, unknown> | undefined;
    if (!update) return;
    const kind = update["sessionUpdate"];
    if (kind === "agent_message_chunk") {
      const content = update["content"] as { type?: string; text?: string } | undefined;
      if (content?.type === "text") this.push("text", { text: content.text ?? "", channel: "assistant", provisional: true });
    } else if (kind === "tool_call" || kind === "tool_call_update") this.watchToolCall(update);
  }

  /** A native tool that is running or finished means the agent did what this client refuses: stop it. A refused attempt (pending, failed) is not that. */
  private watchToolCall(update: Record<string, unknown>): void {
    const callId = String(update["toolCallId"] ?? "");
    const seen = this.toolCalls.get(callId) ?? {};
    if (typeof update["name"] === "string") seen.name = update["name"];
    if (typeof update["kind"] === "string") seen.kind = update["kind"];
    this.toolCalls.set(callId, seen);
    if (typeof update["status"] !== "string" || !RAN.has(update["status"])) return;
    if (seen.name !== undefined && this.allowedNames.has(seen.name) && (seen.kind === undefined || seen.kind === "other")) return;
    this.violation = `the ACP agent ran a native tool (${seen.name ?? "unnamed"}${seen.kind ? `, ${seen.kind}` : ""}); ACP engines may use Brain broker tools only, so the session was stopped`;
    this.push("error", { error: { code: "POLICY_DENIED", detail: this.violation, retryable: false, correlationId: this.sessionId || this.id }, phase: "stream", retryClass: "never" });
    this.push("session.stopped", { reason: "error", terminationConfirmed: true });
    this.disposeSync();
  }

  private note(text: string): void {
    this.push("text", { text, channel: "diagnostic", provisional: true });
  }

  private push(kind: EngineEvent["kind"], payload: EngineEvent["payload"]): void {
    this.seq += 1;
    this.eventsBuffer.push({
      contractVersion: "brain.engine-event/v1", eventId: `acp-evt-${this.seq}`,
      sessionId: this.sessionId, attemptId: this.attemptId, sequence: this.seq,
      occurredAt: new Date().toISOString(), kind, payload,
    } as EngineEvent);
  }

  private request(method: string, params: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const proc = this.proc;
    if (!proc?.stdin) throw new Error("ACP agent not running");
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        proc.stdin!.write(`${payload}\n`);
      }),
      new Promise<Record<string, unknown>>((_, reject) => setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out`));
      }, timeoutMs)),
    ]);
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async probe() {
    try {
      this.ensureProc(process.cwd());
      const init = await this.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "brain-runner", version: "0.1.0" },
        clientCapabilities: ACP_CLIENT_CAPABILITIES,
      }, 20_000);
      const info = (init["agentInfo"] ?? {}) as { name?: string; version?: string };
      this.agentVersion = typeof info.version === "string" && info.version.length > 0 && info.version.length <= 64 ? info.version : undefined;
      const capabilities = (init["agentCapabilities"] ?? {}) as { loadSession?: boolean; sessionCapabilities?: { resume?: unknown; fork?: unknown } };
      this.negotiated = {
        loadSession: capabilities.loadSession === true,
        resume: capabilities.sessionCapabilities?.resume !== undefined && capabilities.sessionCapabilities.resume !== false,
        fork: capabilities.sessionCapabilities?.fork !== undefined && capabilities.sessionCapabilities.fork !== false,
      };
      // Only implemented and advertised features are offered; load/resume/fork are
      // recorded for negotiation but not offered until this adapter maps them.
      this.probed = true;
      return { id: this.id, ...(this.agentVersion ? { version: this.agentVersion } : {}), adapterDigest: adapterDigest(), features: ["sessions"] };
    } catch {
      return { id: this.id, adapterDigest: adapterDigest(), features: [] };
    }
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<{ sessionId: string }> {
    const cwd = process.env["BRAIN_ACP_CWD"] ?? process.cwd();
    this.ensureProc(cwd);
    if (!this.probed) await this.probe();
    if (signal.aborted) throw new Error("aborted");
    const created = await this.request("session/new", { cwd, mcpServers: [] }, 30_000);
    this.sessionId = String(created["sessionId"] ?? "");
    if (!this.sessionId) throw Object.assign(new Error("ACP session/new returned no sessionId"), { code: "UNSUPPORTED_CAPABILITY" });
    this.attemptId = spec.attemptId;
    this.allowedNames = new Set(this.bindings
      .filter((binding) => spec.allowedTools.some((tool) => tool.id === binding.release.id && tool.digest === binding.release.digest))
      .map((binding) => nativeToolName(binding.release.id)));
    return { sessionId: this.sessionId };
  }

  async prompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error("no ACP session");
    await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    }, 240_000);
  }

  async *events(_sessionId: string, after: number, _signal: AbortSignal): AsyncIterable<EngineEvent> {
    for (const ev of this.eventsBuffer) if (ev.sequence > after) yield ev;
  }

  async cancel(): Promise<{ terminationConfirmed: boolean }> {
    if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
    this.disposeSync();
    return { terminationConfirmed: true };
  }

  /**
   * The ACP session protocol this adapter speaks (prompt → single turn →
   * cancel) has no message-injection primitive, so steering genuinely cannot
   * apply — refused with the typed unsupported error. The probe does not
   * advertise "steer".
   */
  /** The session capabilities the agent advertised at initialize. */
  get sessionCapabilities(): Readonly<{ loadSession: boolean; resume: boolean; fork: boolean }> { return this.negotiated; }

  async steer(sessionId: string, _messageId: string, _message: string): Promise<void> {
    throw Object.assign(new Error(`ACP sessions cannot accept steering mid-prompt (session ${sessionId})`), { code: "UNSUPPORTED_CAPABILITY" });
  }

  async checkpoint(): Promise<never> {
    throw Object.assign(new Error("ACP checkpoint not exposed by agent"), { code: "UNSUPPORTED_CAPABILITY" });
  }

  private disposeSync(): void {
    try { this.proc?.kill("SIGTERM"); } catch { /* already gone */ }
    this.proc = null;
    this.sessionId = "";
  }

  async dispose(): Promise<void> {
    this.disposeSync();
  }
}
