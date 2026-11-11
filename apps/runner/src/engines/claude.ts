import { readFileSync, statSync } from "node:fs";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";
import { overCostCap } from "./limits";
import { GovernedToolCalls } from "./tool-calls";
import { z } from "zod";
import type { ZodTypeAny } from "zod";

function schemaToZod(schema: Record<string, JsonValue>): ZodTypeAny {
  if (Array.isArray(schema["enum"]) && schema["enum"].every((value) => typeof value === "string") && schema["enum"].length) return z.enum(schema["enum"] as [string, ...string[]]);
  if (schema["const"] !== undefined && (typeof schema["const"] === "string" || typeof schema["const"] === "number" || typeof schema["const"] === "boolean")) return z.literal(schema["const"]);
  if (schema["type"] === "string") return z.string();
  if (schema["type"] === "number") return z.number();
  if (schema["type"] === "integer") return z.number().int();
  if (schema["type"] === "boolean") return z.boolean();
  if (schema["type"] === "array") return z.array(schemaToZod((schema["items"] as Record<string, JsonValue> | undefined) ?? {}));
  if (schema["type"] === "object") {
    const properties = (schema["properties"] as Record<string, Record<string, JsonValue>> | undefined) ?? {};
    const required = new Set((schema["required"] as string[] | undefined) ?? []);
    const shape: Record<string, ZodTypeAny> = {};
    for (const [key, value] of Object.entries(properties)) shape[key] = required.has(key) ? schemaToZod(value) : schemaToZod(value).optional();
    return schema["additionalProperties"] === false ? z.object(shape).strict() : z.object(shape).passthrough();
  }
  return z.unknown();
}

export interface AnthropicEndpoint {
  baseUrl?: string | undefined;
  keySource: "file" | "env" | "local-placeholder";
  local: boolean;
}

export function isLocalAnthropicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return host === "::1" || host.startsWith("fe80:");
}

export function resolveAnthropicEndpoint(env: NodeJS.ProcessEnv = process.env): AnthropicEndpoint {
  const baseUrl = env["BRAIN_ANTHROPIC_BASE_URL"] ?? env["ANTHROPIC_BASE_URL"];
  let local = false;
  if (baseUrl) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new Error(`BRAIN_ANTHROPIC_BASE_URL is not a valid URL: ${baseUrl}`); }
    local = isLocalAnthropicHost(parsed.hostname);
  }
  const keyFile = env["BRAIN_ANTHROPIC_API_KEY_FILE"];
  if (keyFile) {
    const stat = statSync(keyFile);
    if ((stat.mode & 0o077) !== 0) throw new Error(`BRAIN_ANTHROPIC_API_KEY_FILE must not be group/world accessible: ${keyFile}`);
    const key = readFileSync(keyFile, "utf8").trim();
    if (!key || key === "local-no-key") throw new Error("BRAIN_ANTHROPIC_API_KEY_FILE contains no real credential");
    env["ANTHROPIC_API_KEY"] = key;
    return { baseUrl, keySource: "file", local };
  }
  const envKey = env["ANTHROPIC_API_KEY"] ?? env["ANTHROPIC_AUTH_TOKEN"];
  if (envKey && envKey !== "local-no-key") {
    env["ANTHROPIC_API_KEY"] = envKey;
    env["ANTHROPIC_AUTH_TOKEN"] = envKey;
    return { baseUrl, keySource: "env", local };
  }
  if (local && env["BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY"] === "1") return { baseUrl, keySource: "local-placeholder", local };
  throw new Error(
    local
      ? "Local Anthropic endpoint requires BRAIN_ANTHROPIC_API_KEY_FILE/ANTHROPIC_API_KEY, or explicit BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY=1"
      : "Anthropic credential required: set BRAIN_ANTHROPIC_API_KEY_FILE (preferred) or ANTHROPIC_API_KEY",
  );
}

type UserInput = { type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null; priority?: "now" | "next" | "later" };

/**
 * Streaming-input prompt for the Agent SDK (#31): the first message starts the
 * turn, steering messages join the live turn, and closing ends the stream so
 * the query finishes after its result.
 */
class PromptStream implements AsyncIterable<UserInput> {
  private readonly queue: UserInput[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  push(message: UserInput): void { if (this.closed) throw new Error("the Claude turn has ended"); this.queue.push(message); this.wake?.(); }
  close(): void { this.closed = true; this.wake?.(); }
  get open(): boolean { return !this.closed; }
  async *[Symbol.asyncIterator](): AsyncIterator<UserInput> {
    for (;;) {
      const next = this.queue.shift();
      if (next) { yield next; continue; }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

export class ClaudeEngine implements EngineAdapter {
  readonly id = "claude";
  get defaultModelId(): string { return this.model(); }
  private seq = 0;
  private sessionId = "";
  private spec: EngineSessionSpec | undefined;
  private abort: AbortController | null = null;
  private stream = new EngineEventStream();
  private output = "";
  private query: { close(): void } | undefined;
  private input: PromptStream | undefined;
  /** The SDK's own session id, captured from its init message for native resume (#31). */
  private nativeSessionId = "";
  private toolCalls: GovernedToolCalls | undefined;
  private toolSeq = 0;
  constructor(private readonly toolBindings: readonly EngineToolBinding[] = []) {}

  private baseUrl(): string | undefined { return process.env["BRAIN_ANTHROPIC_BASE_URL"] ?? process.env["ANTHROPIC_BASE_URL"]; }
  private model(): string { return process.env["BRAIN_CLAUDE_MODEL"] ?? process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b"; }

  private ensureEnv(): void {
    const endpoint = resolveAnthropicEndpoint(process.env);
    if (endpoint.baseUrl) process.env["ANTHROPIC_BASE_URL"] = endpoint.baseUrl;
    const credential = endpoint.keySource === "local-placeholder" ? "local-no-key" : process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = credential;
    process.env["ANTHROPIC_AUTH_TOKEN"] = credential;
    const teamId = process.env["BRAIN_TENCENTDB_TEAM_ID"], agentId = process.env["BRAIN_TENCENTDB_AGENT_ID"];
    if (teamId && agentId && !process.env["ANTHROPIC_CUSTOM_HEADERS"]) {
      if (/[\r\n]/u.test(teamId) || /[\r\n]/u.test(agentId)) throw new Error("TencentDB binding contains invalid characters");
      process.env["ANTHROPIC_CUSTOM_HEADERS"] = `x-team-id: ${teamId}\nx-agent-id: ${agentId}`;
    }
  }

  async probe() {
    let version = "unavailable";
    try {
      this.ensureEnv();
      await import("@anthropic-ai/claude-agent-sdk");
      const base = this.baseUrl();
      const credential = process.env["ANTHROPIC_AUTH_TOKEN"]!;
      const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${credential}`, "x-api-key": credential, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(5000) });
      version = res.ok ? "0.3.311-local" : "0.3.311-model-unreachable";
    } catch { version = "unavailable"; }
    return { id: "claude", version, adapterDigest: sha256Digest(new Uint8Array(readFileSync(new URL(import.meta.url)))), features: version.endsWith("-local") ? ["sessions", "steer"] : [] };
  }

  private push(kind: EngineEvent["kind"], payload: EngineEvent["payload"]): void {
    const spec = this.spec;
    if (!spec) return;
    this.seq += 1;
    this.stream.push({
      contractVersion: "brain.engine-event/v1", eventId: `claude-evt-${this.seq}`,
      sessionId: this.sessionId, attemptId: spec.attemptId, sequence: this.seq,
      occurredAt: new Date().toISOString(), kind, payload,
    } as EngineEvent);
  }

  private async complete(spec: EngineSessionSpec): Promise<void> {
    try {
      const { query, tool, createSdkMcpServer } = (await import("@anthropic-ai/claude-agent-sdk")) as typeof import("@anthropic-ai/claude-agent-sdk");
      const prompt = `${spec.instructions.trim()}\n\nTask:\n${spec.task}`.trim();
      if (spec.allowedTools.some((allowed) => !this.toolBindings.some((binding) => binding.release.id === allowed.id && binding.release.digest === allowed.digest))) throw new Error("Claude Agent tool definitions are incomplete; refusing execution");
      const calls = new GovernedToolCalls(this.toolBindings, spec, (kind, payload) => this.push(kind, payload));
      this.toolCalls = calls;
      const tools = this.toolBindings.map((binding) => {
        const name = `brain_${binding.release.id.replace(/[^A-Za-z0-9_]/gu, "_")}`;
        const properties = (binding.inputSchema["properties"] as Record<string, Record<string, JsonValue>> | undefined) ?? {};
        const required = new Set((binding.inputSchema["required"] as string[] | undefined) ?? []);
        const shape: Record<string, ZodTypeAny> = {};
        for (const [key, value] of Object.entries(properties)) shape[key] = required.has(key) ? schemaToZod(value) : schemaToZod(value).optional();
        return tool(name, `Governed ${binding.effectClass} tool ${binding.release.id}; Brain validates and isolates every call.`, shape, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await calls.execute(name, `claude-tool-${++this.toolSeq}`, args as JsonValue)) }] }));
      });
      const mcpServer = tools.length ? createSdkMcpServer({ name: "brain", version: "1", tools, alwaysLoad: true, timeout: Math.min(spec.limits.timeoutMs, 60_000) }) : undefined;
      let resultText = "";
      let completed = false;
      const input = new PromptStream();
      input.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
      this.input = input;
      const execution = query({
        prompt: input as never,
        options: {
          model: spec.modelId || this.model(), cwd: process.cwd(), maxTurns: spec.limits.maxTurns,
          tools: [], allowedTools: calls.names().map((name) => `mcp__brain__${name}`), settingSources: [],
          ...(mcpServer ? { mcpServers: { brain: mcpServer } } : {}),
          ...(spec.limits.maxMicroUsd > 0 ? { maxBudgetUsd: spec.limits.maxMicroUsd / 1000000 } : {}),
          env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.limits.maxTokens) },
          canUseTool: async (toolName: string, input: Record<string, unknown>) => calls.names().some((name) => toolName === `mcp__brain__${name}`)
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Only release-pinned Brain broker tools are allowed" },
          abortController: this.abort ?? undefined,
        } as never,
      });
      this.query = execution;
      for await (const message of execution) {
        const m = message as unknown as { type: string; message?: { content?: Array<{ type: string; text?: string }> }; result?: string; subtype?: string; is_error?: boolean; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };
        if (m.type === "assistant") {
          for (const block of m.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              this.output += block.text;
              this.push("text", { text: block.text, channel: "assistant", provisional: true });
            }
          }
        }
        const native = (message as unknown as { session_id?: string }).session_id;
        if (native && !this.nativeSessionId) this.nativeSessionId = native;
        if (m.type === "result") {
          input.close();
          if (m.subtype !== "success" || m.is_error) throw new Error(`Claude run did not succeed: ${m.subtype ?? "unknown result"}`);
          const inputTokens = m.usage?.input_tokens ?? 0, outputTokens = m.usage?.output_tokens ?? 0, cachedInputTokens = m.usage?.cache_read_input_tokens ?? 0;
          const microUsd = resolveAnthropicEndpoint(process.env).local ? 0 : Math.ceil((m.total_cost_usd ?? 0)*1000000);
          this.push("usage",{usageId:`claude-usage-${spec.attemptId}`,inputTokens,outputTokens,cachedInputTokens,microUsd,accounting:"final-total",estimated:false});
          if (inputTokens+outputTokens+cachedInputTokens > spec.limits.maxTokens || overCostCap(microUsd, spec.limits.maxMicroUsd)) throw new Error("Claude execution exceeded its pinned token/cost budget");
          completed = true;
          if (typeof m.result === "string") resultText = m.result;
        }
      }
      if (!completed) throw new Error("Claude stream ended without a successful terminal result");
      if (!this.output.trim() && resultText) {
        this.output = resultText;
        this.push("text", { text: resultText, channel: "assistant", provisional: true });
      }
      const bytes = new TextEncoder().encode(this.output);
      const artifact = {
        artifactId: `claude-output-${spec.attemptId}`, digest: sha256Digest(bytes), bytes: bytes.length,
        mediaType: "text/plain", classification: "internal" as const,
      };
      this.push("artifact", { artifact, purpose: "output" });
      this.push("session.stopped", { reason: "completed", terminationConfirmed: true, output: artifact });
    } catch (e) {
      this.push("error", {
        error: { code: "DEPENDENCY_UNAVAILABLE", detail: e instanceof Error ? e.message : "Claude SDK run failed", retryable: true, correlationId: this.sessionId },
        phase: "stream", retryClass: "new-attempt",
      });
      this.push("session.stopped", { reason: "error", terminationConfirmed: true });
    } finally {
      this.input?.close();
      this.stream.close();
    }
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<{ sessionId: string }> {
    this.ensureEnv();
    this.spec = spec;
    this.sessionId = `claude-${Date.now().toString(36)}`;
    this.seq = 0;
    this.output = "";
    this.stream = new EngineEventStream();
    this.abort = new AbortController();
    signal.addEventListener("abort", () => this.abort?.abort(), { once: true });
    this.push("session.started", { engine: spec.engine });
    void this.complete(spec);
    return { sessionId: this.sessionId };
  }

  async *events(_sessionId: string, after: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    yield* this.stream.after(after, signal);
  }

  async toolResult(_sessionId: string, result: EngineToolExecutionResult): Promise<void> {
    if (!this.toolCalls) throw new Error("Claude tool broker is not initialized");
    this.toolCalls.complete(result);
  }

  async cancel(_sessionId?: string, _reason?: string) {
    this.input?.close();
    this.toolCalls?.clear();
    this.abort?.abort();
    this.query?.close(); this.query = undefined;
    this.stream.close();
    return { terminationConfirmed: true };
  }

  /**
   * Steering joins the live turn through the streaming-input prompt with
   * priority "next", so the SDK applies it at its next turn boundary. Without a
   * live turn there is nothing to steer: refused with the typed error.
   */
  async steer(sessionId: string, messageId: string, message: string): Promise<void> {
    if (sessionId !== this.sessionId || !this.input?.open) throw Object.assign(new Error(`Claude session ${sessionId} has no live turn to steer`), { code: "UNSUPPORTED_CAPABILITY" });
    this.input.push({ type: "user", message: { role: "user", content: `[steer:${messageId}] ${message}` }, parent_tool_use_id: null, priority: "next" });
  }

  /** The SDK's native session id once the run has started, for warm-start resume. */
  get nativeSession(): string { return this.nativeSessionId; }

  async checkpoint(): Promise<never> {
    throw Object.assign(new Error("Claude checkpoint mapping is not supported"), { code: "UNSUPPORTED_CAPABILITY" });
  }

  async dispose(_sessionId?: string) {
    this.input?.close();
    this.abort?.abort();
    this.query?.close(); this.query = undefined;
    this.stream.close();
  }
}
