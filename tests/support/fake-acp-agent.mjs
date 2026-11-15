// A stand-in ACP agent for tests of the runner's ACP adapter. It speaks line-delimited JSON-RPC on stdio, never runs anything, and writes
// everything it was told and everything it received to the file named by FAKE_ACP_LOG (one JSON object per line).
//
// The prompt text is a JSON array of steps it plays, in order, against the client:
//   { "request": { "method": "session/request_permission", "params": {...} } }  an agent request; the client's answer is logged
//   { "update": {...} }                                                         a session/update notification
//   { "text": "..." }                                                           an assistant message chunk
//   { "usage": {...} } / { "stopReason": "..." }                                what the prompt answer carries (default: no usage, end_turn)
//   { "wait": "cancel" }                                                        blocks until session/cancel, then answers stopReason "cancelled"
//   { "hang": true }                                                            never answers the prompt
//   { "exit": true }                                                            ends the process in the middle of the prompt
//   { "mcp": { "method", "params", "noAuth"? } }                                a call to the MCP server named in session/new (http or stdio relay); the answer is logged
// The prompt text is what follows the last "Task:" line (the adapter writes instructions, then "Task:", then the job's task); the whole text is logged.
// The ids of its own requests start at 1 on purpose: they collide with the ids of the client's requests.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const log = (entry) => appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

log({ event: "started", env: { config: process.env.OPENCODE_CONFIG_CONTENT ?? null, projectConfigOff: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null, claudeCodeOff: process.env.OPENCODE_DISABLE_CLAUDE_CODE ?? null } });

let nextId = 1;
const waiting = new Map();
let prompting = null;
let mcpServers = [];
let cancelled = () => {};
const cancelSignal = new Promise((resolve) => { cancelled = resolve; });
let stdio = null;
let stdioId = 0;
const stdioWaiting = new Map();

// The agent as an MCP client: a plain JSON-RPC call to the server it was told about, over HTTP or through the stdio relay it was told to start.
async function mcpCall(method, params, noAuth) {
  const server = mcpServers[0];
  if (!server) return { error: "no MCP server was offered" };
  if (server.type === "http") {
    const headers = { "content-type": "application/json", ...(noAuth ? {} : Object.fromEntries(server.headers.map((h) => [h.name, h.value]))) };
    const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  if (!stdio) {
    stdio = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) }, stdio: ["pipe", "pipe", "ignore"] });
    createInterface({ input: stdio.stdout }).on("line", (line) => { const message = JSON.parse(line); stdioWaiting.get(message.id)?.(message); stdioWaiting.delete(message.id); });
  }
  const id = ++stdioId;
  const answer = new Promise((resolve) => stdioWaiting.set(id, resolve));
  stdio.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return { body: await answer };
}

async function play(steps, answer) {
  for (const step of steps) {
    if (step.usage) answer.usage = step.usage;
    else if (step.stopReason) answer.stopReason = step.stopReason;
    else if (step.hang) await new Promise(() => {});
    else if (step.exit) process.exit(1);
    else if (step.wait === "cancel") { await cancelSignal; answer.stopReason = "cancelled"; return; }
    else if (step.mcp) log({ event: "mcp", method: step.mcp.method, params: step.mcp.params, response: await mcpCall(step.mcp.method, step.mcp.params, step.mcp.noAuth) });
    else if (step.text !== undefined) send({ method: "session/update", params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } } } });
    else if (step.update) send({ method: "session/update", params: { sessionId: "fake-session", update: step.update } });
    else if (step.request) {
      const id = nextId++;
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      send({ id, method: step.request.method, params: { sessionId: "fake-session", ...step.request.params } });
      log({ event: "answer", method: step.request.method, params: step.request.params, response: await answer });
    }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    // The client's answer to one of this agent's requests.
    waiting.get(message.id)?.({ result: message.result ?? null, error: message.error ?? null });
    waiting.delete(message.id);
    return;
  }
  if (message.method === "initialize") {
    log({ event: "initialize", clientCapabilities: message.params.clientCapabilities });
    send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "fake-acp", version: "1.0.0" }, agentCapabilities: process.env.FAKE_ACP_MCP_HTTP ? { mcpCapabilities: { http: true } } : {} } });
  } else if (message.method === "session/new") {
    mcpServers = message.params.mcpServers;
    log({ event: "session/new", mcpServers: message.params.mcpServers });
    send({ id: message.id, result: { sessionId: "fake-session" } });
  } else if (message.method === "session/prompt") {
    const text = message.params.prompt[0].text;
    log({ event: "prompt", text });
    const marker = text.lastIndexOf("Task:\n");
    const answer = { stopReason: "end_turn" };
    prompting = play(JSON.parse(marker >= 0 ? text.slice(marker + 6) : text), answer).then(() => send({ id: message.id, result: answer }));
  } else if (message.method === "session/cancel") {
    log({ event: "cancel" });
    cancelled();
  }
});
process.on("SIGTERM", () => { stdio?.kill(); log({ event: "terminated", whilePrompting: prompting !== null }); process.exit(0); });
