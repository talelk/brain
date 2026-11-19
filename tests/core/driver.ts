import { createHash } from "node:crypto";
import {
  resultDigest, signReceipt,
  type ApprovalPollResponse, type AttemptEventBody, type AttemptFailure, type AttemptUsage, type BlobRef, type BrainToolResponse, type ClaimResponse, type CompleteRequest, type HeartbeatResponse, type HelloResponse,
  type JobOffer, type JsonValue, type LeaseResponse, type ModelTokenResponse, type ToolCallResponse, type ToolOutcome,
} from "@brain/contracts";
import { generateKeyPairSync, sign } from "node:crypto";
import { BASE_URL, type Harness } from "./harness";

/**
 * A scripted runner. It speaks the real `/runner/v1` protocol to the Governor of a harness (enrol, challenge, hello, claim, ack, events,
 * tool calls, completion with a signed receipt) and, in place of an engine, answers each attempt from the script the test gives for its agent.
 */
export interface Reply {
  readonly result?: string;
  readonly output?: JsonValue;
  readonly outcome?: CompleteRequest["outcome"];
  readonly failure?: AttemptFailure;
  readonly usage?: Partial<AttemptUsage>;
  /** The working-copy patch the attempt leaves, as `git diff --binary` text. */
  readonly patch?: string;
  /** Files the attempt keeps as results (its `out/`), by name. */
  readonly files?: Readonly<Record<string, string>>;
  readonly baseCommits?: Readonly<Record<string, string>>;
  /** The commit of each project the attempt pushed to the git store; by default a runner that left a patch is taken to have pushed one commit per project. */
  readonly stateCommits?: Readonly<Record<string, string>>;
}
/** What a script is given for one attempt: the offer, and the calls an engine's tools would make. */
export interface Turn {
  readonly offer: JobOffer;
  /** Calls a Brain-run tool. */
  brain(tool: string, input: JsonValue): Promise<BrainToolResponse>;
  /** Asks to run a workspace tool; when it may run at once and `output` is given, reports that it ran with that output. */
  tool(tool: string, input: JsonValue, output?: JsonValue): Promise<ToolCallResponse>;
  /** Reports how a workspace tool call ended. */
  ran(callId: string, outcome: ToolOutcome, output: JsonValue): Promise<void>;
  poll(approvalId: string): Promise<ApprovalPollResponse>;
  event(body: AttemptEventBody): Promise<void>;
  upload(name: string, content: string | Uint8Array, kind?: "patch" | "output" | "log"): Promise<BlobRef>;
  post<T>(route: string, body: object): Promise<T>;
}
export type Script = Record<string, (turn: Turn) => Reply | string | Promise<Reply | string>>;

export interface Driver {
  readonly runnerId: string;
  /** Replaces or adds scripts by agent name. */
  script(more: Script): void;
  claim(): Promise<JobOffer | null>;
  ack(offer: JobOffer): Promise<LeaseResponse>;
  /** Runs the script of an offer's agent and completes the attempt. */
  finish(offer: JobOffer): Promise<Response>;
  complete(offer: JobOffer, reply: Reply | string, fence?: number): Promise<Response>;
  /** Claims one attempt and runs it to its end. Null when the queue has nothing for this runner. */
  step(): Promise<JobOffer | null>;
  /** Runs attempts until the queue is empty; the offers, in order. */
  drain(): Promise<JobOffer[]>;
  heartbeat(running: readonly string[]): Promise<HeartbeatResponse>;
  /** Any request, with this runner's session. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export async function enrolRunner(harness: Harness, script: Script = {}, options: { capabilities?: string[]; engines?: string[]; name?: string } = {}): Promise<Driver> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const state = { capabilities: options.capabilities ?? ["bash", "python3", "curl", "native-tools"], engines: options.engines ?? ["fixture", "pi", "claude"], slots: 4, freeSlots: 4, version: "test" };
  const scripts = { ...script };
  let session = "";
  let runnerId = "";
  const hello = async (): Promise<void> => {
    const challenge = await post<{ challengeId: string; nonce: string }>("/runner/v1/challenge", { runnerId });
    session = (await post<HelloResponse>("/runner/v1/hello", { ...state, runnerId, challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.nonce), privateKey).toString("base64url") })).sessionToken;
  };
  const fetch = (path: string, init: RequestInit = {}): Promise<Response> =>
    Promise.resolve(harness.governor.app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(init.headers as Record<string, string> | undefined) } })));
  const post = async <T>(path: string, body: object): Promise<T> => {
    const send = (): Promise<Response> => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let response = await send();
    // A session that ran out is renewed the way a runner does it: a new challenge, signed with its key.
    if (response.status === 401 && session !== "" && !path.endsWith("/hello") && !path.endsWith("/challenge")) {
      await hello();
      response = await send();
    }
    if (!response.ok) throw Object.assign(new Error(`${path} answered ${response.status}: ${await response.clone().text()}`), { status: response.status, code: ((await response.json()) as { error?: { code?: string } }).error?.code });
    return (await response.json()) as T;
  };

  const { token } = await harness.admin.command("runner.token", { name: options.name ?? "test runner" });
  const enrolled = await post<{ runnerId: string }>("/runner/v1/enroll", { token, name: options.name ?? "test runner", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() });
  runnerId = enrolled.runnerId;
  await hello();

  const at = (offer: JobOffer, route: string): string => `/runner/v1/attempts/${offer.attemptId}/${route}`;
  const upload = async (offer: JobOffer, name: string, content: string | Uint8Array, kind: string): Promise<BlobRef> => {
    const response = await fetch(`${at(offer, "artifacts")}?${new URLSearchParams({ fence: String(offer.fence), name, kind, mediaType: kind === "patch" ? "text/x-diff" : "text/plain" })}`, { method: "POST", body: typeof content === "string" ? content : Buffer.from(content) });
    if (!response.ok) throw new Error(`upload answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as BlobRef;
  };

  const driver: Driver = {
    runnerId, fetch,
    script: (more) => void Object.assign(scripts, more),
    claim: async () => (await post<ClaimResponse>("/runner/v1/claim", { freeSlots: 1 })).offer,
    ack: (offer) => post<LeaseResponse>(at(offer, "ack"), { fence: offer.fence, engine: offer.agent.engines[0] ?? "fixture" }),
    heartbeat: (running) => post<HeartbeatResponse>("/runner/v1/heartbeat", { ...state, running }),
    async complete(offer, given, fence = offer.fence) {
      const reply: Reply = typeof given === "string" ? { result: given } : given;
      const result = reply.result ?? (reply.output !== undefined ? JSON.stringify(reply.output) : "");
      const output = reply.output ?? null;
      for (const [name, content] of Object.entries(reply.files ?? {})) await upload(offer, name, content, "output");
      const workingCopy = reply.patch !== undefined ? await upload(offer, "working-copy.patch", reply.patch, "patch") : undefined;
      const receipt = { attemptId: offer.attemptId, fence, snapshotDigest: offer.snapshotDigest, resultDigest: resultDigest(result, output) };
      const body: CompleteRequest = {
        fence, outcome: reply.outcome ?? "succeeded", result, ...(reply.output !== undefined ? { output: reply.output } : {}), ...(reply.failure ? { failure: reply.failure } : {}),
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microUsd: 0, ...reply.usage }, engine: offer.agent.engines[0] ?? "fixture", ...(workingCopy ? { workingCopy } : {}),
        baseCommits: reply.baseCommits ?? {},
        // A runner that left a patch also pushed its state to the git store: one commit per project.
        stateCommits: reply.stateCommits ?? (workingCopy ? Object.fromEntries(offer.projects.map((project) => [project.name, createHash("sha1").update(`${offer.attemptId}:${project.name}`).digest("hex")])) : {}),
        receipt: { receipt, signature: signReceipt(receipt, privateKeyPem) },
      };
      return fetch(at(offer, "complete"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
    async finish(offer) {
      const run = scripts[offer.agent.name];
      if (!run) throw new Error(`the test has no script for the agent ${offer.agent.name} (${offer.kind} attempt of "${offer.task.title}")`);
      let seq = 0;
      let calls = 0;
      const event = async (body: AttemptEventBody): Promise<void> => void (await post(at(offer, "events"), { fence: offer.fence, events: [{ ...body, seq: (seq += 1), at: Date.now() }] }));
      const turn: Turn = {
        offer, event,
        post: (route, body) => post(at(offer, route), { fence: offer.fence, ...body }),
        brain: (tool, input) => post<BrainToolResponse>(at(offer, "brain-tool"), { fence: offer.fence, callId: `call-${(calls += 1)}`, tool, input }),
        ran: (callId, outcome, output) => event({ kind: "tool.result", callId, outcome, output }),
        async tool(tool, input, output) {
          const asked = await post<ToolCallResponse>(at(offer, "tool-call"), { fence: offer.fence, callId: `call-${(calls += 1)}`, tool, input });
          if (asked.state === "approved" && output !== undefined) await turn.ran(asked.callId, "succeeded", output);
          return asked;
        },
        poll: async (approvalId) => (await (await fetch(`${at(offer, `approvals/${approvalId}`)}?fence=${offer.fence}`)).json()) as ApprovalPollResponse,
        upload: (name, content, kind = "output") => upload(offer, name, content, kind),
      };
      const response = await driver.complete(offer, await run(turn));
      if (!response.ok) throw new Error(`complete answered ${response.status}: ${await response.text()}`);
      return response;
    },
    async step() {
      const offer = await driver.claim();
      if (!offer) return null;
      await driver.ack(offer);
      await driver.finish(offer);
      return offer;
    },
    async drain() {
      const offers: JobOffer[] = [];
      for (let offer = await driver.step(); offer; offer = await driver.step()) {
        offers.push(offer);
        if (offers.length > 200) throw new Error("more than 200 attempts ran: the work does not come to rest");
      }
      return offers;
    },
  };
  return driver;
}

/** A model token for an offer, as an engine would ask for one. */
export const modelTokenOf = async (driver: Driver, offer: JobOffer): Promise<string> =>
  ((await (await driver.fetch(`/runner/v1/attempts/${offer.attemptId}/model-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fence: offer.fence }) })).json()) as ModelTokenResponse).token;
