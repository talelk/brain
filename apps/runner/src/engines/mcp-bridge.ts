import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonValue } from "@brain/contracts";
import type { EngineTool } from "./port";
import { engineToolDescription } from "./tool-calls";

/**
 * The MCP endpoint an ACP agent reaches workspace tools through. It lives beside the agent (in the engine's process), listens on loopback
 * only, and is authenticated by a token made for one session. It serves exactly the tools the agent may use and nothing else; every call is
 * handed to `call`, which leads to the runner's tool path (validation, approval, sandbox), so the bridge is never a way around it.
 * Streamable HTTP in its plain form: one JSON-RPC message per POST, answered as JSON.
 */
export interface BrokerBridgeTool { readonly name: string; readonly tool: EngineTool }

const MAX_BODY_BYTES = 1_000_000;
const PROTOCOL_VERSION = "2025-03-26";

export class BrokerBridge {
  readonly token = randomBytes(32).toString("hex");
  private server: Server | undefined;
  private markListed: () => void = () => undefined;
  /** Resolves once the agent has read the tool list. */
  readonly listed = new Promise<void>((resolve) => { this.markListed = resolve; });
  private readonly tools: ReadonlyMap<string, EngineTool>;

  constructor(tools: readonly BrokerBridgeTool[], private readonly call: (name: string, input: JsonValue) => Promise<string>) {
    this.tools = new Map(tools.map((entry) => [entry.name, entry.tool]));
  }

  /** The address the agent connects to, once listening. */
  async listen(): Promise<{ url: string }> {
    const server = createServer((request, response) => { void this.handle(request, response); });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
  }

  close(): void {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }

  private authorized(request: IncomingMessage): boolean {
    const given = Buffer.from(String(request.headers["authorization"] ?? ""));
    const expected = Buffer.from(`Bearer ${this.token}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(body === undefined ? undefined : JSON.stringify(body)); };
    if (!this.authorized(request)) return send(401, { error: "unauthorized" });
    if (request.method !== "POST") return send(405, { error: "POST only" });
    let raw = "";
    let size = 0;
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > MAX_BODY_BYTES) return send(413, { error: "too large" }); raw += String(chunk); }
    let message: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try { message = JSON.parse(raw) as typeof message; } catch { return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    // A notification has no id and gets no answer.
    if (message.id === undefined || message.id === null) return send(202);
    const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id: message.id, result });
    const fail = (code: number, text: string) => send(200, { jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    switch (message.method) {
      case "initialize": return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "brain", version: "1" } });
      case "ping": return reply({});
      case "tools/list": this.markListed(); return reply({ tools: [...this.tools].map(([name, tool]) => ({ name, description: engineToolDescription(tool), inputSchema: tool.inputSchema })) });
      case "tools/call": {
        const name = message.params?.["name"];
        // A tool the agent may not use is refused here, before anything reaches the runner.
        if (typeof name !== "string" || !this.tools.has(name)) return fail(-32602, `unknown tool: ${typeof name === "string" ? name : "unnamed"}`);
        const input = (message.params?.["arguments"] ?? {}) as JsonValue;
        try { return reply({ content: [{ type: "text", text: await this.call(name, input) }] }); }
        catch (error) { return reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "tool call failed" }] }); }
      }
      default: return fail(-32601, `${message.method ?? "unnamed"} is not supported`);
    }
  }
}
