import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { sha256Digest } from "../../packages/contracts/src/index.ts";
import { startEgressProxy, writeEgressGrant, type EgressProxy } from "../../apps/launcher/src/egress-proxy";
import { buildMcpToolFiles, mcpClientScript, type ListedTool } from "../../apps/cli/src/mcp";
import { fixtureStarter } from "./starter";

const tmp = process.env["TMPDIR"] ?? "/tmp";

export interface FakeMcp {
  readonly url: string;
  /** The egress entry of the server (host:port): what a Tool document declares and a workspace allows. */
  readonly host: string;
  /** What the server was asked to run, in order (a `tools/call` only). */
  readonly calls: Array<{ name: string; arguments: Record<string, unknown>; authorization: string | undefined }>;
  tools: ListedTool[];
  /** Every tool the server lists answers with this; set per test. */
  answer: (name: string, args: Record<string, unknown>) => { text: string; isError?: boolean };
  /** Where the /redirect path sends a caller. */
  redirectTo: string;
  close(): Promise<void>;
}

/** A local MCP server over streamable HTTP (JSON answers): initialize, tools/list and tools/call. No real third-party server is involved. */
export async function fakeMcpServer(): Promise<FakeMcp> {
  const calls: FakeMcp["calls"] = [];
  const state: { tools: ListedTool[]; answer: FakeMcp["answer"]; redirectTo: string } = {
    redirectTo: "http://127.0.0.1:1/",
    tools: [
      { name: "search", description: "Search the notes", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
      { name: "create_note", description: "Create a note", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } },
    ],
    answer: (name, args) => ({ text: `${name} ${JSON.stringify(args)}` }),
  };
  const body = (req: IncomingMessage): Promise<string> => new Promise((resolve) => { const chunks: Buffer[] = []; req.on("data", (c: Buffer) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); });
  const server: Server = createServer(async (req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: state.redirectTo }); res.end(); return; }
    const message = JSON.parse(await body(req)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const reply = (result: unknown): void => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
    if (message.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    if (message.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: state.tools });
    if (message.method === "tools/call") {
      const name = message.params?.name ?? "";
      const args = message.params?.arguments ?? {};
      calls.push({ name, arguments: args, authorization: req.headers["authorization"] });
      const answer = state.answer(name, args);
      return reply({ content: [{ type: "text", text: answer.text }], isError: answer.isError === true });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`, host: `127.0.0.1:${port}`, calls,
    get tools() { return state.tools; }, set tools(value) { state.tools = value; },
    get redirectTo() { return state.redirectTo; }, set redirectTo(value) { state.redirectTo = value; },
    get answer() { return state.answer; }, set answer(value) { state.answer = value; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Runs a script without blocking this process: the fake servers live in it and must keep answering. */
export function runScript(script: string, input: string, env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [script], { env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr, timedOut }); });
    child.stdin.end(input);
  });
}

/** The tool list and digest of a server, read by the pinned client's own list mode (the one implementation of the digest). */
export async function listTools(url: string, headers: Record<string, string> = {}): Promise<{ tools: ListedTool[]; toolListDigest: string }> {
  const dir = mkdtempSync(join(tmp, "brain-mcp-client-"));
  try {
    const script = join(dir, "run.sh");
    writeFileSync(script, mcpClientScript(), { mode: 0o755 });
    const run = await runScript(script, JSON.stringify({ arguments: {}, mcp: { url, tool: "", toolListDigest: "", headers, mode: "list" } }), { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });
    if (run.exitCode !== 0) throw new Error(`could not list tools: ${run.stdout}${run.stderr}`);
    return JSON.parse(run.stdout) as { tools: ListedTool[]; toolListDigest: string };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The fixture starter with the given external MCP tools registered as governed Tool documents and given to the SRE operator agent. */
export function mcpStarter(server: FakeMcp, classes: Record<string, string>, extra: { headers?: Record<string, { secretRef: string; prefix?: string }>; maxOutputBytes?: number; listing: Awaited<ReturnType<typeof listTools>> }) {
  const bundle = fixtureStarter();
  const { toolIds, files } = buildMcpToolFiles({ serverId: "fake", url: server.url, listing: extra.listing, classes, ...(extra.headers ? { headers: extra.headers } : {}), ...(extra.maxOutputBytes ? { maxOutputBytes: extra.maxOutputBytes } : {}) });
  const digests: Record<string, string> = {};
  for (const file of files) {
    if (file.path.startsWith("config/")) { bundle.documents.push({ path: file.path, text: file.text }); digests[file.path.slice("config/".length, -".yaml".length)] = sha256Digest(new TextEncoder().encode(file.text)); }
    else if (file.path.startsWith("schemas/")) bundle.schemas.push({ path: file.path, text: file.text });
    else bundle.scripts.push({ toolId: file.path.split("/")[1]!, entrypoint: "run.sh", bytesBase64: Buffer.from(file.text).toString("base64") });
  }
  bundle.documents.sort((a, b) => a.path.localeCompare(b.path));
  const agentDoc = bundle.documents.find((doc) => doc.path.endsWith("sre-operator-agent.yaml"))!;
  const prior = sha256Digest(new TextEncoder().encode(agentDoc.text));
  const agent = JSON.parse(agentDoc.text);
  for (const id of toolIds) agent.spec.tools.push({ id, digest: digests[id] });
  agentDoc.text = JSON.stringify(agent, null, 2) + "\n";
  const next = sha256Digest(new TextEncoder().encode(agentDoc.text));
  for (const doc of bundle.documents) doc.text = doc.text.replaceAll(prior, next);
  return { bundle, toolIds, digests };
}

/**
 * The launcher's network, as a double: a real egress proxy with a grant per sandbox, and a script runner that sets the proxy in the
 * environment exactly as the launcher does, but WITHOUT `no_proxy` (the real launcher's loopback exemption would let a 127.0.0.1
 * fake server bypass the proxy and make every egress assertion vacuous).
 */
export async function egressDouble(): Promise<{ proxy: EgressProxy; log: string[]; run: (request: Record<string, unknown>, script: string, input: string) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmp, "brain-mcp-grants-"));
  mkdirSync(dir, { recursive: true });
  const log: string[] = [];
  const proxy = await startEgressProxy({ port: 0, grantsDir: dir, bindHost: "127.0.0.1", log: (line) => log.push(line) });
  return {
    proxy, log,
    run: async (request, script, input) => {
      const hosts = Array.isArray(request["egressHosts"]) ? request["egressHosts"] as string[] : [];
      const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" };
      if (request["network"] === "internal" && hosts.length > 0) {
        const grant = writeEgressGrant(dir, hosts);
        const url = `http://${grant.id}:${grant.token}@127.0.0.1:${proxy.port}`;
        Object.assign(env, { http_proxy: url, https_proxy: url, HTTP_PROXY: url, HTTPS_PROXY: url });
      }
      return runScript(script, input, env);
    },
    close: async () => { await proxy.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

