import type { JsonValue } from "@brain/contracts";
import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { EngineEventStream } from "./event-stream";
import { engineFailureDetail } from "./failure-detail";
import { overCostCap } from "./limits";
import { installedVersion } from "./package-version";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, NativeToolNames } from "./port";
import { boundedToolText, engineToolDescription, ToolRequests } from "./tool-calls";

const PACKAGE = "@anthropic-ai/claude-agent-sdk";
const MCP_PREFIX = "mcp__brain__";

/** Claude Code's own tools at each level: reading and searching, then editing and the shell. */
export const CLAUDE_NATIVE: NativeToolNames = { none: [], read: ["Read", "Glob", "Grep"], all: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] };

function schemaToZod(schema: Record<string, JsonValue>): ZodTypeAny {
  if (Array.isArray(schema["enum"]) && schema["enum"].every((value) => typeof value === "string") && schema["enum"].length) return z.enum(schema["enum"] as [string, ...string[]]);
  if (schema["type"] === "string") return z.string();
  if (schema["type"] === "number") return z.number();
  if (schema["type"] === "integer") return z.number().int();
  if (schema["type"] === "boolean") return z.boolean();
  if (schema["type"] === "array") return z.array(schemaToZod((schema["items"] as Record<string, JsonValue> | undefined) ?? {}));
  if (schema["type"] === "object") return z.object(shapeOf(schema)).passthrough();
  return z.unknown();
}

/** The top-level properties of a tool's input schema as the SDK's tool definition takes them. */
function shapeOf(schema: Record<string, JsonValue>): Record<string, ZodTypeAny> {
  const properties = (schema["properties"] as Record<string, Record<string, JsonValue>> | undefined) ?? {};
  const required = new Set((schema["required"] as string[] | undefined) ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) shape[key] = required.has(key) ? schemaToZod(value) : schemaToZod(value).optional();
  return shape;
}

type ContentBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: string | Array<{ type: string; text?: string }> };
type SdkMessage = {
  type: string; subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number;
  message?: { content?: ContentBlock[] | string };
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

/**
 * The address the SDK is given. It appends `/v1/messages` itself, and the gateway serves the Anthropic form at `<gateway>/messages` with
 * `<gateway>` ending in `/v1`, so that last `/v1` is left to the SDK.
 */
const anthropicBase = (gatewayUrl: string): string => gatewayUrl.replace(/\/v1\/?$/u, "");

const blockText = (content: ContentBlock["content"]): string => (typeof content === "string" ? content : (content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join(""));

/**
 * Claude (the Claude Agent SDK). It calls the Governor's gateway as its Anthropic endpoint (`<gateway>/messages`) with the attempt's token. Its own tools are
 * the `tools` option at the agent's native level, with the working copy as working directory; workspace tools are an in-process MCP
 * server whose calls go to the runner. Nothing else is allowed: no settings files, no other built-in tool.
 */
export class ClaudeEngine implements EngineAdapter {
  readonly id = "claude";
  private abort: AbortController | null = null;
  private stream = new EngineEventStream();
  private query: { close(): void } | undefined;
  private requests: ToolRequests | undefined;

  async probe() {
    let ready = false;
    try { await import(PACKAGE); ready = true; } catch { ready = false; }
    const version = installedVersion(PACKAGE);
    return { id: this.id, ...(version ? { version } : {}), ready };
  }

  private async complete(spec: EngineSessionSpec, stream: EngineEventStream, abort: AbortController): Promise<void> {
    const push = (event: EngineEvent): void => stream.push(event);
    let turns = 0;
    let output = "";
    try {
      const { query, tool, createSdkMcpServer } = (await import(PACKAGE)) as typeof import("@anthropic-ai/claude-agent-sdk");
      const requests = new ToolRequests(spec.tools, push, { ...(spec.limits.maxTurns > 0 ? { maxCalls: spec.limits.maxTurns } : {}) });
      this.requests = requests;
      const tools = requests.entries().map(([name, entry]) => tool(name, engineToolDescription(entry), shapeOf(entry.inputSchema as Record<string, JsonValue>), async (args) => ({ content: [{ type: "text" as const, text: await requests.execute(name, args as JsonValue) }] })));
      const mcpServer = tools.length ? createSdkMcpServer({ name: "brain", version: "1", tools }) : undefined;
      const native = CLAUDE_NATIVE[spec.native];
      const calls = new Set<string>();
      const execution = query({
        prompt: spec.task,
        options: {
          model: spec.model.name, cwd: spec.workDir ?? spec.stateDir, ...(spec.limits.maxTurns > 0 ? { maxTurns: spec.limits.maxTurns } : {}), systemPrompt: spec.instructions,
          // `tools` is the whole set of built-in tools the model is offered; `allowedTools` lets exactly those and the workspace tools run, and
          // `dontAsk` refuses anything else instead of asking a person who is not there.
          tools: [...native], allowedTools: [...native, ...requests.names().map((name) => `${MCP_PREFIX}${name}`)], settingSources: [], permissionMode: "dontAsk",
          ...(mcpServer ? { mcpServers: { brain: mcpServer } } : {}),
          ...(spec.limits.maxMicroUsd > 0 ? { maxBudgetUsd: spec.limits.maxMicroUsd / 1_000_000 } : {}),
          // The SDK process gets this environment and no other: the gateway and the attempt's token, never a key of the runner's.
          env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: spec.stateDir, ANTHROPIC_BASE_URL: anthropicBase(spec.model.baseUrl), ANTHROPIC_API_KEY: spec.model.token, ANTHROPIC_AUTH_TOKEN: spec.model.token,
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.limits.maxTokens > 0 ? Math.min(spec.limits.maxTokens, 32_000) : 32_000), DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
            ...Object.fromEntries(["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"].flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : []))) },
          abortController: abort,
        } as never,
      });
      this.query = execution;
      let completed = false;
      let resultText = "";
      for await (const message of execution) {
        const m = message as unknown as SdkMessage;
        const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
        if (m.type === "assistant") {
          turns += 1;
          const callsTool = blocks.some((block) => block.type === "tool_use");
          for (const block of blocks) {
            // What the model says before a tool call is narration; the answer is what it writes in a message that calls none.
            if (block.type === "text" && block.text) { if (!callsTool) output += block.text; push({ kind: "text", channel: callsTool ? "diagnostic" : "assistant", text: block.text }); }
            if (block.type === "tool_use" && block.id && block.name && !block.name.startsWith(MCP_PREFIX)) { calls.add(block.id); push({ kind: "native.call", callId: block.id, name: block.name, input: (block.input ?? {}) as JsonValue }); }
          }
        }
        if (m.type === "user") {
          for (const block of blocks) if (block.type === "tool_result" && block.tool_use_id && calls.delete(block.tool_use_id)) push({ kind: "native.result", callId: block.tool_use_id, ok: block.is_error !== true, output: boundedToolText(blockText(block.content)) });
        }
        if (m.type === "result") {
          const inputTokens = (m.usage?.input_tokens ?? 0) + (m.usage?.cache_creation_input_tokens ?? 0), outputTokens = m.usage?.output_tokens ?? 0, cachedInputTokens = m.usage?.cache_read_input_tokens ?? 0;
          const microUsd = Math.ceil((m.total_cost_usd ?? 0) * 1_000_000);
          push({ kind: "usage", inputTokens, outputTokens, cachedInputTokens, microUsd, turns });
          if (m.subtype === "error_max_turns" || m.subtype === "error_max_budget_usd") { push({ kind: "stopped", reason: "limit", detail: `Claude stopped at the agent's limit (${m.subtype})` }); return; }
          if (m.subtype !== "success" || m.is_error) throw new Error(`Claude run did not succeed: ${m.subtype ?? "unknown result"}${typeof m.result === "string" ? `: ${m.result}` : ""}`);
          if (!output.trim() && ((spec.limits.maxTokens > 0 && inputTokens + outputTokens + cachedInputTokens > spec.limits.maxTokens) || overCostCap(microUsd, spec.limits.maxMicroUsd))) { push({ kind: "stopped", reason: "limit", detail: "Claude used the agent's allowance before it wrote an answer" }); return; }
          completed = true;
          if (typeof m.result === "string") resultText = m.result;
        }
      }
      if (!completed) throw new Error("Claude stream ended without a result");
      if (!output.trim() && resultText) push({ kind: "text", channel: "assistant", text: resultText });
      push({ kind: "stopped", reason: "completed" });
    } catch (error) {
      push({ kind: "stopped", reason: abort.signal.aborted ? "cancelled" : "error", detail: engineFailureDetail(error instanceof Error ? error.message : "Claude SDK run failed") });
    } finally {
      stream.close();
    }
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<void> {
    this.stream = new EngineEventStream();
    const abort = new AbortController();
    this.abort = abort;
    signal.addEventListener("abort", () => abort.abort(), { once: true });
    void this.complete(spec, this.stream, abort);
  }

  events(signal: AbortSignal): AsyncIterable<EngineEvent> { return this.stream.read(signal); }

  async toolResult(callId: string, text: string): Promise<void> {
    if (!this.requests) throw new Error("no Claude session is running");
    this.requests.complete(callId, text);
  }

  async cancel(): Promise<void> {
    this.requests?.clear();
    this.abort?.abort();
    this.query?.close();
    this.query = undefined;
  }

  async dispose(): Promise<void> {
    await this.cancel();
    this.stream.close();
  }
}
