import { auditKeyId, checkpointSigningBytes, KEY_RECORDED_EVENT, verifyAudit, type AuditCheckpoint, type AuditKey, type AuditVerifyResult } from "@brain/contracts";
import { createPrivateKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getInstance, setInstance, tx, type Db } from "../db";
import type { Gov } from "../dispatch";
import { append, readEvents, SYSTEM } from "../events";

/**
 * The Governor's side of the audit chain: an ed25519 signing key (private half in `<data>/audit`, owner-only; public half in `audit_keys`
 * and recorded in the chain), signed checkpoints of the chain head, and verification of the whole log.
 */
const keyPath = (dataDir: string, keyId: string): string => join(dataDir, "audit", `${keyId}.key`);

/** Makes sure there is a signing key whose private half is on disk; a lost one is retired and replaced. Called at start. */
export function ensureAuditKey(gov: Pick<Gov, "db" | "dataDir" | "clock">): string {
  mkdirSync(join(gov.dataDir, "audit"), { recursive: true, mode: 0o700 });
  const active = getInstance(gov.db, "audit_key_id");
  if (active && existsSync(keyPath(gov.dataDir, active))) return active;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const keyId = auditKeyId(publicB64);
  writeFileSync(keyPath(gov.dataDir, keyId), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  tx(gov.db, () => {
    const now = gov.clock.nowMs();
    if (active) gov.db.prepare("UPDATE audit_keys SET retired_at_ms=? WHERE key_id=?").run(now, active);
    gov.db.prepare("INSERT INTO audit_keys(key_id, public_key, created_at_ms) VALUES (?,?,?)").run(keyId, publicB64, now);
    setInstance(gov.db, "audit_key_id", keyId);
    append(gov.db, { type: KEY_RECORDED_EVENT, subject: `audit-key:${keyId}`, payload: { keyId, publicKey: publicB64, replaces: active ?? null }, actor: SYSTEM });
  });
  return keyId;
}

const checkpoints = (db: Db): AuditCheckpoint[] =>
  db.prepare("SELECT through_seq AS throughSeq, chain_digest AS chainDigest, key_id AS keyId, created_at_ms AS createdAtMs, signature FROM audit_checkpoints ORDER BY through_seq").all() as AuditCheckpoint[];

/** Signs the chain head, unless the newest checkpoint already covers it. Returns the checkpoint that now covers the head, if the chain has events. */
export function checkpoint(gov: Pick<Gov, "db" | "dataDir" | "clock">): AuditCheckpoint | undefined {
  return tx(gov.db, () => {
    const head = gov.db.prepare("SELECT seq, chain_digest AS digest FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; digest: string } | undefined;
    if (!head) return undefined;
    const last = checkpoints(gov.db).at(-1);
    if (last?.throughSeq === head.seq) return last;
    const keyId = getInstance(gov.db, "audit_key_id");
    if (!keyId) throw new Error("the audit signing key was not created");
    const body = { throughSeq: head.seq, chainDigest: head.digest, keyId, createdAtMs: gov.clock.nowMs() };
    const signature = edSign(null, checkpointSigningBytes(body), createPrivateKey(readFileSync(keyPath(gov.dataDir, keyId)))).toString("base64");
    gov.db.prepare("INSERT INTO audit_checkpoints(through_seq, chain_digest, key_id, signature, created_at_ms) VALUES (?,?,?,?,?)").run(body.throughSeq, body.chainDigest, keyId, signature, body.createdAtMs);
    return { ...body, signature };
  });
}

/** Verifies the whole log from the database, from the first event: the chain, the run receipts, the keys and every checkpoint. */
export function verify(db: Db): AuditVerifyResult {
  const keys = db.prepare("SELECT key_id AS keyId, public_key AS publicKey, created_at_ms AS createdAtMs, retired_at_ms AS retiredAtMs FROM audit_keys ORDER BY created_at_ms").all() as AuditKey[];
  return verifyAudit({ events: readEvents(db), keys, checkpoints: checkpoints(db) });
}
