import { createHash, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import type { AuditEventRecord, Digest, JsonValue } from "./brain.generated";
import { canonicalJsonBytes, domainDigest } from "./hash";
import type { AuditEventCheck } from "./audit-chain";

/**
 * Signed run receipts (ADR 0078). When an attempt ends the runner states what it did and signs that statement with the ed25519 key it
 * enrolled with. The Governor checks the signature against the enrolled public key before it accepts the completion, stores the receipt
 * and signature as they came, and records both in the audit chain, so `brain audit verify` can check every receipt offline against the
 * runner keys the same chain recorded. This file is the one definition: the runner signs with it, the Governor verifies with it and the
 * offline verifier plugs `createReceiptCheck()` into the audit chain.
 */
export const RUN_RECEIPT_VERSION = "brain.run-receipt/v1";
export const RUNNER_KEY_ENROLLED_EVENT = "runner.keyEnrolled";
/** Events that end a runner key: rotation and deregistration (their payload names `revokedKeyIds`). */
export const RUNNER_KEYS_REVOKED_EVENT = "runner.keysRevoked";
export const RUNNER_KEY_REVOKING_EVENTS: readonly string[] = ["runner.rotated", "runner.deregistered", RUNNER_KEYS_REVOKED_EVENT];
export const RECEIPT_EVENT = "attempt.receipted";

export type ReceiptOutcome = "succeeded" | "failed" | "unknown-outcome";
export interface ReceiptUsage { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number; readonly microUsd: number }
export interface RunReceipt {
  readonly contractVersion: typeof RUN_RECEIPT_VERSION;
  readonly attemptId: string;
  readonly jobId: string;
  readonly jobFence: number;
  readonly runnerId: string;
  readonly runnerEpoch: number;
  readonly workflowRunId: string;
  readonly stepId: string;
  readonly configDigest: string;
  readonly executionDigest: string;
  /** The enrolled key that signs this receipt (a key id from `runnerKeyId`). */
  readonly keyId: string;
  /** What ran it: the engine id, its adapter digest as the version, and the model route that served the attempt (null when none). */
  readonly engine: { readonly id: string; readonly version: string | null; readonly route: string | null };
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: ReceiptOutcome;
  readonly usage: ReceiptUsage;
  /** Digest of the evidence bundle this attempt submits for its result; null when it submits none (failed, held, evaluator or act attempts). */
  readonly evidenceDigest: string | null;
  readonly artifactDigests: readonly string[];
}
export interface SignedRunReceipt { readonly receipt: RunReceipt; readonly signature: string }

const RECEIPT_KEYS = ["contractVersion", "attemptId", "jobId", "jobFence", "runnerId", "runnerEpoch", "workflowRunId", "stepId", "configDigest", "executionDigest", "keyId", "engine", "startedAt", "endedAt", "outcome", "usage", "evidenceDigest", "artifactDigests"] as const;

/** A runner key id is derived from the key, so an id cannot be reused for another key. */
export function runnerKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `rk-${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

/** What the signature covers: a domain prefix, then the receipt as canonical JSON (RFC 8785). */
export function receiptSigningBytes(receipt: RunReceipt): Uint8Array {
  return Buffer.concat([Buffer.from("brain:run-receipt:v1\n"), canonicalJsonBytes(receipt as unknown as JsonValue)]);
}
export const receiptDigest = (receipt: RunReceipt): Digest => domainDigest("brain:run-receipt:v1", receipt as unknown as JsonValue);

export function signReceipt(receipt: RunReceipt, privateKeyPem: string): string {
  return edSign(null, receiptSigningBytes(receipt), privateKeyPem).toString("base64url");
}
export function receiptSignatureOk(receipt: RunReceipt, signature: string, publicKeyPem: string): boolean {
  try { return edVerify(null, receiptSigningBytes(receipt), publicKeyPem, Buffer.from(signature, "base64url")); } catch { return false; }
}

/** Whether `value` has exactly the fields of a receipt, with the right shapes. Returns the reason it does not. */
export function receiptShapeProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "the receipt is not an object";
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!(RECEIPT_KEYS as readonly string[]).includes(key)) return `the receipt carries an unknown field ${key}`;
  for (const key of RECEIPT_KEYS) if (!(key in r)) return `the receipt lacks ${key}`;
  const text = (key: string): boolean => typeof r[key] === "string" && (r[key] as string).length > 0;
  const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
  if (r["contractVersion"] !== RUN_RECEIPT_VERSION) return `the receipt is not ${RUN_RECEIPT_VERSION}`;
  for (const key of ["attemptId", "jobId", "runnerId", "workflowRunId", "stepId", "configDigest", "executionDigest", "keyId", "startedAt", "endedAt"]) if (!text(key)) return `${key} must be a non-empty string`;
  if (!count(r["jobFence"]) || !count(r["runnerEpoch"])) return "fence and epoch must be counts";
  if (!["succeeded", "failed", "unknown-outcome"].includes(String(r["outcome"]))) return "outcome must be succeeded, failed or unknown-outcome";
  const engine = r["engine"] as Record<string, unknown> | null;
  if (!engine || typeof engine !== "object" || typeof engine["id"] !== "string" || !(engine["version"] === null || typeof engine["version"] === "string") || !(engine["route"] === null || typeof engine["route"] === "string")) return "engine must name an id, a version or null and a route or null";
  const usage = r["usage"] as Record<string, unknown> | null;
  if (!usage || typeof usage !== "object" || !["inputTokens", "outputTokens", "cachedInputTokens", "microUsd"].every((k) => count(usage[k]))) return "usage totals must be counts";
  if (!(r["evidenceDigest"] === null || typeof r["evidenceDigest"] === "string")) return "evidenceDigest must be a digest or null";
  if (!Array.isArray(r["artifactDigests"]) || !(r["artifactDigests"] as unknown[]).every((d) => typeof d === "string")) return "artifactDigests must be a list of digests";
  return undefined;
}

interface RunnerKey { readonly keyId: string; readonly runnerId: string; readonly publicKeyPem: string; revoked: boolean }

/**
 * The offline receipt check for `brain audit verify` (the audit chain's plug-in point). It is stateful: it reads the runner keys the chain
 * recorded (`runner.keyEnrolled`) and the events that ended them (`runner.rotated`, `runner.deregistered`, and the restore's `runner.keysRevoked`) in chain order, and judges each
 * `attempt.receipted` event against what was true at its position: the key was enrolled, belongs to that runner, had not been revoked, signed
 * exactly this receipt, and the receipt is for the attempt the event is about. Make one per verification; the control chain, which holds all
 * of these events, is walked first.
 */
export function createReceiptCheck(): AuditEventCheck {
  const keys = new Map<string, RunnerKey>();
  const receipted = new Set<string>();
  return {
    name: "run receipt",
    check(event: AuditEventRecord): string | undefined {
      if (event.eventType !== RUNNER_KEY_ENROLLED_EVENT && event.eventType !== RECEIPT_EVENT && !RUNNER_KEY_REVOKING_EVENTS.includes(event.eventType)) return undefined;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(event.payloadJson) as Record<string, unknown>; } catch { return `event ${event.eventId} has no readable payload`; }
      if (event.eventType === RUNNER_KEY_ENROLLED_EVENT) {
        const { keyId, runnerId, publicKeyPem } = payload as { keyId?: unknown; runnerId?: unknown; publicKeyPem?: unknown };
        if (typeof keyId !== "string" || typeof runnerId !== "string" || typeof publicKeyPem !== "string") return `event ${event.eventId} records a runner key without its id, runner or public key`;
        let derived: string;
        try { derived = runnerKeyId(publicKeyPem); } catch { return `event ${event.eventId} records a runner key that is not a public key`; }
        if (derived !== keyId) return `event ${event.eventId} records runner key ${keyId}, which is not the key its id was derived from`;
        keys.set(keyId, { keyId, runnerId, publicKeyPem, revoked: false });
        return undefined;
      }
      if (event.eventType !== RECEIPT_EVENT) {
        for (const id of Array.isArray(payload["revokedKeyIds"]) ? payload["revokedKeyIds"] as unknown[] : []) { const key = keys.get(String(id)); if (key) key.revoked = true; }
        return undefined;
      }
      const at = `the receipt of attempt ${event.aggregateId}`;
      const { receipt, signature } = payload as { receipt?: unknown; signature?: unknown };
      if (typeof signature !== "string" || signature.length === 0) return `${at} carries no signature`;
      const shape = receiptShapeProblem(receipt);
      if (shape) return `${at} is malformed: ${shape}`;
      const r = receipt as RunReceipt;
      if (r.attemptId !== event.aggregateId) return `${at} names attempt ${r.attemptId}: a receipt was moved to another attempt`;
      if (receipted.has(r.attemptId)) return `${at} appears twice in the log`;
      const key = keys.get(r.keyId);
      if (!key) return `${at} is signed by key ${r.keyId}, which no runner enrollment in the audit log introduced`;
      if (key.runnerId !== r.runnerId) return `${at} claims runner ${r.runnerId} but key ${r.keyId} was enrolled by runner ${key.runnerId}`;
      if (key.revoked) return `${at} was signed with key ${r.keyId} after runner ${r.runnerId} had rotated or retired it`;
      if (!receiptSignatureOk(r, signature, key.publicKeyPem)) return `${at} does not carry a valid signature from runner ${r.runnerId} (key ${r.keyId}): it was altered after signing`;
      if (typeof payload["receiptDigest"] === "string" && payload["receiptDigest"] !== receiptDigest(r)) return `${at} no longer matches the digest recorded with it`;
      receipted.add(r.attemptId);
      return undefined;
    },
  };
}
