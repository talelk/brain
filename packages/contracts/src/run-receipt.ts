import { sign as edSign, verify as edVerify } from "node:crypto";
import type { AuditEvent } from "./audit-chain";
import { canonicalJsonBytes, domainDigest, isDigest } from "./hash";
import type { Digest, JsonValue } from "./protocol";

/**
 * Signed run receipts. When an attempt ends the runner states which attempt it ran, under which fence, on which snapshot and with which
 * result, and signs that statement with the ed25519 key it enrolled with. The Governor checks the signature against the enrolled key before
 * it accepts the completion and records receipt and signature in the audit chain, so the audit verifier can check every receipt against the
 * runner keys the same chain recorded. This file is the one definition: the runner signs with it and the Governor verifies with it.
 */
export interface RunReceipt {
  readonly attemptId: string;
  readonly fence: number;
  readonly snapshotDigest: Digest;
  readonly resultDigest: Digest;
}
export interface SignedRunReceipt { readonly receipt: RunReceipt; readonly signature: string }

/** The audit events the receipt check reads. `runner.enrolled` records `{runnerId, publicKeyPem}`, `runner.removed` `{runnerId}`, `attempt.completed` `{runnerId, receipt, signature}` with subject `attempt:<id>`. */
export const RUNNER_ENROLLED_EVENT = "runner.enrolled";
export const RUNNER_REMOVED_EVENT = "runner.removed";
export const ATTEMPT_COMPLETED_EVENT = "attempt.completed";

/** The digest a receipt carries for what the attempt returned: its result text and its structured output (null when it has none). */
export const resultDigest = (result: string, output: JsonValue | null): Digest => domainDigest("brain:result:v1", { result, output });

const RECEIPT_KEYS = ["attemptId", "fence", "snapshotDigest", "resultDigest"] as const;
/** What the signature covers: a domain prefix, then the receipt as canonical JSON (RFC 8785). */
function signingBytes(r: RunReceipt): Uint8Array {
  return Buffer.concat([Buffer.from("brain:run-receipt:v2\n"), canonicalJsonBytes({ attemptId: r.attemptId, fence: r.fence, snapshotDigest: r.snapshotDigest, resultDigest: r.resultDigest })]);
}
export function signReceipt(receipt: RunReceipt, privateKeyPem: string): string {
  return edSign(null, signingBytes(receipt), privateKeyPem).toString("base64url");
}
export function receiptSignatureOk(receipt: RunReceipt, signature: string, publicKeyPem: string): boolean {
  try { return edVerify(null, signingBytes(receipt), publicKeyPem, Buffer.from(signature, "base64url")); } catch { return false; }
}

/** Whether `value` has exactly the fields of a receipt, with the right shapes. Returns the reason it does not. */
export function receiptShapeProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "the receipt is not an object";
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!(RECEIPT_KEYS as readonly string[]).includes(key)) return `the receipt carries an unknown field ${key}`;
  if (typeof r["attemptId"] !== "string" || r["attemptId"].length === 0) return "attemptId must be a non-empty string";
  if (!Number.isSafeInteger(r["fence"]) || (r["fence"] as number) < 0) return "fence must be a count";
  for (const key of ["snapshotDigest", "resultDigest"]) if (typeof r[key] !== "string" || !isDigest(r[key] as string)) return `${key} must be a digest`;
  return undefined;
}

/**
 * The receipt check of the audit verifier. It is stateful: it reads the runner keys the chain recorded and the removals that ended them, in
 * chain order, and judges each completion that carries a receipt against what was true at its position: the runner was enrolled and not
 * removed, its key signed exactly this receipt, and the receipt is for the attempt the event is about. Make one per verification.
 */
export function createReceiptCheck(): (event: AuditEvent, payload: JsonValue) => string | undefined {
  const keys = new Map<string, string>();
  const receipted = new Set<string>();
  return (event, payload) => {
    if (event.type !== RUNNER_ENROLLED_EVENT && event.type !== RUNNER_REMOVED_EVENT && event.type !== ATTEMPT_COMPLETED_EVENT) return undefined;
    const p = (payload ?? {}) as { runnerId?: unknown; publicKeyPem?: unknown; receipt?: unknown; signature?: unknown };
    if (event.type === RUNNER_ENROLLED_EVENT) {
      if (typeof p.runnerId !== "string" || typeof p.publicKeyPem !== "string") return `event ${event.seq} enrolls a runner without its id or public key`;
      keys.set(p.runnerId, p.publicKeyPem);
      return undefined;
    }
    if (event.type === RUNNER_REMOVED_EVENT) {
      if (typeof p.runnerId === "string") keys.delete(p.runnerId);
      return undefined;
    }
    // A completion the Governor wrote itself (a lost runner, a stopped task) carries no receipt.
    if (p.receipt === undefined) return undefined;
    const at = `the receipt of ${event.subject}`;
    if (typeof p.signature !== "string" || p.signature.length === 0 || typeof p.runnerId !== "string") return `${at} carries no signature or runner`;
    const shape = receiptShapeProblem(p.receipt);
    if (shape) return `${at} is malformed: ${shape}`;
    const receipt = p.receipt as RunReceipt;
    if (event.subject !== `attempt:${receipt.attemptId}`) return `${at} names attempt ${receipt.attemptId}: a receipt was moved to another attempt`;
    if (receipted.has(receipt.attemptId)) return `${at} appears twice in the log`;
    const key = keys.get(p.runnerId);
    if (!key) return `${at} is signed by runner ${p.runnerId}, which was not enrolled at that point of the log`;
    if (!receiptSignatureOk(receipt, p.signature, key)) return `${at} does not carry a valid signature from runner ${p.runnerId}: it was altered after signing`;
    receipted.add(receipt.attemptId);
    return undefined;
  };
}
