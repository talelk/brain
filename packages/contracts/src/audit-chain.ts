import { createHash, createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";
import type { AuditCheckpoint, AuditEventRecord, AuditKey, Digest } from "./brain.generated";
import { canonicalJsonBytes, domainDigest, sha256Digest } from "./hash";
import { createReceiptCheck } from "./run-receipt";
import type { JsonValue } from "./brain.generated";

/**
 * Tamper-evident audit (ADR 0078). Every event log (one per organization in the control database, one per workspace database) is a hash
 * chain: each event stores the digest of the event before it and its own chain digest over everything it records, actor included.
 * Signed checkpoints (head digest + position, signed with a Governor audit key) pin the chain at a moment, so a rebuilt chain or a cut
 * tail is found too. This file is the one place that defines the digests and the verifier; the Governor writes with the same functions
 * and `brain audit verify` checks an export with them, so the two cannot drift. The verifier is pure: no database, no clock, no network.
 */
export const AUDIT_EXPORT_FORMAT = "brain.audit-export/v1";
export const CONTROL_SCOPE = "control";
export const workspaceScope = (workspaceId: string): string => `workspace:${workspaceId}`;
export const KEY_RECORDED_EVENT = "audit.keyRecorded";

/** The digest a chain starts from. Bound to its organization and scope so one chain cannot be spliced onto another. */
export function auditGenesis(organizationId: string, scope: string): Digest {
  return domainDigest("brain:audit-genesis:v1", { organizationId, scope });
}

export type ChainedFields = Pick<AuditEventRecord, "eventId" | "organizationId" | "workspaceId" | "aggregateType" | "aggregateId" | "aggregateSeq" | "eventType" | "payloadDigest" | "createdAtMs" | "actorId" | "actorKind" | "actorAttemptId" | "actingFor">;

/** The chain digest of an event: `prev`, its position and every column the event records (the payload through its own digest). */
export function auditChainDigest(prev: Digest, chainSeq: number, e: ChainedFields): Digest {
  return domainDigest("brain:audit-chain:v1", [prev, chainSeq, e.eventId, e.organizationId ?? null, e.workspaceId ?? null, e.aggregateType, e.aggregateId, e.aggregateSeq, e.eventType, e.payloadDigest, e.createdAtMs, e.actorId, e.actorKind, e.actorAttemptId ?? null, e.actingFor ?? null]);
}

/** Whether one event is consistent with itself: its payload with its payload digest, and everything it records with its chain digest. */
export function auditEventProblem(e: AuditEventRecord): { kind: "payload-edited" | "event-edited"; detail: string } | undefined {
  if (e.chainSeq === null || e.prevDigest === null || e.chainDigest === null) return undefined;
  const at = `event ${e.eventId}`;
  let payload: JsonValue;
  try { payload = JSON.parse(e.payloadJson) as JsonValue; } catch { return { kind: "payload-edited", detail: `${at} has a payload that is not valid JSON` }; }
  if (domainDigest("brain:event:v1", payload) !== e.payloadDigest) return { kind: "payload-edited", detail: `${at} was edited: its payload no longer matches the digest recorded with it` };
  if (auditChainDigest(e.prevDigest, e.chainSeq, e) !== e.chainDigest) return { kind: "event-edited", detail: `${at} was edited: what it records no longer matches its chain digest` };
  return undefined;
}

/** What a checkpoint signature covers. */
export type CheckpointBody = Pick<AuditCheckpoint, "checkpointId" | "organizationId" | "scope" | "throughSeq" | "chainDigest" | "createdAtMs" | "reason" | "keyId">;
export function checkpointSigningBytes(checkpoint: CheckpointBody): Uint8Array {
  const body = canonicalJsonBytes([checkpoint.checkpointId, checkpoint.organizationId, checkpoint.scope, checkpoint.throughSeq, checkpoint.chainDigest, checkpoint.createdAtMs, checkpoint.reason, checkpoint.keyId]);
  return Buffer.concat([Buffer.from("brain:audit-checkpoint:v1\n"), body]);
}
/** What the previous key signs to hand over to the next one. */
export function rotationSigningBytes(previousKeyId: string, keyId: string, publicKey: string): Uint8Array {
  return Buffer.from(`brain:audit-key-rotation:v1\n${previousKeyId}\n${keyId}\n${publicKey}`);
}
/** A key id is derived from the key, so an id cannot be reused for another key. */
export function auditKeyId(publicKey: string): string {
  return `ak-${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 16)}`;
}
const publicKeyObject = (publicKey: string): KeyObject => createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
const signatureOk = (publicKey: string, bytes: Uint8Array, signature: string): boolean => {
  try { return edVerify(null, bytes, publicKeyObject(publicKey), Buffer.from(signature, "base64")); } catch { return false; }
};

export type AuditBreakKind =
  | "unchained-event" | "sequence-gap" | "broken-link" | "payload-edited" | "event-edited"
  | "checkpoint-unsigned" | "checkpoint-unknown-key" | "checkpoint-mismatch" | "tail-truncated"
  | "key-mismatch" | "key-unrecorded-rotation" | "event-check";
export interface AuditBreak { readonly chain: string; readonly kind: AuditBreakKind; readonly chainSeq: number | null; readonly eventId: string | null; readonly detail: string }

/** An extra check on each event whose chain position is sound (the plug-in point for run receipts); return a sentence when the event is wrong. */
export interface AuditEventCheck { readonly name: string; check(event: AuditEventRecord, chain: string): string | undefined }
interface KeyRecord { readonly chainSeq: number; readonly eventId: string; readonly keyId: string; readonly publicKey: string; readonly previousKeyId: string | null; readonly rotationSignature: string | null }

/**
 * Walks one chain in event order, one event at a time (a Governor can feed it in slices). The first break is kept and nothing after it
 * is judged: later events cannot be trusted once the chain before them is not.
 */
export class AuditChainVerifier {
  verified = 0;
  lastSeq = 0;
  lastDigest: Digest;
  broken: AuditBreak | undefined;
  readonly keyRecords: KeyRecord[] = [];
  private readonly digestAt = new Map<number, Digest>();
  private readonly wanted: ReadonlySet<number>;
  constructor(readonly organizationId: string, readonly scope: string, readonly checkpoints: readonly AuditCheckpoint[] = [], private readonly checks: readonly AuditEventCheck[] = []) {
    this.lastDigest = auditGenesis(organizationId, scope);
    this.wanted = new Set(checkpoints.map((c) => c.throughSeq));
  }

  private fail(kind: AuditBreakKind, e: AuditEventRecord | undefined, detail: string, chainSeq: number | null = e?.chainSeq ?? null): AuditBreak {
    this.broken = { chain: this.scope, kind, chainSeq, eventId: e?.eventId ?? null, detail };
    return this.broken;
  }

  push(e: AuditEventRecord): AuditBreak | undefined {
    if (this.broken) return this.broken;
    const at = `event ${e.eventId}`;
    if (e.chainSeq === null || e.prevDigest === null || e.chainDigest === null) return this.fail("unchained-event", e, `${at} carries no chain position: it was added outside the audit log`);
    if (e.chainSeq !== this.lastSeq + 1) return this.fail("sequence-gap", e, `${at} is at position ${e.chainSeq} where ${this.lastSeq + 1} was expected: an event was removed, added or moved`);
    if (e.prevDigest !== this.lastDigest) return this.fail("broken-link", e, `${at} does not continue the event before it: the chain was cut or rebuilt here`);
    const problem = auditEventProblem(e);
    if (problem) return this.fail(problem.kind, e, problem.detail);
    const payload = JSON.parse(e.payloadJson) as JsonValue;
    for (const extra of this.checks) {
      const problem = extra.check(e, this.scope);
      if (problem !== undefined) return this.fail("event-check", e, `${extra.name}: ${problem}`);
    }
    if (e.eventType === KEY_RECORDED_EVENT) {
      const p = payload as { keyId?: unknown; publicKey?: unknown; previousKeyId?: unknown; rotationSignature?: unknown };
      if (typeof p.keyId === "string" && typeof p.publicKey === "string") {
        this.keyRecords.push({ chainSeq: e.chainSeq, eventId: e.eventId, keyId: p.keyId, publicKey: p.publicKey, previousKeyId: typeof p.previousKeyId === "string" ? p.previousKeyId : null, rotationSignature: typeof p.rotationSignature === "string" ? p.rotationSignature : null });
      }
    }
    this.lastSeq = e.chainSeq; this.lastDigest = e.chainDigest; this.verified += 1;
    if (this.wanted.has(e.chainSeq)) this.digestAt.set(e.chainSeq, e.chainDigest);
    return undefined;
  }

  /** A break found from outside the walk (the head of the log no longer matches what was already verified). */
  markBroken(kind: AuditBreakKind, detail: string, chainSeq: number | null = null): AuditBreak {
    this.broken ??= { chain: this.scope, kind, chainSeq, eventId: null, detail };
    return this.broken;
  }

  /** The digests at checkpointed positions seen so far, for a Governor that keeps the verifier alive while the log grows. */
  seen(seq: number): Digest | undefined { return this.digestAt.get(seq); }

  /**
   * Judges the checkpoints against what was walked: each must be signed by a trusted key, name the digest the chain has at its position,
   * and not lie beyond the end of the chain (a cut tail). Returns the first problem, or how many checkpoints held.
   */
  checkCheckpoints(trust: AuditKeyTrust): { problem?: AuditBreak; verified: number } {
    if (this.broken) return { problem: this.broken, verified: 0 };
    let verified = 0;
    for (const checkpoint of [...this.checkpoints].sort((a, b) => a.throughSeq - b.throughSeq)) {
      const where = `checkpoint ${checkpoint.checkpointId} (position ${checkpoint.throughSeq}, ${new Date(checkpoint.createdAtMs).toISOString()})`;
      const key = trust.publicKeyOf(checkpoint.keyId);
      if (key === undefined) return { problem: this.cpFail("checkpoint-unknown-key", checkpoint, `${where} was signed by key ${checkpoint.keyId}, which is not a trusted audit key`), verified };
      if (checkpoint.organizationId !== this.organizationId || checkpoint.scope !== this.scope || !signatureOk(key, checkpointSigningBytes(checkpoint), checkpoint.signature)) return { problem: this.cpFail("checkpoint-unsigned", checkpoint, `${where} does not carry a valid signature from key ${checkpoint.keyId}`), verified };
      if (checkpoint.throughSeq > this.lastSeq) return { problem: this.cpFail("tail-truncated", checkpoint, `${where} covers events beyond the last one present (${this.lastSeq}): the end of the log was cut`), verified };
      const have = checkpoint.throughSeq === 0 ? auditGenesis(this.organizationId, this.scope) : this.digestAt.get(checkpoint.throughSeq);
      if (have !== checkpoint.chainDigest) return { problem: this.cpFail("checkpoint-mismatch", checkpoint, `${where} signed a different history than the log now holds at that position: the log was rebuilt`), verified };
      verified += 1;
    }
    return { verified };
  }
  private cpFail(kind: AuditBreakKind, checkpoint: AuditCheckpoint, detail: string): AuditBreak {
    this.broken = { chain: this.scope, kind, chainSeq: checkpoint.throughSeq, eventId: null, detail };
    return this.broken;
  }
}

/** Which public keys are believed. Pinned keys are the anchor; without them the export's own keys are used and the result says so. */
export class AuditKeyTrust {
  readonly problems: AuditBreak[] = [];
  readonly warnings: string[] = [];
  private readonly trusted = new Map<string, string>();
  readonly pinned: boolean;

  constructor(exported: readonly Pick<AuditKey, "keyId" | "publicKey">[], controlKeyRecords: readonly KeyRecord[], pinned?: readonly Pick<AuditKey, "keyId" | "publicKey">[]) {
    this.pinned = pinned !== undefined && pinned.length > 0;
    const recorded = new Map(controlKeyRecords.map((r) => [r.keyId, r] as const));
    const bad = (kind: AuditBreakKind, r: KeyRecord | undefined, detail: string) => this.problems.push({ chain: CONTROL_SCOPE, kind, chainSeq: r?.chainSeq ?? null, eventId: r?.eventId ?? null, detail });
    for (const key of exported) {
      if (auditKeyId(key.publicKey) !== key.keyId) { bad("key-mismatch", recorded.get(key.keyId), `key ${key.keyId} is not the key its id was derived from`); continue; }
      const record = recorded.get(key.keyId);
      if (record && record.publicKey !== key.publicKey) { bad("key-mismatch", record, `key ${key.keyId} differs from the key the audit log recorded under that id`); continue; }
      if (!record) this.warnings.push(`key ${key.keyId} has no record in the audit log`);
      if (!this.pinned) this.trusted.set(key.keyId, key.publicKey);
    }
    if (this.pinned) {
      for (const key of pinned!) if (auditKeyId(key.publicKey) === key.keyId) this.trusted.set(key.keyId, key.publicKey);
      // A key joins the trusted set only through a hand-over signed by a key that already is.
      for (const record of [...controlKeyRecords].sort((a, b) => a.chainSeq - b.chainSeq)) {
        if (this.trusted.has(record.keyId)) continue;
        const previous = record.previousKeyId ? this.trusted.get(record.previousKeyId) : undefined;
        if (previous && record.rotationSignature && auditKeyId(record.publicKey) === record.keyId && signatureOk(previous, rotationSigningBytes(record.previousKeyId!, record.keyId, record.publicKey), record.rotationSignature)) this.trusted.set(record.keyId, record.publicKey);
      }
    } else {
      for (const record of controlKeyRecords) {
        if (!record.previousKeyId) continue;
        const previous = this.trusted.get(record.previousKeyId);
        if (!previous || !record.rotationSignature || !signatureOk(previous, rotationSigningBytes(record.previousKeyId, record.keyId, record.publicKey), record.rotationSignature)) bad("key-unrecorded-rotation", record, `key ${record.keyId} was introduced without a valid hand-over signature from ${record.previousKeyId}`);
      }
    }
  }
  publicKeyOf(keyId: string): string | undefined { return this.trusted.get(keyId); }
}

export interface AuditExportInput {
  readonly organizationId: string;
  readonly keys: readonly AuditKey[];
  readonly chains: ReadonlyArray<{ readonly scope: string; readonly events: Iterable<AuditEventRecord>; readonly checkpoints: readonly AuditCheckpoint[] }>;
}
export interface AuditVerifyOptions {
  /** Keys the verifier is told to believe (for example from an earlier export). Without them the export's own keys are used. */
  readonly trustedKeys?: readonly Pick<AuditKey, "keyId" | "publicKey">[];
  /** Extra checks judged against every event whose position is sound. Run receipts (ADR 0078) are always checked; these come after them. */
  readonly eventChecks?: readonly AuditEventCheck[];
}
export interface AuditChainResult { readonly scope: string; readonly verifiedEvents: number; readonly checkpointsVerified: number; readonly head: { readonly seq: number; readonly digest: Digest } | null }
/**
 * What a passing verification rests on. `chain-only`: the hash links and event digests are consistent, but no signed checkpoint was checked, so
 * a chain rebuilt end to end or a cut tail is NOT detected. `checkpointed`: checkpoints signed by keys taken from the export itself held (an
 * attacker who can rewrite the export can replace those keys too). `pinned`: checkpoints held under keys the verifier was told to believe.
 */
export type AuditAssurance = "chain-only" | "checkpointed" | "pinned";
export interface AuditVerifyResult {
  readonly ok: boolean;
  /** What `ok` means; meaningful when `ok` is true. */
  readonly assurance: AuditAssurance;
  readonly verifiedEvents: number;
  readonly checkpointsVerified: number;
  readonly keysPinned: boolean;
  readonly warnings: readonly string[];
  readonly chains: readonly AuditChainResult[];
  readonly break?: AuditBreak;
}

/**
 * Verifies an export: every chain event by event, then the keys and the checkpoints. Reports ok, or the first break and where. The
 * first break is the earliest in the order of the chains given (the control chain first), never a later symptom of it.
 */
export function verifyAuditExport(input: AuditExportInput, options: AuditVerifyOptions = {}): AuditVerifyResult {
  const ordered = [...input.chains].sort((a, b) => (a.scope === CONTROL_SCOPE ? 0 : 1) - (b.scope === CONTROL_SCOPE ? 0 : 1));
  // One receipt check for the whole export: it learns the runner keys from the control chain, which is walked first.
  const receipts = createReceiptCheck();
  const verifiers = ordered.map((chain) => {
    const v = new AuditChainVerifier(input.organizationId, chain.scope, chain.checkpoints, [receipts, ...(options.eventChecks ?? [])]);
    for (const event of chain.events) if (v.push(event)) break;
    return v;
  });
  const control = verifiers.find((v) => v.scope === CONTROL_SCOPE);
  const trust = new AuditKeyTrust(input.keys, control?.keyRecords ?? [], options.trustedKeys);
  const results: AuditChainResult[] = [];
  let firstBreak: AuditBreak | undefined = verifiers.find((v) => v.broken)?.broken ?? trust.problems[0];
  let checkpointsVerified = 0;
  for (const v of verifiers) {
    const wasBroken = v.broken !== undefined;
    const judged = v.checkCheckpoints(trust);
    if (!wasBroken && judged.problem && !firstBreak) firstBreak = judged.problem;
    checkpointsVerified += judged.verified;
    results.push({ scope: v.scope, verifiedEvents: v.verified, checkpointsVerified: judged.verified, head: v.lastSeq > 0 ? { seq: v.lastSeq, digest: v.lastDigest } : null });
  }
  return {
    ok: firstBreak === undefined, assurance: checkpointsVerified === 0 ? "chain-only" : trust.pinned ? "pinned" : "checkpointed", verifiedEvents: verifiers.reduce((n, v) => n + v.verified, 0), checkpointsVerified, keysPinned: trust.pinned,
    warnings: trust.warnings, chains: results, ...(firstBreak ? { break: firstBreak } : {}),
  };
}

/** A short fingerprint of a public key for people to compare ("pin this key"). */
export const auditKeyFingerprint = (publicKey: string): Digest => sha256Digest(Buffer.from(publicKey, "base64"));
