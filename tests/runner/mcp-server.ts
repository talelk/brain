/**
 * An external MCP server for a test: the official SDK's server over Streamable HTTP on a port of this machine, with sessions, behind a
 * bearer token. It is what "somebody else's MCP server" is for Brain's client and for `pnpm brain mcp-tools`.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const TICKET_INPUT = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { title: { type: "string", minLength: 3 }, labels: { type: "array", items: { type: "string" } } }, required: ["title"], additionalProperties: false } as const;
export const TICKET_OUTPUT = { type: "object", properties: { id: { type: "integer" }, title: { type: "string" } }, required: ["id", "title"] } as const;

export interface TestMcpServer { readonly url: string; readonly host: string; readonly calls: Array<{ name: string; arguments: unknown }>; close(): Promise<void> }

export async function startMcpServer(token: string): Promise<TestMcpServer> {
  const calls: TestMcpServer["calls"] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const build = (): Server => {
    const server = new Server({ name: "tickets", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "create_ticket", description: "Creates a ticket.", inputSchema: TICKET_INPUT, outputSchema: TICKET_OUTPUT, annotations: { readOnlyHint: true } },
        { name: "search.tickets", description: "Finds tickets.", inputSchema: { type: "object" as const, properties: { query: { type: "string" } } } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push({ name: request.params.name, arguments: request.params.arguments });
      if (request.params.name === "search.tickets") return { content: [{ type: "text" as const, text: "two tickets" }, { type: "text" as const, text: `asked: ${String(request.params.arguments?.["query"])}` }] };
      const title = String(request.params.arguments?.["title"]);
      if (title === "broken") return { content: [{ type: "text" as const, text: "the tracker is closed" }], isError: true };
      return { content: [{ type: "text" as const, text: "made" }], structuredContent: title === "odd" ? { id: "one", title } : { id: 7, title } };
    });
    return server;
  };
  const http = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end("no token"); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : undefined;
      const id = request.headers["mcp-session-id"] as string | undefined;
      let transport = id ? sessions.get(id) : undefined;
      if (!transport) {
        if (!isInitializeRequest(body)) { response.writeHead(400).end("no session"); return; }
        const made = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (session) => void sessions.set(session, made) });
        await build().connect(made as Parameters<Server["connect"]>[0]);
        transport = made;
      }
      await transport.handleRequest(request, response, body);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { url: `http://${host}/mcp`, host, calls, close: () => new Promise((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }) };
}
