import type { JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";

// GitLab REST v4 reference connector (issues/notes). Direct bounded HTTP.
// Note creation has no exactly-once semantics: idempotency "none", reconcile by readback.
export class GitLabConnector {
  constructor(
    private readonly baseUrl: string,
    private readonly projectId: number,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async req(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/api/v4${path}`, {
      ...init,
      headers: { "PRIVATE-TOKEN": this.token, "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (text.length > 1024 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "GitLab response too large");
    if (!res.ok) throw new BrainDomainError(res.status === 429 ? "RATE_LIMITED" : "DEPENDENCY_UNAVAILABLE", `GitLab ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
    return text ? (JSON.parse(text) as unknown) : null;
  }

  async probe(): Promise<{ reachable: boolean; observedAt: string }> {
    try {
      await this.req(`/projects/${this.projectId}`);
      return { reachable: true, observedAt: new Date().toISOString() };
    } catch {
      return { reachable: false, observedAt: new Date().toISOString() };
    }
  }

  async getIssue(iid: number): Promise<JsonValue> {
    return (await this.req(`/projects/${this.projectId}/issues/${iid}`)) as JsonValue;
  }

  // Read-only fact discovery (T41 onboarding): bounded issue listing used to
  // seed local ticket facts. Discovery never writes to the remote system.
  async listIssues(updatedAfter?: string): Promise<Array<Record<string, unknown>>> {
    const query = updatedAfter ? `?per_page=100&updated_after=${encodeURIComponent(updatedAfter)}` : "?per_page=100";
    const raw = await this.req(`/projects/${this.projectId}/issues${query}`);
    if (!Array.isArray(raw)) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "GitLab issues response is not an array");
    return raw as Array<Record<string, unknown>>;
  }

  async listNotes(iid: number): Promise<JsonValue> {
    return (await this.req(`/projects/${this.projectId}/issues/${iid}/notes?per_page=100`)) as JsonValue;
  }

  async createNote(iid: number, body: string): Promise<JsonValue> {
    return (await this.req(`/projects/${this.projectId}/issues/${iid}/notes`, {
      method: "POST", body: JSON.stringify({ body }),
    })) as JsonValue;
  }

  async reconcileNote(iid: number, exactBody: string): Promise<{ outcome: "applied" | "absent" | "conflicting" | "unknown" }> {
    try {
      const notes = (await this.listNotes(iid)) as unknown as Array<{ body?: string }>;
      const matches = notes.filter((n) => n.body === exactBody);
      if (matches.length === 1) return { outcome: "applied" };
      if (matches.length > 1) return { outcome: "conflicting" };
      return { outcome: "absent" };
    } catch {
      return { outcome: "unknown" };
    }
  }
}
