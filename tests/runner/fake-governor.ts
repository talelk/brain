import { createPublicKey, randomUUID, verify } from "node:crypto";
import { ERROR_STATUS, receiptSignatureOk, resultDigest, sha256Digest } from "@brain/contracts";
import { testStore } from "./store";
import type {
  ApprovalPollResponse, AttemptEvent, BlobRef, BrainToolRequest, BrainToolResponse, CompleteRequest, Digest, ErrorCode, HeartbeatRequest, HelloRequest, JobOffer, OfferTool,
  SecretRequest, ToolCallRequest, ToolCallResponse,
} from "@brain/contracts";

/**
 * A Governor for the runner's tests: the `/runner/v1` routes of protocol.ts answered from memory, behind a `fetch` the runner is given
 * as its transport. It checks what a real Governor checks of a runner (the one-use token, the signed challenge, the bearer token, the
 * fence, the receipt) and keeps what the runner sent, so a test can read it back.
 */
export interface StoredArtifact { readonly attemptId: string; readonly name: string; readonly kind: string; readonly mediaType: string; readonly bytes: Uint8Array; readonly digest: Digest }

const store = await testStore();

class Refusal extends Error { constructor(readonly code: ErrorCode, message: string) { super(message); } }

let worlds = 0;

export class FakeGovernor {
  /** The goal of every attempt of this Governor: refs of the git store are `refs/brain/<goal>/<attempt>`, written once, and the store outlives the test. */
  readonly goal = `goal-${++worlds}`;
  readonly url = "http://governor.test";
  readonly enrollToken = "enroll-once";
  readonly blobs = new Map<Digest, Uint8Array>();
  readonly queue: JobOffer[] = [];
  readonly events = new Map<string, AttemptEvent[]>();
  readonly artifacts: StoredArtifact[] = [];
  readonly completions = new Map<string, CompleteRequest>();
  readonly acks = new Map<string, string>();
  readonly approvals = new Map<string, ApprovalPollResponse>();
  readonly toolCalls: ToolCallRequest[] = [];
  readonly brainCalls: BrainToolRequest[] = [];
  readonly secretRequests: SecretRequest[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  readonly hellos: HelloRequest[] = [];
  /** The digest of every blob the runner asked for, in order. */
  readonly blobFetches: string[] = [];
  readonly secrets: Record<string, string> = {};
  /** Attempts the next heartbeat tells the runner to stop. */
  stop: string[] = [];
  /** Attempts whose fence has moved: every request about them answers LEASE_LOST. */
  readonly fenced = new Set<string>();
  /** How a call with an effect is answered; approved at once unless a test says otherwise. */
  onToolCall: (request: ToolCallRequest) => ToolCallResponse = (request) => ({ callId: request.callId, state: "approved" });
  onBrainTool: (request: BrainToolRequest) => BrainToolResponse = () => ({ state: "done", output: { ok: true } });
  private readonly runners = new Map<string, string>();
  private readonly challenges = new Map<string, { runnerId: string; nonce: string }>();
  private readonly sessions = new Set<string>();
  private tokenUsed = false;
  private attempts = 0;

  /** Stores bytes as a blob and returns its reference. */
  blob(content: string | Uint8Array): BlobRef {
    const bytes = typeof content === "string" ? new Uint8Array(Buffer.from(content)) : content;
    const digest = sha256Digest(bytes);
    this.blobs.set(digest, bytes);
    return { digest, bytes: bytes.length };
  }

  /** A tool of an offer: a script tool when it has files, else whatever the overrides make it. */
  tool(name: string, overrides: Partial<OfferTool> & { script?: string } = {}): OfferTool {
    const { script, ...rest } = overrides;
    return {
      name, description: `The ${name} tool.`, effect: "read", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      files: script === undefined ? [] : [{ path: "run.sh", ...this.blob(script) }], network: [], secrets: [], needs: [], timeoutSeconds: 30, ...rest,
    };
  }

  /** Queues an offer; anything not given has a plain default. `prompt` is the agent's prompt text. */
  offer(overrides: Partial<Omit<JobOffer, "agent" | "task" | "context">> & { prompt?: string; agent?: Partial<JobOffer["agent"]>; task?: Partial<JobOffer["task"]>; context?: Partial<JobOffer["context"]> } = {}): JobOffer {
    const { prompt = "# Agent\nYou do the work.", agent, task, context, ...rest } = overrides;
    const tools = rest.tools ?? [];
    const offer: JobOffer = {
      attemptId: `attempt-${++this.attempts}`, fence: 1, kind: "work", workspaceId: "ws1", offerExpiresAt: Date.now() + 60_000, snapshotDigest: sha256Digest(new Uint8Array(Buffer.from("snapshot"))),
      task: { id: "task-1", title: "The task", goal: "Do the thing.", round: 1, findings: [], ...task },
      context: { results: [], notes: [], answers: [], catalog: { agents: [], tools: [], plays: [] }, ...context },
      agent: { name: "worker", promptDigest: this.blob(prompt).digest, engines: ["fixture"], native: "none", limits: { turns: 20, tokens: 200_000, spendMicroUsd: 0 }, tools: tools.map((tool) => tool.name), ...agent },
      tools, projects: [], inheritedStates: [], model: { gatewayUrl: `${this.url}/model/v1`, route: "main", contextTokens: 200_000, compactAt: 0.7 },
      ...rest,
    };
    // An attempt on a project hands its work on through the git store, a real one.
    if (offer.projects.length > 0 && !offer.store) Object.assign(offer, { store: store.offer(offer.workspaceId, this.goal, offer.attemptId) });
    this.queue.push(offer);
    return offer;
  }

  /** The events of an attempt, in order, optionally of one kind. */
  eventsOf<K extends AttemptEvent["kind"]>(attemptId: string, kind?: K): Array<Extract<AttemptEvent, { kind: K }>> {
    return (this.events.get(attemptId) ?? []).filter((event): event is Extract<AttemptEvent, { kind: K }> => kind === undefined || event.kind === kind);
  }

  readonly transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const answer = (status: number, value: unknown): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    try {
      return await this.route(url, init ?? {}, answer);
    } catch (error) {
      if (error instanceof Refusal) return answer(ERROR_STATUS[error.code], { error: { code: error.code, message: error.message } });
      throw error;
    }
  };

  private async route(url: URL, init: RequestInit, answer: (status: number, value: unknown) => Response): Promise<Response> {
    const path = url.pathname.replace("/runner/v1/", "").split("/").map(decodeURIComponent);
    const json = <T>(): T => JSON.parse(String(init.body ?? "{}")) as T;
    if (path[0] === "enroll") {
      const body = json<{ token: string; name: string; publicKeyPem: string }>();
      if (body.token !== this.enrollToken || this.tokenUsed) throw new Refusal("FORBIDDEN", "the enrolment token is not valid");
      this.tokenUsed = true;
      const runnerId = `runner-${randomUUID().slice(0, 8)}`;
      this.runners.set(runnerId, body.publicKeyPem);
      return answer(200, { runnerId });
    }
    if (path[0] === "challenge") {
      const { runnerId } = json<{ runnerId: string }>();
      if (!this.runners.has(runnerId)) throw new Refusal("NOT_FOUND", "no such runner");
      const challengeId = randomUUID();
      const nonce = randomUUID();
      this.challenges.set(challengeId, { runnerId, nonce });
      return answer(200, { challengeId, nonce, expiresAt: Date.now() + 60_000 });
    }
    if (path[0] === "hello") {
      const body = json<HelloRequest>();
      const challenge = this.challenges.get(body.challengeId);
      this.challenges.delete(body.challengeId);
      const key = this.runners.get(body.runnerId);
      if (!challenge || !key || challenge.runnerId !== body.runnerId || !verify(null, Buffer.from(challenge.nonce), createPublicKey(key), Buffer.from(body.signature, "base64url"))) throw new Refusal("UNAUTHENTICATED", "the challenge was not signed with the enrolled key");
      this.hellos.push(body);
      const sessionToken = `session-${randomUUID()}`;
      this.sessions.add(sessionToken);
      return answer(200, { sessionToken, expiresAt: Date.now() + 15 * 60_000, heartbeatMs: 15_000 });
    }
    const bearer = /^Bearer (.+)$/u.exec(new Headers(init.headers).get("authorization") ?? "")?.[1];
    if (!bearer || !this.sessions.has(bearer)) throw new Refusal("UNAUTHENTICATED", "say hello first");
    if (path[0] === "heartbeat") { this.heartbeats.push(json<HeartbeatRequest>()); const stop = this.stop; this.stop = []; return answer(200, { stop }); }
    if (path[0] === "claim") return answer(200, { offer: this.queue.shift() ?? null });
    if (path[0] === "blobs") {
      this.blobFetches.push(path[1] ?? "");
      const bytes = this.blobs.get(path[1] ?? "");
      if (!bytes) throw new Refusal("NOT_FOUND", "no such blob");
      return new Response(bytes as BodyInit, { status: 200 });
    }
    if (path[0] !== "attempts") throw new Refusal("NOT_FOUND", "no such route");
    const attemptId = path[1] ?? "";
    const action = path[2];
    const fence = init.method === "GET" || action === "artifacts" ? Number(url.searchParams.get("fence")) : json<{ fence: number }>().fence;
    if (this.fenced.has(attemptId) || fence !== 1) throw new Refusal("LEASE_LOST", "the fence moved");
    const lease = { leaseExpiresAt: Date.now() + 60_000, stop: false };
    switch (action) {
      case "ack": this.acks.set(attemptId, json<{ engine: string }>().engine); return answer(200, lease);
      case "renew": return answer(200, lease);
      case "events": {
        const { events } = json<{ events: AttemptEvent[] }>();
        const stored = this.events.get(attemptId) ?? [];
        this.events.set(attemptId, [...stored, ...events.filter((event) => !stored.some((known) => known.seq === event.seq))]);
        return answer(200, { through: events.at(-1)?.seq ?? 0 });
      }
      case "artifacts": {
        const bytes = new Uint8Array(init.body as Uint8Array);
        const digest = sha256Digest(bytes);
        this.blobs.set(digest, bytes);
        this.artifacts.push({ attemptId, name: url.searchParams.get("name") ?? "", kind: url.searchParams.get("kind") ?? "", mediaType: url.searchParams.get("mediaType") ?? "", bytes, digest });
        return answer(200, { digest, bytes: bytes.length });
      }
      case "tool-call": { const request = json<ToolCallRequest>(); this.toolCalls.push(request); return answer(200, this.onToolCall(request)); }
      case "approvals": return answer(200, this.approvals.get(path[3] ?? "") ?? { state: "pending" });
      case "brain-tool": { const request = json<BrainToolRequest>(); this.brainCalls.push(request); return answer(200, this.onBrainTool(request)); }
      case "secret": {
        const request = json<SecretRequest>();
        this.secretRequests.push(request);
        const value = this.secrets[request.name];
        if (value === undefined) throw new Refusal("FORBIDDEN", "this secret is not for this attempt");
        return answer(200, { value });
      }
      case "model-token": return answer(200, { token: `model-token-${attemptId}`, expiresAt: Date.now() + 60 * 60_000 });
      case "complete": {
        const request = json<CompleteRequest>();
        const { receipt, signature } = request.receipt;
        const key = this.runners.values().next().value as string;
        if (receipt.attemptId !== attemptId || receipt.fence !== fence || receipt.resultDigest !== resultDigest(request.result, request.output ?? null) || !receiptSignatureOk(receipt, signature, key)) throw new Refusal("FORBIDDEN", "the receipt does not match the completion or is not signed by this runner");
        this.completions.set(attemptId, request);
        return answer(200, { accepted: true });
      }
      default: throw new Refusal("NOT_FOUND", "no such route");
    }
  }
}
