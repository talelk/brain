import { spawn, type ChildProcess } from "node:child_process";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";

// ACP adapter over a stdio Agent Client Protocol agent (default:
// `opencode acp`). Speaks line-delimited JSON-RPC 2.0: initialize,
// session/new, session/prompt, session/cancel. The agent runs with no
// client filesystem/terminal capabilities; all tool effects stay inside the
// agent's own sandbox boundary managed by the launcher.
interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

export class AcpEngine implements EngineAdapter {
  readonly id = "acp";
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId = "";
  private attemptId = "";
  private seq = 0;
  private readonly eventsBuffer: EngineEvent[] = [];
  private agentVersion = "unknown";

  private command(): { file: string; args: string[] } {
    const raw = process.env["BRAIN_ACP_COMMAND"] ?? "opencode acp";
    const [file, ...args] = raw.split(/\s+/);
    return { file: file ?? "opencode", args };
  }

  private ensureProc(cwd: string): ChildProcess {
    if (this.proc) return this.proc;
    const { file, args } = this.command();
    const proc = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
      for (const p of this.pending.values()) p.reject(new Error("ACP agent exited"));
      this.pending.clear();
      this.proc = null;
    });
    this.proc = proc;
    return proc;
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof msg["id"] === "number") {
      const p = this.pending.get(msg["id"]);
      if (!p) return;
      this.pending.delete(msg["id"]);
      if (msg["error"]) p.reject(new Error(JSON.stringify(msg["error"])));
      else p.resolve((msg["result"] ?? {}) as Record<string, unknown>);
      return;
    }
    if (msg["method"] === "session/update") {
      const params = msg["params"] as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } | undefined;
      const update = params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        this.seq += 1;
        this.eventsBuffer.push({
          contractVersion: "brain.engine-event/v1", eventId: `acp-evt-${this.seq}`,
          sessionId: this.sessionId, attemptId: this.attemptId, sequence: this.seq,
          occurredAt: new Date().toISOString(), kind: "text",
          payload: { text: update.content.text ?? "", channel: "assistant", provisional: true },
        });
      }
    }
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
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, 20_000);
      const info = (init["agentInfo"] ?? {}) as { name?: string; version?: string };
      this.agentVersion = info.version ?? "acp-1";
      return { id: "acp", version: this.agentVersion, adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions"] };
    } catch {
      return { id: "acp", version: "unavailable", adapterDigest: `sha256:${"0".repeat(64)}`, features: [] };
    }
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<{ sessionId: string }> {
    const cwd = process.env["BRAIN_ACP_CWD"] ?? process.cwd();
    this.ensureProc(cwd);
    if (this.agentVersion === "unknown") await this.probe();
    if (signal.aborted) throw new Error("aborted");
    const created = await this.request("session/new", { cwd, mcpServers: [] }, 30_000);
    this.sessionId = String(created["sessionId"] ?? "");
    if (!this.sessionId) throw Object.assign(new Error("ACP session/new returned no sessionId"), { code: "UNSUPPORTED_CAPABILITY" });
    this.attemptId = spec.attemptId;
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
