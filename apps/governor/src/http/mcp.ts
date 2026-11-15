import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMANDS, QUERIES } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";

/**
 * Brain over the Model Context Protocol (streamable HTTP, JSON responses, stateless): `initialize`, `ping`, `tools/list` and `tools/call`.
 * Every registered command and query is one tool, generated from the contract registry and brain.schema.json, and acts for the signed-in
 * principal through the same funnel as /v1, so the authorization matrix (and a session credential's own allowlist) decides each call.
 * Approval decisions stay in the app: nothing here can take one.
 */
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const COMMAND_PREFIX = "command.";
const QUERY_PREFIX = "query.";

type Schema = Record<string, unknown>;
const defs = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/contracts/src/brain.schema.json", import.meta.url)), "utf8")) as { $defs: Record<string, Schema> }).$defs;

/** Approvals are decided in the app: only a request for one is a tool. */
export const isRefusedOverMcp = (type: string): boolean => type.startsWith("approval.") && type !== "approval.request";

function refsOf(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) { for (const item of node) refsOf(item, found); return; }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) found.add(value.slice("#/$defs/".length));
    else refsOf(value, found);
  }
}

/** A self-contained schema: the definitions the body reaches, copied beside it so `#/$defs/...` still resolves. */
function standalone(body: Schema): Schema {
  const out: Record<string, Schema> = {};
  const stack: string[] = [];
  const first = new Set<string>();
  refsOf(body, first);
  stack.push(...first);
  while (stack.length) {
    const next = stack.pop() as string;
    if (out[next] || !defs[next]) continue;
    out[next] = defs[next] as Schema;
    const inner = new Set<string>();
    refsOf(defs[next], inner);
    stack.push(...inner);
  }
  return { ...body, ...(Object.keys(out).length ? { $defs: out } : {}) };
}

const variantOf = (union: unknown, field: string, type: string): Schema | undefined =>
  ((union as { oneOf?: Schema[] }).oneOf ?? []).find((v) => ((v["properties"] as Schema | undefined)?.[field] as { const?: string } | undefined)?.const === type);

function commandSchema(type: string): Schema {
  const variant = defs[COMMANDS.get(type)?.schema ?? ""];
  const props = { ...((variant?.["properties"] as Schema | undefined) ?? {}) };
  for (const field of ["contractVersion", "commandType"]) delete props[field];
  props["commandId"] = { type: "string", minLength: 1, maxLength: 128, description: "Optional; derived from idempotencyKey when absent, so a retry with the same key is the same command." };
  const required = ((variant?.["required"] as string[] | undefined) ?? []).filter((f) => f !== "contractVersion" && f !== "commandType" && f !== "commandId");
  return standalone({ type: "object", properties: props, required, additionalProperties: false });
}

function querySchema(type: string): Schema {
  const source = variantOf(defs["QueryRequest"], "queryType", type) ?? (defs["ProductQuery"] as Schema);
  const props = { ...((source["properties"] as Schema | undefined) ?? {}) };
  delete props["queryType"];
  const required = ((source["required"] as string[] | undefined) ?? []).filter((f) => f !== "queryType");
  return standalone({ type: "object", properties: props, required, additionalProperties: false });
}

export interface McpTool { readonly name: string; readonly description: string; readonly inputSchema: Schema; readonly annotations: { readonly readOnlyHint: boolean } }

let catalog: McpTool[] | undefined;
export function mcpTools(): McpTool[] {
  catalog ??= [
    ...[...COMMANDS.values()].filter((c) => !isRefusedOverMcp(c.type)).map((c): McpTool => ({
      name: COMMAND_PREFIX + c.type,
      description: `Brain command ${c.type} (scope ${c.scope}, ${c.authority}). Needs an idempotencyKey; repeating it returns the first receipt.`,
      inputSchema: commandSchema(c.type), annotations: { readOnlyHint: false },
    })),
    ...[...QUERIES].map((q): McpTool => ({
      name: QUERY_PREFIX + q, description: `Brain read ${q}.`, inputSchema: querySchema(q), annotations: { readOnlyHint: true },
    })),
  ];
  return catalog;
}

export interface McpHost {
  /** Runs a command as the signed-in principal; a refusal throws. */
  command(workspaceId: string | undefined, command: Record<string, unknown>): Promise<unknown>;
  query(workspaceId: string | undefined, query: Record<string, unknown>): Promise<unknown>;
  /** The error envelope a thrown refusal is reported as. */
  errorEnvelope(error: unknown): unknown;
}

export interface RpcReply { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } }

const rpcError = (id: unknown, code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One JSON-RPC message; a notification (no id) has no reply. */
export async function handleMcpMessage(message: unknown, host: McpHost): Promise<RpcReply | undefined> {
  if (!isObject(message) || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") return rpcError(isObject(message) ? message["id"] : null, -32600, "invalid JSON-RPC request");
  if (!("id" in message)) return undefined;
  const { id, method, params } = message as { id: unknown; method: string; params?: unknown };
  switch (method) {
    case "initialize": {
      const asked = isObject(params) && typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "brain", version: "1" }, instructions: "Brain commands are tools named command.<type>; reads are query.<type>. Every command needs an idempotencyKey. Approvals are decided in the Brain app." } };
    }
    case "ping": return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": return { jsonrpc: "2.0", id, result: { tools: mcpTools() } };
    case "tools/call": {
      if (!isObject(params) || typeof params["name"] !== "string") return rpcError(id, -32602, "params.name is required");
      const name = params["name"];
      const args = params["arguments"] ?? {};
      if (!isObject(args)) return rpcError(id, -32602, "params.arguments must be an object");
      const refused = name.startsWith(COMMAND_PREFIX) && COMMANDS.has(name.slice(COMMAND_PREFIX.length)) && isRefusedOverMcp(name.slice(COMMAND_PREFIX.length));
      if (!refused && !mcpTools().some((t) => t.name === name)) return rpcError(id, -32602, `unknown tool ${name}`);
      const workspaceId = typeof args["workspaceId"] === "string" ? args["workspaceId"] : undefined;
      try {
        if (refused) throw new BrainDomainError("FORBIDDEN", "approval decisions are not available over MCP");
        let result: unknown;
        if (name.startsWith(COMMAND_PREFIX)) {
          const commandType = name.slice(COMMAND_PREFIX.length);
          const key = typeof args["idempotencyKey"] === "string" ? args["idempotencyKey"] : "";
          const commandId = typeof args["commandId"] === "string" ? args["commandId"] : `mcp-${createHash("sha256").update(`${commandType}\0${workspaceId ?? ""}\0${key}`).digest("hex").slice(0, 40)}`;
          result = await host.command(workspaceId, { ...args, contractVersion: "brain.command/v1", commandType, commandId });
        } else {
          result = await host.query(workspaceId, { ...args, queryType: name.slice(QUERY_PREFIX.length) });
        }
        return { jsonrpc: "2.0", id, result: toolResult(result, false) };
      } catch (error) {
        return { jsonrpc: "2.0", id, result: toolResult(host.errorEnvelope(error), true) };
      }
    }
    default: return rpcError(id, -32601, `method not found: ${method}`);
  }
}

function toolResult(value: unknown, isError: boolean): { content: { type: "text"; text: string }[]; structuredContent: JsonValue; isError: boolean } {
  const structured = (isObject(value) ? value : { value }) as JsonValue;
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: structured, isError };
}
