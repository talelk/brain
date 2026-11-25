// A stand-in for an ACP agent (OpenCode), for the runner's tests: line-delimited JSON-RPC on stdio, driven by the script file named as its
// argument. Each step is one of
//   {"own": {"name", "kind", "input", "output", "ask": bool}}   one of the agent's own tools; with "ask" it requests permission first
//   {"mcp": {"tool", "input"}}                                  a workspace tool, called on the MCP server of session/new through "execute"
//   {"say": "text"}                                             a message
//   {"env": "NAME"}                                             a message holding that variable of the agent's environment
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const steps = JSON.parse(readFileSync(process.argv[2], "utf8"));
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const waiting = new Map();
let nextId = 100;
let sessionId = "";
let mcp;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const update = (body) => send({ method: "session/update", params: { sessionId, update: body } });
const bridge = async (method, params) => (await (await fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(mcp.headers.map((header) => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) })).json()).result;

async function prompt() {
  let call = 0;
  for (const step of steps) {
    const toolCallId = `call_${++call}`;
    if (step.env) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env[step.env] ?? "" } });
    if (step.say) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
    if (step.own) {
      const { name, kind, input, output } = step.own;
      update({ sessionUpdate: "tool_call", toolCallId, name, title: name, kind, status: "pending", rawInput: {} });
      const allowed = !step.own.ask || (await ask("session/request_permission", { sessionId, toolCall: { toolCallId, title: name, kind, rawInput: input }, options: [{ optionId: "once", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] })).outcome?.optionId === "once";
      update({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", kind, title: name, rawInput: input });
      update({ sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? output : "permission refused" } }] });
    }
    if (step.mcp) {
      update({ sessionUpdate: "tool_call", toolCallId, name: "execute", title: "execute", kind: "other", status: "in_progress", rawInput: { code: `tools.brain.${step.mcp.tool}(...)` } });
      const result = await bridge("tools/call", { name: step.mcp.tool, arguments: step.mcp.input });
      update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: result.content[0].text } }] });
    }
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) { waiting.get(message.id)?.(message.result ?? {}); waiting.delete(message.id); return; }
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, agentInfo: { name: "Fake", version: "9.9.9" } } });
  if (message.method === "session/new") {
    sessionId = "session-1";
    mcp = message.params.mcpServers[0];
    if (mcp) { await bridge("initialize", {}); await bridge("tools/list", {}); }
    send({ id: message.id, result: { sessionId } });
  }
  if (message.method === "session/prompt") { await prompt(); send({ id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 300, outputTokens: 60 } } }); }
  if (message.method === "session/cancel") process.exit(0);
});
