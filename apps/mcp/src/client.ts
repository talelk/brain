import { randomBytes } from "node:crypto";
import type { ApiError } from "@brain/contracts";

/** What the server needs to reach a Brain: its address and the sign-in of one person. Never printed or logged. */
export interface BrainConfig { readonly url: string; readonly email: string; readonly password: string }

/** A refusal by Brain (or by the network), as the tools report it. */
export class BrainRequestError extends Error {
  constructor(readonly status: number, readonly error: Partial<ApiError> & { readonly message: string }) {
    super(error.message);
  }
}

/** Brain's HTTP API as one signed-in person: the sign-in cookie is kept and made again when the session ends. */
export class BrainClient {
  private cookie = "";
  private readonly base: string;

  constructor(private readonly config: BrainConfig) {
    this.base = config.url.replace(/\/+$/u, "");
  }

  query(type: string, input: unknown): Promise<unknown> {
    return this.call("/v1/query", { type, input });
  }

  command(type: string, input: unknown): Promise<unknown> {
    return this.call("/v1/command", { type, input, idempotencyKey: randomBytes(8).toString("hex") });
  }

  /** One POST; a network failure is tried once more (a request that did not arrive is safe to repeat; a command carries its idempotency key) and then reported. */
  private async send(path: string, headers: Record<string, string>, body: unknown): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetch(`${this.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (error) {
        if (attempt === 2) throw new BrainRequestError(0, { message: `Brain is not reachable at ${this.base}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  private async signIn(): Promise<void> {
    const response = await this.send("/api/auth/sign-in/email", { "content-type": "application/json", origin: this.base }, { email: this.config.email, password: this.config.password });
    if (!response.ok) throw new BrainRequestError(response.status, { code: "UNAUTHENTICATED", message: `sign-in refused (HTTP ${response.status}); check BRAIN_EMAIL and BRAIN_PASSWORD` });
    this.cookie = response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  }

  private async call(path: string, body: unknown, retry = true): Promise<unknown> {
    if (this.cookie === "") await this.signIn();
    const response = await this.send(path, { "content-type": "application/json", origin: this.base, cookie: this.cookie }, body);
    const answer = (await response.json().catch(() => ({}))) as { output?: unknown; error?: ApiError };
    if (response.status === 401 && retry) {
      this.cookie = "";
      return this.call(path, body, false);
    }
    if (answer.error !== undefined) throw new BrainRequestError(response.status, answer.error);
    if (!response.ok) throw new BrainRequestError(response.status, { message: `HTTP ${response.status}` });
    return answer.output;
  }
}
