import { readFileSync, statSync } from "node:fs";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";

// Claude Agent SDK adapter (TypeScript SDK only; no parallel CLI adapter).
// Endpoint/credential gate (T25): a real Anthropic or cloud-shaped endpoint
// requires a real credential from BRAIN_ANTHROPIC_API_KEY_FILE (preferred,
// permission-checked file) or ANTHROPIC_API_KEY. The local placeholder key
// is honored only for loopback/LAN endpoints and only with the explicit
// BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY=1 opt-in — no silent fallback.
export interface AnthropicEndpoint {
  baseUrl?: string | undefined;
  keySource: "file" | "env" | "local-placeholder";
  local: boolean;
}

export function isLocalAnthropicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
  if (local && env["BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY"] === "1") {
    return { baseUrl, keySource: "local-placeholder", local };
  }
  throw new Error(
    local
      ? "Local Anthropic endpoint requires BRAIN_ANTHROPIC_API_KEY_FILE/ANTHROPIC_API_KEY, or explicit BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY=1"
      : "Anthropic credential required: set BRAIN_ANTHROPIC_API_KEY_FILE (preferred) or ANTHROPIC_API_KEY",
  );
}
export class ClaudeEngine implements EngineAdapter {
  readonly id = "claude";
  private buffer: EngineEvent[] = [];
  private seq = 0;
  private sessionId = "";
  private abort: AbortController | null = null;

  private baseUrl(): string | undefined {
    return process.env["BRAIN_ANTHROPIC_BASE_URL"] ?? process.env["ANTHROPIC_BASE_URL"];
  }
  private model(): string {
    return process.env["BRAIN_CLAUDE_MODEL"] ?? process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b";
  }

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
    return { id: "claude", version, adapterDigest: `sha256:${"0".repeat(64)}`, features: version.endsWith("-local") ? ["sessions"] : [] };
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<{ sessionId: string }> {
    this.ensureEnv();
    this.sessionId = `claude-${Date.now().toString(36)}`;
    this.buffer = [];
    this.seq = 0;
    this.abort = new AbortController();
    signal.addEventListener("abort", () => this.abort?.abort(), { once: true });
    const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as typeof import("@anthropic-ai/claude-agent-sdk");
    const prompt = "Report ready.";
    void (async () => {
      try {
        for await (const message of query({
          prompt,
          options: { model: this.model(), cwd: process.cwd(), maxTurns: 10, abortController: this.abort ?? undefined } as never,
        })) {
          const m = message as unknown as { type: string; message?: { content?: Array<{ type: string; text?: string }> }; result?: string };
          if (m.type === "assistant") {
            for (const block of m.message?.content ?? []) {
              if (block.type === "text" && block.text) {
                this.seq += 1;
                this.buffer.push({
                  contractVersion: "brain.engine-event/v1", eventId: `claude-evt-${this.seq}`,
                  sessionId: this.sessionId, attemptId: spec.attemptId, sequence: this.seq,
                  occurredAt: new Date().toISOString(), kind: "text",
                  payload: { text: block.text, channel: "assistant", provisional: true },
                });
              }
            }
          }
        }
      } catch {
        this.seq += 1;
        this.buffer.push({
          contractVersion: "brain.engine-event/v1", eventId: `claude-evt-${this.seq}`,
          sessionId: this.sessionId, attemptId: spec.attemptId, sequence: this.seq,
          occurredAt: new Date().toISOString(), kind: "error",
          payload: { error: { code: "DEPENDENCY_UNAVAILABLE", detail: "Claude SDK run failed", retryable: true, correlationId: this.sessionId }, phase: "stream", retryClass: "new-attempt" },
        });
      }
    })();
    return { sessionId: this.sessionId };
  }

  async *events(_sessionId: string, after: number, _signal: AbortSignal): AsyncIterable<EngineEvent> {
    for (const ev of this.buffer) if ((ev as { sequence: number }).sequence > after) yield ev;
  }

  async cancel() {
    this.abort?.abort();
    return { terminationConfirmed: true };
  }

  async checkpoint(): Promise<never> {
    throw Object.assign(new Error("Muse checkpoint mapping pending G05 full conformance"), { code: "UNSUPPORTED_CAPABILITY" });
  }

  async dispose() { this.abort?.abort(); }
}
