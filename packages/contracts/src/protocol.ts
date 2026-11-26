import type { JsonSchema } from "./files";
import type { LimitHit } from "./limits";
import type { SignedRunReceipt } from "./run-receipt";
import type { ModelProvider } from "./engines";

/** Wire types between a runner and the Governor (docs/architecture.md section 6). */

export type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };
/** `sha256:<64 hex>`. */
export type Digest = string;

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
  /** What a script's result must fit; absent when the tool declares no outputs. */
  readonly outputSchema?: JsonSchema;
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
   * The commit to work on: the head commit of the pull request whose delivery started the goal, else the commit the first attempt of the
   * goal reported for this project (every task of one goal works on the same commit). Absent on the goal's first attempt: the branch head
   * is used and reported back with every call (`CallRequest.baseCommits`) and in `complete`.
   */
  readonly baseCommit?: string;
}
/** One recorded workspace-tool or Brain-tool call, as a checker is shown it. */
export interface OfferToolCall { readonly tool: string; readonly effect: Effect; readonly input: JsonValue; readonly output: JsonValue; readonly outcome: ToolOutcome }
/** What a workspace holds, by name and description; an agent also lists the Brain-run and workspace tools it has, so a planner gives a task to an agent that can do it. */
export interface CatalogEntry { readonly name: string; readonly description: string; readonly tools?: ReadonlyArray<string>; readonly writes?: boolean }
export interface JobOffer {
  readonly attemptId: string;
  readonly fence: number;
  readonly kind: AttemptKind;
  readonly workspaceId: string;
  readonly offerExpiresAt: number;
  /** `outputSchema`: for the work of a Play step that declares `outputs`, what its final answer must be. */
  readonly task: { readonly id: string; readonly title: string; readonly goal: string; readonly round: number; readonly findings: ReadonlyArray<string>; readonly outputSchema?: JsonSchema };
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
    readonly review?: ReadonlyArray<{ readonly attemptId: string; readonly agent: string; readonly result: string; readonly output?: JsonValue; readonly toolCalls: ReadonlyArray<OfferToolCall>; /** What the reviewed attempt changed, as a diff to read (the attempt's `working-copy.patch`). */ readonly diff?: BlobRef; /** The files the reviewed attempt kept as results (its `out/`), so a check can read what it checks. */ readonly files: ReadonlyArray<BlobRef & { readonly name: string }> }>;
  };
  readonly snapshotDigest: Digest;
  readonly agent: {
    readonly name: string;
    readonly promptDigest: Digest;
    readonly engines: ReadonlyArray<string>;
    readonly native: NativeLevel;
    /** The commands of the agent's own tools are given the gateway address and the attempt's token. */
    readonly modelInCommands: boolean;
    readonly limits: { readonly turns: number; readonly tokens: number; readonly spendMicroUsd: number };
    readonly tools: ReadonlyArray<string>;
  };
  readonly tools: ReadonlyArray<OfferTool>;
  readonly projects: ReadonlyArray<OfferProject>;
  /**
   * The state commits this attempt starts from, oldest first and each once: those of every task this one waits for, directly or through another,
   * then the task's own earlier attempt, if it has one. A `check` attempt is given, last, the state of the result it checks. Each names the attempt
   * that pushed it and its commit of each project. A commit holds what the ones before it did, so merging them in this order on each project's
   * base commit gives where the work starts. The runner fetches `refs/brain/<goal>/<commit>` from the store and refuses a ref that does not
   * point at the commit named here.
   */
  readonly inheritedStates: ReadonlyArray<{ readonly attemptId: string; readonly commits: Readonly<Record<string, string>> }>;
  /** The git store this attempt fetches those commits from and pushes its own to; absent when the Governor has none. */
  readonly store?: { readonly url: string; readonly token: string; readonly goalId: string };
  /** The model gateway, and the model routes the attempt may call: the agent's own model, or else the workspace's first of each API. The engine takes the one it speaks. */
  readonly model: { readonly gatewayUrl: string; readonly routes: ReadonlyArray<ModelRoute> };
  /** For `act`: the approved call to run, and nothing else. */
  readonly act?: { readonly callId: string; readonly approvalId: string; readonly tool: string; readonly input: JsonValue };
}

/** One model of the workspace, with its context window and the share of it at which a long conversation is compacted. */
export interface ModelRoute { readonly provider: ModelProvider; readonly route: string; readonly contextTokens: number; readonly compactAt: number }

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

/**
 * A call an attempt makes. `baseCommits` are the commits its working copy stands on, by project; a runner always sends them. `stateCommits` are the
 * commits of what it has changed so far, by project (only the projects that changed), already pushed to the git store: a runner sends them before a call
 * with an effect, and a pull request is opened from them.
 */
export interface CallRequest extends Fenced { readonly callId: string; readonly tool: string; readonly input: JsonValue; readonly baseCommits?: Readonly<Record<string, string>>; readonly stateCommits?: Readonly<Record<string, string>> }
/** Asks to run a workspace tool that has an effect. `approved` may run now; `pending` is polled on `approvals/:approvalId`. */
export type ToolCallRequest = CallRequest;
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";
export interface ToolCallResponse { readonly callId: string; readonly state: ApprovalState; readonly approvalId?: string; readonly reason?: string }
export interface ApprovalPollResponse { readonly state: ApprovalState; readonly reason?: string }

/**
 * Runs a Brain-run tool as the attempt. A tool with an effect may answer `pending` first, like `tool-call`; once its approval is
 * `approved`, the same request (same `callId`) is sent again and answers `done`. A repeated request never runs a call twice. For
 * `git.open-pr`, `baseCommits` says which commit the change was made on, also in a goal's first attempt, which has not reported one yet.
 */
export type BrainToolRequest = CallRequest;
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
  /** Set when a limit stopped the attempt (docs/model.md, Limits). A runner names the limit; the Governor fills in the value and the use. */
  readonly limit?: LimitHit | undefined;
}
export interface CompleteRequest extends Fenced {
  readonly outcome: "succeeded" | "failed" | "held";
  readonly result: string;
  readonly output?: JsonValue;
  readonly failure?: AttemptFailure;
  readonly usage: AttemptUsage;
  readonly engine: string;
  /**
   * What the working copy holds beside each project's base commit, as a diff to read: `git diff` of every project, uploaded through `artifacts`
   * with kind `patch` (name `working-copy.patch`). It is for people and never rebuilds work: the state commits do. Before a call with an effect
   * the runner uploads it again with the state it pushes; the newest upload of the attempt is the one an approval shows.
   */
  readonly workingCopy?: BlobRef;
  readonly baseCommits: Readonly<Record<string, string>>;
  /** The commit of each project the attempt pushed to the store (its whole state); empty when nothing differs from the base commits. */
  readonly stateCommits: Readonly<Record<string, string>>;
  readonly receipt: SignedRunReceipt;
}
export interface CompleteResponse { readonly accepted: true }
