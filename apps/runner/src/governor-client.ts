import { sha256Digest } from "@brain/contracts";
import type { Agent, EngineToolBinding, VerificationVerdict } from "@brain/contracts";

/**
 * Typed client for the Governor's `/runner/v1` protocol.
 *
 * Every round-trip the runner supervisor makes lives here: enrollment and
 * the challenge/hello handshake, the claim/ack/lease cycle, digest-pinned
 * artifact and release-asset fetches, permits, events, completion, evidence
 * and verdicts. The supervisor keeps only execution policy (sandbox, spool,
 * engine run, watchdog); this module owns the wire.
 *
 * Two adapters exercise this one interface: real HTTP in production, and a
 * scripted `transport` fake in tests — the protocol is testable without
 * booting a Governor.
 *
 * Digest verification is part of the protocol guarantee, not caller policy:
 * `executionArtifact`, `agentInstructions` and `toolScript` return verified
 * bytes or throw. There is no unverified-bytes escape hatch.
 */

export interface GovernorClientConfig {
  readonly governorUrl: string;
  /** Transport seam: production fetch by default, scripted fake in tests. */
  readonly transport?: typeof fetch;
}

/** A non-OK HTTP answer from the Governor. Callers branch on `status` only
 * for declared control flow (401 stale session, 409/410 fenced attempt);
 * everything else aborts the current operation. */
export class GovernorProtocolError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(label: string, status: number, body: unknown) {
    super(`${label} failed ${status}: ${JSON.stringify(body)}`);
    this.name = "GovernorProtocolError";
    this.status = status;
    this.body = body;
  }
}

/** The offer shape `/runner/v1/claim` returns for a leased attempt. */
export interface JobOffer {
  attemptId: string;
  jobId: string;
  workspaceId: string;
  organizationId?: string;
  workflowRunId?: string;
  attemptNumber?: number;
  sourceRevision?: string;
  leaseId: string;
  jobFence: number;
  configDigest: string;
  workflowDigest?: string;
  primitiveVersions?: Record<string, string>;
  toolPins?: Record<string, string>;
  authorEvidence?: { toolReleases: { id: string; digest: string }[]; claimedChecks: unknown[] };
  execution: { kind: string; artifact: { artifactId: string; digest: string; bytes: number } };
}

export interface HeartbeatCommand {
  type?: string;
  commandId?: string;
  attemptId?: string;
  text?: string;
}

export interface HeartbeatAck {
  commands?: HeartbeatCommand[];
}

export interface AgentInstructions {
  agent: Agent;
  toolBindings: EngineToolBinding[];
  instructions: string;
}

export interface ToolScript {
  entrypoint: string;
  bytes: Uint8Array;
}

export interface UploadedArtifact {
  artifactId: string;
  digest: string;
  bytes: number;
}

export class GovernorClient {
  private token: string | undefined;

  constructor(private readonly cfg: GovernorClientConfig) {}

  /** Runtime session token; enrollment-time calls are unauthenticated. */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  private async request(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await (this.cfg.transport ?? fetch)(`${this.cfg.governorUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
  }

  private async requestBytes(path: string): Promise<{ status: number; bytes: Uint8Array }> {
    const res = await (this.cfg.transport ?? fetch)(`${this.cfg.governorUrl.replace(/\/$/, "")}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  private expect<T>(label: string, res: { status: number; json: unknown }, expected: number): T {
    if (res.status !== expected) throw new GovernorProtocolError(label, res.status, res.json);
    return res.json as T;
  }

  // --- enrollment and session -------------------------------------------

  async enroll(enrollToken: string, publicKey: string, runnerId: string): Promise<{ credential: string }> {
    return this.expect("enroll", await this.request("/runner/v1/enroll", { token: enrollToken, publicKey, runnerId }), 201);
  }

  async challenge(runnerId: string, credential: string): Promise<{ challengeId: string; nonce: string }> {
    return this.expect("challenge", await this.request("/runner/v1/challenges", { runnerId, credential }), 201);
  }

  /** The hello body (capabilities, engines, capacity, proof) is assembled by
   * the supervisor; the client owns the authenticated round-trip. */
  async hello(body: unknown): Promise<{ sessionToken: string; epoch: number }> {
    return this.expect("hello", await this.request("/runner/v1/hello", body), 200);
  }

  async heartbeat(body: unknown): Promise<HeartbeatAck> {
    return this.expect("heartbeat", await this.request("/runner/v1/heartbeat", body), 200);
  }

  // --- attempt lifecycle --------------------------------------------------

  /** 204 means no work; null is the typed form of that answer. */
  async claim(requestId: string): Promise<JobOffer | null> {
    const res = await this.request("/runner/v1/claim", { requestId });
    if (res.status === 204) return null;
    if (res.status !== 200) throw new GovernorProtocolError("claim", res.status, res.json);
    return res.json as JobOffer;
  }

  async ack(attemptId: string, body: unknown): Promise<{ leaseExpiresAt?: string }> {
    return this.expect("ack", await this.request(`/runner/v1/attempts/${attemptId}/ack`, body), 200);
  }

  /** Execution input travels as a digest-pinned CAS artifact, never inline;
   * bytes are verified against the offer pin before they are returned. */
  async executionArtifact(attemptId: string, expectedDigest: string, expectedBytes: number): Promise<Uint8Array> {
    const res = await this.requestBytes(`/runner/v1/attempts/${attemptId}/artifact`);
    if (res.status !== 200) throw new GovernorProtocolError("execution artifact fetch", res.status, null);
    if (sha256Digest(res.bytes) !== expectedDigest || res.bytes.length !== expectedBytes) {
      throw new Error("execution artifact digest/size mismatch; refusing to run");
    }
    return res.bytes;
  }

  async events(attemptId: string, body: unknown): Promise<void> {
    const res = await this.request(`/runner/v1/attempts/${attemptId}/events`, body);
    if (res.status !== 200) throw new GovernorProtocolError("events", res.status, res.json);
  }

  async renew(attemptId: string, leaseId: string, jobFence: number): Promise<{ leaseExpiresAt?: string }> {
    return this.expect("renew", await this.request(`/runner/v1/attempts/${attemptId}/renew`, { leaseId, jobFence }), 200);
  }

  async permit(attemptId: string, body: unknown): Promise<{ token: string; permitId: string; invocationId?: string }> {
    return this.expect("effect permit", await this.request(`/runner/v1/attempts/${attemptId}/permit`, body), 200);
  }

  /** Broker-boundary re-check: any non-OK answer means not valid. */
  async validatePermit(token: string, invocationId: string): Promise<boolean> {
    const res = await this.request("/runner/v1/permits/validate", { token, invocationId });
    return res.status === 200 && (res.json as { valid?: boolean }).valid === true;
  }

  // --- pinned release assets ----------------------------------------------

  /** Fetches an agent's instructions and verifies the release identity and
   * the instruction digest against the offer's pinned agent digest. */
  async agentInstructions(configDigest: string, agentId: string, expectedAgentDigest: string): Promise<AgentInstructions> {
    const res = await this.request(`/runner/v1/releases/${encodeURIComponent(configDigest)}/agents/${encodeURIComponent(agentId)}/instructions`);
    if (res.status !== 200) throw new GovernorProtocolError("agent instruction fetch", res.status, res.json);
    const asset = res.json as { agent: Agent; agentDigest: string; path: string; instructionsDigest: string; bytesBase64: string; toolBindings: EngineToolBinding[] };
    if (asset.agentDigest !== expectedAgentDigest || asset.agent.metadata.id !== agentId || asset.path !== asset.agent.spec.instructionsPath) {
      throw new Error("agent release identity does not match the job offer");
    }
    const bytes = new Uint8Array(Buffer.from(asset.bytesBase64, "base64"));
    if (sha256Digest(bytes) !== asset.instructionsDigest) throw new Error("agent instruction digest mismatch");
    return { agent: asset.agent, toolBindings: asset.toolBindings, instructions: new TextDecoder().decode(bytes) };
  }

  /** Fetches a pinned tool script and verifies it against the offer pin. */
  async toolScript(configDigest: string, toolId: string, expectedDigest: string): Promise<ToolScript> {
    const res = await this.request(`/runner/v1/releases/${encodeURIComponent(configDigest)}/tools/${encodeURIComponent(toolId)}`);
    if (res.status !== 200) throw new GovernorProtocolError("tool script fetch", res.status, res.json);
    const body = res.json as { entrypoint: string; entrypointDigest: string; bytesBase64: string };
    if (body.entrypointDigest !== expectedDigest) throw new Error("release tool digest disagrees with the offer pin");
    return { entrypoint: body.entrypoint, bytes: new Uint8Array(Buffer.from(body.bytesBase64, "base64")) };
  }

  /** Asks the Governor for the data a governed read tool needs; scope is rechecked there and a refusal comes back as an HTTP error. */
  async toolRead(attemptId: string, request: { tool: { id: string; digest: string }; input: Record<string, unknown> }): Promise<unknown> {
    const res = await this.request(`/runner/v1/attempts/${encodeURIComponent(attemptId)}/tool-read`, request);
    if (res.status !== 200) throw new GovernorProtocolError("tool read", res.status, res.json);
    return (res.json as { data: unknown }).data;
  }

  // --- outputs -------------------------------------------------------------

  /** Uploads bytes as a CAS artifact; the digest is computed here so an
   * uploaded artifact is always self-consistent. */
  async uploadArtifact(attemptId: string, bytes: Uint8Array, mediaType: string): Promise<UploadedArtifact> {
    const res = await this.request(`/runner/v1/attempts/${attemptId}/artifacts`, {
      digest: sha256Digest(bytes), mediaType, bytesBase64: Buffer.from(bytes).toString("base64"),
    });
    return this.expect("attempt artifact upload", res, 201);
  }

  async complete(attemptId: string, body: unknown): Promise<void> {
    const res = await this.request(`/runner/v1/attempts/${attemptId}/complete`, body);
    if (res.status !== 200) throw new GovernorProtocolError("complete", res.status, res.json);
  }

  async submitEvidence(bundle: unknown): Promise<{ digest?: string }> {
    return this.expect("evidence submit", await this.request("/runner/v1/evidence", bundle), 201);
  }

  async submitVerdict(workspaceId: string, verdict: VerificationVerdict): Promise<void> {
    const res = await this.request("/runner/v1/verdicts", { workspaceId, verdict });
    if (res.status !== 200) throw new GovernorProtocolError("verdict not accepted", res.status, res.json);
  }
}
