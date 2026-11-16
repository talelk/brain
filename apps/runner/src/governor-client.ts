import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_ROUTES, sha256Digest } from "@brain/contracts";
import type {
  AckRequest, ApprovalPollResponse, ArtifactUpload, ArtifactUploadResponse, BlobRef, BrainToolRequest, BrainToolResponse, ChallengeRequest, ChallengeResponse, ClaimRequest,
  ClaimResponse, CompleteRequest, CompleteResponse, EnrollRequest, EnrollResponse, EventsRequest, EventsResponse, Fenced, HeartbeatRequest, HeartbeatResponse, HelloRequest,
  HelloResponse, LeaseResponse, ModelTokenRequest, ModelTokenResponse, SecretRequest, SecretResponse, ToolCallRequest, ToolCallResponse,
} from "@brain/contracts";

/**
 * The runner's side of the `/runner/v1` protocol (docs/architecture.md section 6): one method per route of `RUNNER_ROUTES`, with exactly
 * the request and response types of protocol.ts. A request is JSON and is answered with the response type as JSON; a refusal is any other
 * status with `{error: {code, message}}`. Everything after `hello` carries the session token as a bearer credential; a 401 asks the
 * runner to say hello again, once, and repeats the request. Blobs are checked against their digest and size and kept on disk.
 */
export interface GovernorClientConfig {
  readonly governorUrl: string;
  /** Where verified blobs are kept, by digest. */
  readonly blobDir: string;
  /** Transport seam: the platform's fetch by default; tests hand in a Governor that runs in the same process. */
  readonly transport?: typeof fetch;
}

/** A refusal from the Governor. `code` is the error code of its body when it has one. */
export class GovernorError extends Error {
  constructor(label: string, readonly status: number, readonly code: string | undefined, detail: string) {
    super(`${label} was refused (${status}${code ? ` ${code}` : ""})${detail ? `: ${detail}` : ""}`);
    this.name = "GovernorError";
  }
}

/** The fence moved: the attempt belongs to another lease now, and nothing more may be said about it. */
export const isLeaseLost = (error: unknown): boolean => error instanceof GovernorError && error.code === "LEASE_LOST";

const route = (template: string, params: Readonly<Record<string, string>> = {}): string => template.replace(/:([A-Za-z]+)/gu, (_all, name: string) => encodeURIComponent(params[name] ?? ""));

export class GovernorClient {
  private token: string | undefined;
  private renewing: Promise<void> | undefined;
  /** Says hello again and sets the new token; set by the runner once it has a session. */
  reauthenticate: (() => Promise<void>) | undefined;

  constructor(private readonly cfg: GovernorClientConfig) {}

  setToken(token: string): void { this.token = token; }

  private async send(path: string, init: { method: "GET" | "POST"; body?: string | Uint8Array; contentType?: string; timeoutMs?: number }): Promise<Response> {
    const once = (): Promise<Response> => (this.cfg.transport ?? fetch)(`${this.cfg.governorUrl.replace(/\/$/u, "")}${path}`, {
      method: init.method,
      headers: { ...(init.body === undefined ? {} : { "content-type": init.contentType ?? "application/json" }), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
    const first = await once();
    if (first.status !== 401 || !this.token || !this.reauthenticate) return first;
    // One hello serves every request that was refused with the old token.
    this.renewing ??= this.reauthenticate().finally(() => { this.renewing = undefined; });
    await this.renewing;
    return once();
  }

  private async refuse(label: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    let error: { code?: unknown; message?: unknown } = {};
    try { error = ((JSON.parse(text) as { error?: typeof error }).error) ?? {}; } catch { /* not JSON: the status alone */ }
    throw new GovernorError(label, response.status, typeof error.code === "string" ? error.code : undefined, typeof error.message === "string" ? error.message : "");
  }

  private async post<T>(label: string, path: string, body: unknown): Promise<T> {
    const response = await this.send(path, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) return this.refuse(label, response);
    return await response.json() as T;
  }

  // --- enrolment and session ---

  enroll(request: EnrollRequest): Promise<EnrollResponse> { return this.post("enroll", RUNNER_ROUTES.enroll, request); }
  challenge(request: ChallengeRequest): Promise<ChallengeResponse> { return this.post("challenge", RUNNER_ROUTES.challenge, request); }
  hello(request: HelloRequest): Promise<HelloResponse> { return this.post("hello", RUNNER_ROUTES.hello, request); }
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> { return this.post("heartbeat", RUNNER_ROUTES.heartbeat, request); }

  // --- an attempt ---

  claim(request: ClaimRequest): Promise<ClaimResponse> { return this.post("claim", RUNNER_ROUTES.claim, request); }
  ack(attemptId: string, request: AckRequest): Promise<LeaseResponse> { return this.post("ack", route(RUNNER_ROUTES.ack, { id: attemptId }), request); }
  renew(attemptId: string, request: Fenced): Promise<LeaseResponse> { return this.post("renew", route(RUNNER_ROUTES.renew, { id: attemptId }), request); }
  events(attemptId: string, request: EventsRequest): Promise<EventsResponse> { return this.post("events", route(RUNNER_ROUTES.events, { id: attemptId }), request); }
  toolCall(attemptId: string, request: ToolCallRequest): Promise<ToolCallResponse> { return this.post("tool-call", route(RUNNER_ROUTES.toolCall, { id: attemptId }), request); }
  brainTool(attemptId: string, request: BrainToolRequest): Promise<BrainToolResponse> { return this.post("brain-tool", route(RUNNER_ROUTES.brainTool, { id: attemptId }), request); }
  secret(attemptId: string, request: SecretRequest): Promise<SecretResponse> { return this.post("secret", route(RUNNER_ROUTES.secret, { id: attemptId }), request); }
  modelToken(attemptId: string, request: ModelTokenRequest): Promise<ModelTokenResponse> { return this.post("model-token", route(RUNNER_ROUTES.modelToken, { id: attemptId }), request); }
  complete(attemptId: string, request: CompleteRequest): Promise<CompleteResponse> { return this.post("complete", route(RUNNER_ROUTES.complete, { id: attemptId }), request); }

  /** Where a pending approval stands. The fence travels in the query, as it does for an upload. */
  async approval(attemptId: string, approvalId: string, request: Fenced): Promise<ApprovalPollResponse> {
    const response = await this.send(`${route(RUNNER_ROUTES.approval, { id: attemptId, approvalId })}?fence=${request.fence}`, { method: "GET" });
    if (!response.ok) return this.refuse("approval", response);
    return await response.json() as ApprovalPollResponse;
  }

  /** Uploads bytes as an artifact of the attempt. The answer's digest must be the digest of what was sent. */
  async uploadArtifact(attemptId: string, upload: ArtifactUpload, bytes: Uint8Array): Promise<ArtifactUploadResponse> {
    const query = new URLSearchParams({ fence: String(upload.fence), name: upload.name, kind: upload.kind, mediaType: upload.mediaType });
    const response = await this.send(`${route(RUNNER_ROUTES.artifacts, { id: attemptId })}?${query.toString()}`, { method: "POST", body: bytes, contentType: "application/octet-stream", timeoutMs: 120_000 });
    if (!response.ok) return this.refuse("artifact upload", response);
    const stored = await response.json() as ArtifactUploadResponse;
    if (stored.digest !== sha256Digest(bytes) || stored.bytes !== bytes.length) throw new Error(`the Governor stored artifact ${upload.name} under another digest than the bytes sent`);
    return stored;
  }

  /**
   * The bytes of a snapshot file (a prompt, a tool file) or of a patch, by digest. They come from the on-disk cache when it holds them,
   * otherwise from the Governor; either way they are returned only when their digest (and their size, when the reference states one) is the one asked for.
   */
  async blob(ref: Pick<BlobRef, "digest"> & Partial<BlobRef>): Promise<Uint8Array> {
    const matches = (bytes: Uint8Array): boolean => (ref.bytes === undefined || bytes.length === ref.bytes) && sha256Digest(bytes) === ref.digest;
    if (!/^sha256:[0-9a-f]{64}$/u.test(ref.digest)) throw new Error(`${ref.digest} is not a digest`);
    const cached = join(this.cfg.blobDir, ref.digest.slice("sha256:".length));
    if (existsSync(cached)) {
      const held = new Uint8Array(readFileSync(cached));
      if (matches(held)) return held;
    }
    const response = await this.send(route(RUNNER_ROUTES.blob, { digest: ref.digest }), { method: "GET", timeoutMs: 120_000 });
    if (!response.ok) return this.refuse("blob", response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!matches(bytes)) throw new Error(`the bytes of blob ${ref.digest.slice(0, 19)} do not match its digest or size; they are not used`);
    mkdirSync(this.cfg.blobDir, { recursive: true });
    // Slots fill the cache at the same time: write beside the file and rename, so nothing ever reads half a blob.
    const partial = `${cached}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(partial, bytes, { mode: 0o600 });
    renameSync(partial, cached);
    return bytes;
  }
}
