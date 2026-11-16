import type { JsonSchema } from "./files";
import type { SignedRunReceipt } from "./run-receipt";

/** Wire types between a runner and the Governor (docs/architecture.md section 6), and the engine-facing types the runner's adapters use. */

export type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };
/** `sha256:<64 hex>`. */
export type Digest = string;

// --- Engine side: what an engine adapter (ports.ts) is given and what it reports ---

export interface ReleaseRef { readonly id: string; readonly digest: Digest }
export interface Target { readonly targetId: string; readonly environmentId: string; readonly preconditionDigest: Digest }
export interface ArtifactRef {
  readonly artifactId: string;
  readonly digest: Digest;
  readonly bytes: number;
  readonly mediaType: string;
  readonly classification: "public" | "internal" | "confidential" | "restricted";
}
export interface EngineInfo { readonly id: string; readonly version?: string; readonly adapterDigest: Digest; readonly features: ReadonlyArray<string> }
export interface EngineSessionSpec {
  readonly contractVersion: "brain.engine/v1";
  readonly jobId: string;
  readonly attemptId: string;
  readonly engine: EngineInfo;
  readonly modelId: string;
  readonly instructions: string;
  readonly instructionsDigest: Digest;
  readonly task: string;
  readonly sourceRevision: string;
  readonly allowedTools: ReadonlyArray<ReleaseRef>;
  readonly context: ArtifactRef;
  readonly resumeFrom?: ArtifactRef;
  readonly limits: { readonly timeoutMs: number; readonly maxTokens: number; readonly maxMicroUsd: number; readonly maxTurns: number };
}
export interface ExternalEffect {
  readonly invocationId: string;
  readonly targetId: string;
  readonly operation: string;
  readonly outcome: "applied" | "absent" | "conflicting" | "unknown";
  readonly receiptArtifact: ArtifactRef;
}
export interface ToolReceipt {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly jobFence: number;
  readonly result: "succeeded" | "failed" | "partial" | "unknown";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly stdout?: ArtifactRef;
  readonly stderr?: ArtifactRef;
  readonly effects: ReadonlyArray<ExternalEffect>;
}
export interface EngineError { readonly code: string; readonly detail: string; readonly retryable: boolean; readonly correlationId: string }
interface EngineEventPayloads {
  "session.started": { readonly engine: EngineInfo; readonly resumedFrom?: Digest };
  "session.stopped": { readonly reason: "completed" | "cancelled" | "budget" | "timeout" | "error"; readonly terminationConfirmed: boolean; readonly output?: ArtifactRef };
  text: { readonly text: string; readonly channel: "assistant" | "diagnostic"; readonly provisional: true };
  "tool.proposed": { readonly proposalId: string; readonly tool: ReleaseRef; readonly input: JsonValue; readonly target: Target; readonly inputDigest: Digest };
  "tool.result": { readonly proposalId: string; readonly invocationId: string; readonly receipt: ToolReceipt };
  usage: { readonly usageId: string; readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number; readonly microUsd: number; readonly accounting: "delta" | "final-total"; readonly estimated: boolean };
  artifact: { readonly artifact: ArtifactRef; readonly purpose: "output" | "checkpoint" | "diagnostic" | "evidence" };
  "human.input.requested": { readonly requestId: string; readonly prompt: string; readonly expiresAt: string; readonly choices: ReadonlyArray<string> };
  error: { readonly error: EngineError; readonly phase: "probe" | "start" | "stream" | "tool" | "cancel" | "checkpoint" | "resume"; readonly retryClass: "safe-read" | "new-attempt" | "never" | "reconcile" };
}
export type EngineEvent = {
  [K in keyof EngineEventPayloads]: {
    readonly contractVersion: "brain.engine-event/v1";
    readonly eventId: string;
    readonly sessionId: string;
    readonly attemptId: string;
    readonly sequence: number;
    readonly occurredAt: string;
    readonly kind: K;
    readonly payload: EngineEventPayloads[K];
  };
}[keyof EngineEventPayloads];
export interface Checkpoint {
  readonly contractVersion: "brain.checkpoint/v2";
  readonly attemptId?: string;
  readonly sourceRevision: string;
  readonly engineState?: ArtifactRef;
  readonly completedCriteria: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<string>;
  readonly eventSequence: number;
  readonly ownedResources?: ReadonlyArray<string>;
  readonly nextAction: string;
  readonly createdAt: string;
}

// --- Runner routes, all under /runner/v1. `:id` is an attempt id. ---

export const RUNNER_ROUTES = {
  enroll: "/runner/v1/enroll",
  challenge: "/runner/v1/challenge",
  hello: "/runner/v1/hello",
  heartbeat: "/runner/v1/heartbeat",
  claim: "/runner/v1/claim",
  ack: "/runner/v1/attempts/:id/ack",
  renew: "/runner/v1/attempts/:id/renew",
  events: "/runner/v1/attempts/:id/events",
  artifacts: "/runner/v1/attempts/:id/artifacts",
  toolCall: "/runner/v1/attempts/:id/tool-call",
  approval: "/runner/v1/attempts/:id/approvals/:approvalId",
  brainTool: "/runner/v1/attempts/:id/brain-tool",
  secret: "/runner/v1/attempts/:id/secret",
  modelToken: "/runner/v1/attempts/:id/model-token",
  complete: "/runner/v1/attempts/:id/complete",
  blob: "/runner/v1/blobs/:digest",
} as const;

export type AttemptKind = "work" | "plan" | "check" | "judge" | "act";
export type Effect = "read" | "write" | "privileged";
export type NativeLevel = "none" | "read" | "all";
/** A plain name the runner's operator declares (`bash`, `python3`, `curl`, `docker`), plus `native-tools` when engines run sandboxed. A tool's `needs` are matched against them. */
export type RunnerCapability = string;

/** Enrolment: a one-use token and the runner's ed25519 public key, then a challenge the runner signs with that key. */
export interface EnrollRequest { readonly token: string; readonly name: string; readonly publicKeyPem: string }
export interface EnrollResponse { readonly runnerId: string }
export interface ChallengeRequest { readonly runnerId: string }
export interface ChallengeResponse { readonly challengeId: string; readonly nonce: string; readonly expiresAt: number }

export interface RunnerState {
  readonly capabilities: ReadonlyArray<RunnerCapability>;
  readonly engines: ReadonlyArray<string>;
  readonly slots: number;
  readonly freeSlots: number;
  readonly version: string;
}
/** `signature` is the challenge nonce signed with the enrolled key (base64url). The answer is the bearer token of every later call. */
export interface HelloRequest extends RunnerState { readonly runnerId: string; readonly challengeId: string; readonly signature: string }
export interface HelloResponse { readonly sessionToken: string; readonly expiresAt: number; readonly heartbeatMs: number }
export interface HeartbeatRequest extends RunnerState { readonly running: ReadonlyArray<string> }
/** `stop` names the running attempts the Governor no longer wants (the task was stopped, or the lease moved). */
export interface HeartbeatResponse { readonly stop: ReadonlyArray<string> }

export interface ClaimRequest { readonly freeSlots: number }
export interface ClaimResponse { readonly offer: JobOffer | null }

export interface BlobRef { readonly digest: Digest; readonly bytes: number }
export interface OfferFile extends BlobRef { readonly path: string }
export interface OfferTool {
  readonly name: string;
  readonly description: string;
  readonly effect: Effect;
  readonly inputSchema: JsonSchema;
  /** `run.sh` and the files beside it, fetched from `blobs/:digest`. Empty for a Brain-run or host-command tool. */
  readonly files: ReadonlyArray<OfferFile>;
  readonly network: ReadonlyArray<string>;
  readonly secrets: ReadonlyArray<string>;
  readonly needs: ReadonlyArray<string>;
  readonly timeoutSeconds: number;
  readonly runs?: "brain";
  readonly hostCommand?: string;
}
export interface OfferProject {
  readonly name: string;
  readonly repo: string;
  readonly branch: string;
  readonly access: "read" | "write";
  readonly setup?: string;
  readonly network: ReadonlyArray<string>;
  /** The name of the secret to lease for fetching; absent for a public repository. */
  readonly credential?: string;
  /**
   * The commit to work on. Set to the commit an earlier attempt of this task worked on, and on a first attempt when the task was started by
   * a pull request delivery (that pull request's head commit). Absent otherwise: the branch head is used and reported back in `complete`.
   */
  readonly baseCommit?: string;
}
/** One recorded workspace-tool or Brain-tool call, as a checker is shown it. */
export interface OfferToolCall { readonly tool: string; readonly effect: Effect; readonly input: JsonValue; readonly output: JsonValue; readonly outcome: ToolOutcome }
export interface CatalogEntry { readonly name: string; readonly description: string }
export interface JobOffer {
  readonly attemptId: string;
  readonly fence: number;
  readonly kind: AttemptKind;
  readonly workspaceId: string;
  readonly offerExpiresAt: number;
  readonly task: { readonly id: string; readonly title: string; readonly goal: string; readonly round: number; readonly findings: ReadonlyArray<string> };
  readonly context: {
    /** Results of the tasks this one waits for. */
    readonly results: ReadonlyArray<{ readonly taskId: string; readonly title: string; readonly result: string; readonly output?: JsonValue }>;
    /** The shared board of the root task. */
    readonly notes: ReadonlyArray<{ readonly author: string; readonly text: string; readonly at: number }>;
    /** Answers people gave to this task's `task.ask` questions, oldest first. */
    readonly answers: ReadonlyArray<{ readonly question: string; readonly answer: string; readonly by: string; readonly at: number }>;
    /** What the workspace holds, by name and description. A planner assigns sub-tasks to `catalog.agents`. */
    readonly catalog: { readonly agents: ReadonlyArray<CatalogEntry>; readonly tools: ReadonlyArray<CatalogEntry>; readonly plays: ReadonlyArray<CatalogEntry> };
    /** For `check`: what is checked. For `judge`: one entry per candidate. */
    readonly review?: ReadonlyArray<{ readonly attemptId: string; readonly agent: string; readonly result: string; readonly output?: JsonValue; readonly toolCalls: ReadonlyArray<OfferToolCall>; readonly patch?: BlobRef }>;
  };
  readonly snapshotDigest: Digest;
  readonly agent: {
    readonly name: string;
    readonly promptDigest: Digest;
    readonly engines: ReadonlyArray<string>;
    readonly native: NativeLevel;
    readonly limits: { readonly turns: number; readonly tokens: number; readonly spendMicroUsd: number };
    readonly tools: ReadonlyArray<string>;
  };
  readonly tools: ReadonlyArray<OfferTool>;
  readonly projects: ReadonlyArray<OfferProject>;
  /** The working-copy patches of the tasks this one waits for, in the order to apply them on each project's base commit. */
  readonly inheritedPatches: ReadonlyArray<BlobRef>;
  /** The patch an earlier attempt of this task left, applied after `inheritedPatches`. */
  readonly workingCopy?: BlobRef;
  readonly model: { readonly gatewayUrl: string; readonly route: string };
  /** For `act`: the approved call to run, and nothing else. */
  readonly act?: { readonly callId: string; readonly approvalId: string; readonly tool: string; readonly input: JsonValue };
}

/** Every attempt-scoped request names the fence it was offered; a moved fence answers LEASE_LOST. */
export interface Fenced { readonly fence: number }
export interface AckRequest extends Fenced { readonly engine: string }
export interface LeaseResponse { readonly leaseExpiresAt: number; readonly stop: boolean }

export type ToolOutcome = "succeeded" | "failed" | "held" | "rejected";
export type AttemptEventBody =
  | { readonly kind: "status"; readonly phase: "setup" | "engine" | "upload"; readonly detail: string }
  | { readonly kind: "text"; readonly channel: "assistant" | "diagnostic"; readonly text: string }
  | { readonly kind: "native.call"; readonly callId: string; readonly name: string; readonly input: JsonValue }
  | { readonly kind: "native.result"; readonly callId: string; readonly ok: boolean; readonly output: string }
  | { readonly kind: "tool.call"; readonly callId: string; readonly tool: string; readonly effect: Effect; readonly input: JsonValue }
  | { readonly kind: "tool.result"; readonly callId: string; readonly outcome: ToolOutcome; readonly output: JsonValue }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number; readonly microUsd: number };
export type AttemptEvent = AttemptEventBody & { readonly seq: number; readonly at: number };
export interface EventsRequest extends Fenced { readonly events: ReadonlyArray<AttemptEvent> }
export interface EventsResponse { readonly through: number }

/** `POST artifacts?fence=&name=&kind=&mediaType=` with the bytes as the body. */
export interface ArtifactUpload extends Fenced { readonly name: string; readonly kind: "patch" | "output" | "log"; readonly mediaType: string }
export type ArtifactUploadResponse = BlobRef;

/** Asks to run a workspace tool that has an effect. `approved` may run now; `pending` is polled on `approvals/:approvalId`. */
export interface ToolCallRequest extends Fenced { readonly callId: string; readonly tool: string; readonly input: JsonValue }
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";
export interface ToolCallResponse { readonly callId: string; readonly state: ApprovalState; readonly approvalId?: string; readonly reason?: string }
export interface ApprovalPollResponse { readonly state: ApprovalState; readonly reason?: string }

/** Runs a Brain-run tool as the attempt. A tool with an effect may answer `pending` first, like `tool-call`. */
export interface BrainToolRequest extends Fenced { readonly callId: string; readonly tool: string; readonly input: JsonValue }
export type BrainToolResponse =
  | { readonly state: "done"; readonly output: JsonValue }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "pending"; readonly approvalId: string }
  | { readonly state: "rejected"; readonly reason: string };

/** Leases one named secret: for a tool that declares it, or as the credential of a project. */
export interface SecretRequest extends Fenced { readonly name: string; readonly use: { readonly tool: string } | { readonly project: string } }
export interface SecretResponse { readonly value: string }
export type ModelTokenRequest = Fenced;
export interface ModelTokenResponse { readonly token: string; readonly expiresAt: number }

export interface AttemptUsage { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number; readonly microUsd: number }
export interface AttemptFailure {
  readonly reason: "engine" | "model-refused" | "setup" | "timeout" | "limit" | "stopped" | "runner";
  readonly detail: string;
  /** True when the attempt may be retried as it is (nothing about the task or the agent caused it). */
  readonly infrastructure: boolean;
}
export interface CompleteRequest extends Fenced {
  readonly outcome: "succeeded" | "failed" | "held";
  readonly result: string;
  readonly output?: JsonValue;
  readonly failure?: AttemptFailure;
  readonly usage: AttemptUsage;
  readonly engine: string;
  /** `git diff` of every project against its base commit, uploaded through `artifacts` with kind `patch`. */
  readonly workingCopy?: BlobRef;
  readonly baseCommits: Readonly<Record<string, string>>;
  readonly receipt: SignedRunReceipt;
}
export interface CompleteResponse { readonly accepted: true }
