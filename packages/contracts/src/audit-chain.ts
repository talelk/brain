import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalJsonBytes, domainDigest } from "./hash";
import type { Digest, JsonValue } from "./protocol";
import { createReceiptCheck } from "./run-receipt";

/**
 * Tamper-evident audit. The Governor's event log is one hash chain: each event stores the digest of the event before it and its own chain
 * digest over everything it records, actor included. Signed checkpoints (head digest + position, signed with a Governor audit key) pin the
 * chain at a moment, so a rebuilt chain or a cut tail is found too. This file is the one place that defines the digests and the verifier:
 * the Governor writes with the same functions it verifies with. The verifier is pure: no database, no clock, no network.
 */
export type ActorKind = "person" | "token" | "agent" | "runner" | "system";
/** Who did it. An agent acts as one attempt; a person is a user id; an API token is `token:<id>`; a runner is its id; the Governor's own work is `system`. */
export interface Actor { readonly kind: ActorKind; readonly id: string; readonly attemptId?: string }

export interface AuditEvent {
  readonly seq: number;
  readonly type: string;
  readonly workspaceId: string | null;
  /** What the event is about, as `<kind>:<id>` (for example `task:tsk_1`). */
  readonly subject: string;
  readonly payloadJson: string;
  readonly payloadDigest: Digest;
  readonly actorKind: ActorKind;
  readonly actorId: string;
  readonly actorAttemptId: string | null;
  readonly createdAtMs: number;
  readonly prevDigest: Digest;
  readonly chainDigest: Digest;
}
export interface AuditKey { readonly keyId: string; readonly publicKey: string; readonly createdAtMs: number; readonly retiredAtMs: number | null }
export interface AuditCheckpoint { readonly throughSeq: number; readonly chainDigest: Digest; readonly keyId: string; readonly createdAtMs: number; readonly signature: string }

export const AUDIT_GENESIS: Digest = domainDigest("brain:audit-genesis:v2", "brain");
export const KEY_RECORDED_EVENT = "audit.keyRecorded";

export const payloadDigest = (payload: JsonValue): Digest => domainDigest("brain:event:v2", payload);

/** The chain digest of an event: `prev`, its position and every column the event records (the payload through its own digest). */
export function auditChainDigest(prev: Digest, e: Omit<AuditEvent, "prevDigest" | "chainDigest" | "payloadJson">): Digest {
  return domainDigest("brain:audit-chain:v2", [prev, e.seq, e.type, e.workspaceId, e.subject, e.payloadDigest, e.actorKind, e.actorId, e.actorAttemptId, e.createdAtMs]);
}

/** What a checkpoint signature covers. */
export function checkpointSigningBytes(c: Omit<AuditCheckpoint, "signature">): Uint8Array {
  return Buffer.concat([Buffer.from("brain:audit-checkpoint:v2\n"), canonicalJsonBytes([c.throughSeq, c.chainDigest, c.keyId, c.createdAtMs])]);
}
/** A key id is derived from the key, so an id cannot be reused for another key. `publicKey` is the SPKI DER in base64. */
export function auditKeyId(publicKey: string): string {
  return `ak-${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 16)}`;
}
function signatureOk(publicKey: string, bytes: Uint8Array, signature: string): boolean {
  try {
    return edVerify(null, bytes, createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export type AuditBreakKind =
  | "sequence-gap" | "broken-link" | "payload-edited" | "event-edited" | "receipt"
  | "key-mismatch" | "checkpoint-unknown-key" | "checkpoint-unsigned" | "checkpoint-mismatch" | "tail-truncated";
export interface AuditBreak { readonly kind: AuditBreakKind; readonly seq: number | null; readonly detail: string }
export interface AuditVerifyResult {
  readonly ok: boolean;
  readonly events: number;
  readonly checkpoints: number;
  readonly head: { readonly seq: number; readonly digest: Digest } | null;
  /** The first break, in chain order; nothing after it is judged. */
  readonly break?: AuditBreak;
}

/**
 * Verifies the log: every event in order (position, link, payload digest, chain digest, run receipts), then the keys against the keys the
 * chain recorded, then every checkpoint (a known key, a valid signature, the digest the chain has at that position, not beyond the end).
 */
export function verifyAudit(input: { readonly events: Iterable<AuditEvent>; readonly keys: readonly AuditKey[]; readonly checkpoints: readonly AuditCheckpoint[] }): AuditVerifyResult {
  const wanted = new Set(input.checkpoints.map((c) => c.throughSeq));
  const digestAt = new Map<number, Digest>([[0, AUDIT_GENESIS]]);
  const recordedKeys = new Map<string, string>();
  const receipts = createReceiptCheck();
  let lastSeq = 0;
  let lastDigest = AUDIT_GENESIS;
  const result = (problem?: AuditBreak, checkpoints = 0): AuditVerifyResult => ({
    ok: problem === undefined, events: lastSeq, checkpoints, head: lastSeq > 0 ? { seq: lastSeq, digest: lastDigest } : null, ...(problem ? { break: problem } : {}),
  });

  for (const e of input.events) {
    const at = `event ${e.seq} (${e.type})`;
    if (e.seq !== lastSeq + 1) return result({ kind: "sequence-gap", seq: e.seq, detail: `${at} is where position ${lastSeq + 1} was expected: an event was removed, added or moved` });
    if (e.prevDigest !== lastDigest) return result({ kind: "broken-link", seq: e.seq, detail: `${at} does not continue the event before it: the chain was cut or rebuilt here` });
    let payload: JsonValue;
    try { payload = JSON.parse(e.payloadJson) as JsonValue; } catch { return result({ kind: "payload-edited", seq: e.seq, detail: `${at} has a payload that is not valid JSON` }); }
    if (payloadDigest(payload) !== e.payloadDigest) return result({ kind: "payload-edited", seq: e.seq, detail: `${at} was edited: its payload no longer matches the digest recorded with it` });
    if (auditChainDigest(e.prevDigest, e) !== e.chainDigest) return result({ kind: "event-edited", seq: e.seq, detail: `${at} was edited: what it records no longer matches its chain digest` });
    const receiptProblem = receipts(e, payload);
    if (receiptProblem) return result({ kind: "receipt", seq: e.seq, detail: receiptProblem });
    if (e.type === KEY_RECORDED_EVENT) {
      const p = payload as { keyId?: unknown; publicKey?: unknown };
      if (typeof p.keyId === "string" && typeof p.publicKey === "string") recordedKeys.set(p.keyId, p.publicKey);
    }
    lastSeq = e.seq;
    lastDigest = e.chainDigest;
    if (wanted.has(e.seq)) digestAt.set(e.seq, e.chainDigest);
  }

  const trusted = new Map<string, string>();
  for (const key of input.keys) {
    if (auditKeyId(key.publicKey) !== key.keyId) return result({ kind: "key-mismatch", seq: null, detail: `key ${key.keyId} is not the key its id was derived from` });
    const recorded = recordedKeys.get(key.keyId);
    if (recorded !== undefined && recorded !== key.publicKey) return result({ kind: "key-mismatch", seq: null, detail: `key ${key.keyId} differs from the key the audit log recorded under that id` });
    trusted.set(key.keyId, key.publicKey);
  }
  let verified = 0;
  for (const c of [...input.checkpoints].sort((a, b) => a.throughSeq - b.throughSeq)) {
    const where = `the checkpoint at position ${c.throughSeq} (${new Date(c.createdAtMs).toISOString()})`;
    const key = trusted.get(c.keyId);
    if (key === undefined) return result({ kind: "checkpoint-unknown-key", seq: c.throughSeq, detail: `${where} was signed by key ${c.keyId}, which is not an audit key of this Governor` }, verified);
    if (!signatureOk(key, checkpointSigningBytes(c), c.signature)) return result({ kind: "checkpoint-unsigned", seq: c.throughSeq, detail: `${where} does not carry a valid signature from key ${c.keyId}` }, verified);
    if (c.throughSeq > lastSeq) return result({ kind: "tail-truncated", seq: c.throughSeq, detail: `${where} covers events beyond the last one present (${lastSeq}): the end of the log was cut` }, verified);
    if (digestAt.get(c.throughSeq) !== c.chainDigest) return result({ kind: "checkpoint-mismatch", seq: c.throughSeq, detail: `${where} signed a different history than the log now holds at that position: the log was rebuilt` }, verified);
    verified += 1;
  }
  return result(undefined, verified);
}
