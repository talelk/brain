import type { MemoryQuery, MemoryResult } from "@brain/contracts";
import { BrainDomainError } from "../../../domain/errors";

// TencentDB-Agent-Memory v3 client (standalone or service deployment).
// Isolation maps Brain organization -> team_id, workspace -> task scope note,
// principal -> user_id. Brain re-checks scope before returning results.
export class TencentDbClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly serviceId = "default",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  static fromEnv(): TencentDbClient | null {
    const url = process.env["BRAIN_TENCENTDB_URL"];
    if (!url) return null;
    const parsed = new URL(url);
    if (parsed.username || parsed.password || !["http:","https:"].includes(parsed.protocol)) throw new BrainDomainError("INVALID_ARGUMENT", "TencentDB URL must be credential-free HTTP(S)");
    const key = process.env["BRAIN_TENCENTDB_API_KEY"];
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    if (!loopback && (!key || key === "local-no-key")) throw new BrainDomainError("FORBIDDEN", "non-loopback TencentDB requires BRAIN_TENCENTDB_API_KEY");
    return new TencentDbClient(url, key ?? "local-no-key");
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "x-tdai-service-id": this.serviceId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (text.length > 1024 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "TencentDB response too large");
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!res.ok || parsed["code"] !== 0) {
      throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", `TencentDB ${path} failed: ${String(parsed["message"] ?? res.status)}`, { retryable: true });
    }
    return (parsed["data"] ?? {}) as Record<string, unknown>;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch { return false; }
  }

  async publish(input: { organizationId: string; userId: string; sessionId: string; text: string }): Promise<string> {
    const data = await this.post("/v3/conversation/add", {
      session_id: input.sessionId, team_id: input.organizationId, agent_id: "brain", user_id: input.userId,
      messages: [{ role: "user", content: input.text.slice(0, 8192) }],
    });
    const ids = (data["accepted_ids"] ?? []) as string[];
    return ids[0] ?? "";
  }

  async search(query: MemoryQuery, userId = "brain-search"): Promise<MemoryResult[]> {
    const data = await this.post("/v3/conversation/search", {
      query: query.query.slice(0, 2048), limit: Math.min(Math.max(query.limit, 1), 8),
      team_id: query.scope.organizationId, agent_id: "brain", user_id: userId,
    });
    const messages = (data["messages"] ?? []) as Array<{ id: string; content: string; timestamp?: string }>;
    return messages.map((m) => ({
      sourceId: m.id,
      scope: query.scope,
      sourceVersion: "v1",
      updatedAt: m.timestamp ?? new Date().toISOString(),
      classification: "internal" as const,
      content: m.content.slice(0, Math.max(0, query.maxChars || 12000)),
      provenance: [m.id],
      status: "unverified" as const,
    }));
  }
}
