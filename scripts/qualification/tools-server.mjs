#!/usr/bin/env node
// Minimal stdio MCP server for model qualification (Q01/Q02). The harness,
// not the model, owns these tools: every call is appended to QUAL_TOOL_LOG
// with its exact arguments and result, so oracles compare against what the
// tools really received and returned. No dependencies, newline-delimited JSON-RPC.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const LOG = process.env.QUAL_TOOL_LOG;
const record = (entry) => { if (LOG) appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

const TOOLS = [
  {
    name: "sum",
    description: "Add two integers and return their sum. Both arguments are required integers.",
    inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false },
  },
  {
    name: "lookup",
    description: "Look up the checksum registered for a nonce. Returns the checksum string.",
    inputSchema: { type: "object", properties: { nonce: { type: "string", minLength: 1 } }, required: ["nonce"], additionalProperties: false },
  },
];

function call(name, args) {
  if (name === "sum") {
    const keys = Object.keys(args ?? {}).sort().join(",");
    if (keys !== "a,b" || !Number.isInteger(args.a) || !Number.isInteger(args.b)) throw new Error("sum takes exactly two integers a and b");
    return String(args.a + args.b);
  }
  if (name === "lookup") {
    if (typeof args?.nonce !== "string" || !args.nonce || Object.keys(args).length !== 1) throw new Error("lookup takes exactly one string nonce");
    return createHash("sha256").update(`qualification:${args.nonce}`).digest("hex").slice(0, 24);
  }
  throw new Error(`unknown tool ${name}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "qualification-tools", version: "1.0.0" } } });
  } else if (method === "tools/list") {
    send({ id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    const name = params?.name; const args = params?.arguments ?? {};
    try {
      const result = call(name, args);
      record({ tool: name, arguments: args, result, ok: true });
      send({ id, result: { content: [{ type: "text", text: result }] } });
    } catch (error) {
      record({ tool: name, arguments: args, error: String(error.message), ok: false });
      send({ id, result: { content: [{ type: "text", text: String(error.message) }], isError: true } });
    }
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `method ${method} not supported` } });
  }
});
