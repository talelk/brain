// A stand-in ACP agent for tests of the runner's ACP adapter. It speaks line-delimited JSON-RPC on stdio, never runs anything, and writes
// everything it was told and everything it received to the file named by FAKE_ACP_LOG (one JSON object per line).
//
// The prompt text is a JSON array of steps it plays, in order, against the client:
//   { "request": { "method": "session/request_permission", "params": {...} } }  an agent request; the client's answer is logged
//   { "update": {...} }                                                         a session/update notification
//   { "text": "..." }                                                           an assistant message chunk
// The ids of its own requests start at 1 on purpose: they collide with the ids of the client's requests.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

log({ event: "started", env: { config: process.env.OPENCODE_CONFIG_CONTENT ?? null, projectConfigOff: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null, claudeCodeOff: process.env.OPENCODE_DISABLE_CLAUDE_CODE ?? null } });

let nextId = 1;
const waiting = new Map();
let prompting = null;

async function play(steps) {
  for (const step of steps) {
    if (step.text !== undefined) send({ method: "session/update", params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } } } });
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
    send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "fake-acp", version: "1.0.0" }, agentCapabilities: {} } });
  } else if (message.method === "session/new") {
    log({ event: "session/new", mcpServers: message.params.mcpServers });
    send({ id: message.id, result: { sessionId: "fake-session" } });
  } else if (message.method === "session/prompt") {
    prompting = play(JSON.parse(message.params.prompt[0].text)).then(() => send({ id: message.id, result: { stopReason: "end_turn" } }));
  } else if (message.method === "session/cancel") {
    log({ event: "cancel" });
  }
});
process.on("SIGTERM", () => { log({ event: "terminated", whilePrompting: prompting !== null }); process.exit(0); });
