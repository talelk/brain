import { readFileSync, statSync } from "node:fs";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";

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
  const envKey = env["ANTHROPIC_API_KEY"];
  if (envKey && envKey !== "local-no-key") return { baseUrl, keySource: "env", local };
  if (local && env["BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY"] === "1") return { baseUrl, keySource: "local-placeholder", local };
  throw new Error(
    local
      ? "Local Anthropic endpoint requires BRAIN_ANTHROPIC_API_KEY_FILE/ANTHROPIC_API_KEY, or explicit BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY=1"
      : "Anthropic credential required: set BRAIN_ANTHROPIC_API_KEY_FILE (preferred) or ANTHROPIC_API_KEY",
  );
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

  private baseUrl(): string | undefined { return process.env["BRAIN_ANTHROPIC_BASE_URL"] ?? process.env["ANTHROPIC_BASE_URL"]; }
  private model(): string { return process.env["BRAIN_CLAUDE_MODEL"] ?? process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b"; }

  private ensureEnv(): void {
    const endpoint = resolveAnthropicEndpoint(process.env);
    if (endpoint.baseUrl) process.env["ANTHROPIC_BASE_URL"] = endpoint.baseUrl;
    if (endpoint.keySource === "local-placeholder") process.env["ANTHROPIC_API_KEY"] = "local-no-key";
  }

  async probe() {
    let version = "unavailable";
    try {
      resolveAnthropicEndpoint(process.env);
      await import("@anthropic-ai/claude-agent-sdk");
      const base = this.baseUrl();
      const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
      version = res.ok ? "0.3.311-local" : "0.3.311-model-unreachable";
    } catch { version = "unavailable"; }
    return { id: "claude", version, adapterDigest: sha256Digest(new Uint8Array(readFileSync(new URL(import.meta.url)))), features: version.endsWith("-local") ? ["sessions"] : [] };
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
      const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as typeof import("@anthropic-ai/claude-agent-sdk");
      const prompt = `${spec.instructions.trim()}\n\nTask:\n${spec.task}`.trim();
      if (spec.allowedTools.length > 0) throw new Error("Claude governed tool bindings are not configured; refusing native tool access");
      let resultText = "";
      let completed = false;
      const execution = query({
        prompt,
        options: {
          model: spec.modelId || this.model(), cwd: process.cwd(), maxTurns: spec.limits.maxTurns,
          tools: [], allowedTools: [], settingSources: [],
          ...(spec.limits.maxMicroUsd > 0 ? { maxBudgetUsd: spec.limits.maxMicroUsd / 1000000 } : {}),
          env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.limits.maxTokens) },
          canUseTool: async () => ({ behavior: "deny", message: "Native tools are disabled; Brain tools require the governed broker" }),
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
        if (m.type === "result") {
          if (m.subtype !== "success" || m.is_error) throw new Error(`Claude run did not succeed: ${m.subtype ?? "unknown result"}`);
          const inputTokens = m.usage?.input_tokens ?? 0, outputTokens = m.usage?.output_tokens ?? 0, cachedInputTokens = m.usage?.cache_read_input_tokens ?? 0;
          const microUsd = Math.ceil((m.total_cost_usd ?? 0)*1000000);
          this.push("usage",{usageId:`claude-usage-${spec.attemptId}`,inputTokens,outputTokens,cachedInputTokens,microUsd,accounting:"final-total",estimated:false});
          if (inputTokens+outputTokens+cachedInputTokens > spec.limits.maxTokens || microUsd > spec.limits.maxMicroUsd) throw new Error("Claude execution exceeded its pinned token/cost budget");
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

  async cancel(_sessionId?: string, _reason?: string) {
    this.abort?.abort();
    this.query?.close(); this.query = undefined;
    this.stream.close();
    return { terminationConfirmed: true };
  }

  async checkpoint(): Promise<never> {
    throw Object.assign(new Error("Claude checkpoint mapping is not supported"), { code: "UNSUPPORTED_CAPABILITY" });
  }

  async dispose(_sessionId?: string) {
    this.abort?.abort();
    this.query?.close(); this.query = undefined;
    this.stream.close();
  }
}
