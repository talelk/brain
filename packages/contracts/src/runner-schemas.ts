import { z } from "zod";
import { isDigest } from "./hash";
import { LIMIT_NAMES } from "./limits";
import type {
  AckRequest, ArtifactUpload, AttemptEvent, BlobRef, CallRequest, ChallengeRequest, ClaimRequest, CompleteRequest, EnrollRequest, EventsRequest, Fenced, HeartbeatRequest, HelloRequest, SecretRequest,
  JsonValue,
} from "./protocol";
import type { SignedRunReceipt } from "./run-receipt";

/**
 * What the Governor takes from a runner, one schema for each request of `protocol.ts` (docs/architecture.md section 6). Each is checked
 * against its type: a field added to one and not to the other does not compile.
 */

/** The type as a schema gives it: a field that may be left out may also be there and undefined. Any JSON value is left as it is. */
type Given<T> = [JsonValue] extends [T] ? T | undefined : T extends ReadonlyArray<infer U> ? ReadonlyArray<Given<U>> : T extends object ? { [K in keyof T]: Partial<Pick<T, K>> extends Pick<T, K> ? Given<T[K]> | undefined : Given<T[K]> } : T;
/** The schema's output is the type, and the two have the same keys: the output being assignable alone would let an optional field be missing. */
type Fields<T> = T extends unknown ? keyof T : never;
type SameFields<S extends z.ZodType, T> = [Fields<z.output<S>>] extends [Fields<T>] ? [Fields<T>] extends [Fields<z.output<S>>] ? S : never : never;
const wire = <T>() => <S extends z.ZodType<Given<T>>>(schema: S & SameFields<S, T>): S => schema;

const fence = z.int().min(0);
const text = z.string().max(2_000_000);
const count = z.int().min(0);
const names = z.array(z.string().min(1).max(100)).max(100);
const state = { capabilities: names, engines: names, slots: z.int().min(0).max(1000), freeSlots: z.int().min(0).max(1000), version: z.string().max(100) };
const commits = z.record(z.string(), z.string().max(100));
const stateIds = z.record(z.string(), z.string().regex(/^[0-9a-f]{40,64}$/u));

const seen = { seq: count, at: z.number() };
const event = z.discriminatedUnion("kind", [
  z.object({ ...seen, kind: z.literal("status"), phase: z.enum(["setup", "engine", "upload"]), detail: text }),
  z.object({ ...seen, kind: z.literal("text"), channel: z.enum(["assistant", "diagnostic"]), text }),
  z.object({ ...seen, kind: z.literal("native.call"), callId: z.string().max(200), name: z.string().max(200), input: z.json() }),
  z.object({ ...seen, kind: z.literal("native.result"), callId: z.string().max(200), ok: z.boolean(), output: text }),
  z.object({ ...seen, kind: z.literal("tool.call"), callId: z.string().max(100), tool: z.string().max(100), effect: z.enum(["read", "write", "privileged"]), input: z.json() }),
  z.object({ ...seen, kind: z.literal("tool.result"), callId: z.string().max(100), outcome: z.enum(["succeeded", "failed", "held", "rejected"]), output: z.json() }),
  z.object({ ...seen, kind: z.literal("usage"), inputTokens: count, outputTokens: count, cachedInputTokens: count, microUsd: count }),
]);
const usage = z.strictObject({ inputTokens: count, outputTokens: count, cachedInputTokens: count, microUsd: count });
const blobRef = wire<BlobRef>()(z.strictObject({ digest: z.string().refine(isDigest), bytes: count }));
const limit = z.strictObject({ name: z.enum(LIMIT_NAMES), value: z.number(), used: z.number().nullable(), agent: z.string().max(100).optional() });
const failure = z.strictObject({ reason: z.enum(["engine", "model-refused", "setup", "timeout", "limit", "stopped", "runner"]), detail: text, infrastructure: z.boolean(), limit: limit.optional() });

export const RUNNER_REQUESTS = {
  enroll: wire<EnrollRequest>()(z.strictObject({ token: z.string().min(1).max(200), name: z.string().trim().min(1).max(100), publicKeyPem: z.string().min(1).max(2000) })),
  challenge: wire<ChallengeRequest>()(z.strictObject({ runnerId: z.string().min(1).max(100) })),
  hello: wire<HelloRequest>()(z.strictObject({ ...state, runnerId: z.string().min(1).max(100), challengeId: z.string().min(1).max(100), signature: z.string().min(1).max(500) })),
  heartbeat: wire<HeartbeatRequest>()(z.strictObject({ ...state, running: z.array(z.string().max(100)).max(1000) })),
  claim: wire<ClaimRequest>()(z.strictObject({ freeSlots: count })),
  ack: wire<AckRequest>()(z.strictObject({ fence, engine: z.string().min(1).max(100) })),
  /** `renew` and `model-token`. */
  fenced: wire<Fenced>()(z.strictObject({ fence })),
  events: wire<EventsRequest>()(z.strictObject({ fence, events: z.array(event satisfies z.ZodType<Given<AttemptEvent>>).max(1000) })),
  /** The query of `artifacts`; its body is the bytes. */
  artifacts: wire<ArtifactUpload>()(z.object({ fence: z.coerce.number().int(), name: z.string().min(1).max(300), kind: z.enum(["patch", "output", "log"]), mediaType: z.string().min(1).max(200) })),
  /** `tool-call` and `brain-tool`. */
  call: wire<CallRequest>()(z.strictObject({ fence, callId: z.string().min(1).max(100), tool: z.string().min(1).max(100), input: z.json(), baseCommits: commits.optional(), stateCommits: stateIds.optional() })),
  secret: wire<SecretRequest>()(z.strictObject({ fence, name: z.string().min(1).max(100), use: z.union([z.strictObject({ tool: z.string() }), z.strictObject({ project: z.string() })]) })),
  // The receipt's own shape is checked beside its signature, where it is read (run-receipt.ts).
  complete: wire<CompleteRequest>()(z.strictObject({
    fence, outcome: z.enum(["succeeded", "failed", "held"]), result: text, output: z.json().optional(), failure: failure.optional(),
    usage, engine: z.string().max(100), workingCopy: blobRef.optional(), baseCommits: commits, stateCommits: stateIds,
    receipt: z.strictObject({ receipt: z.custom<SignedRunReceipt["receipt"]>(), signature: z.string().min(1).max(500) }),
  })),
} as const;
