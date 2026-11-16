import { createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { auditKeyId, rotationSigningBytes, type AuditKey } from "@brain/contracts";
import type { Store } from "../../application/store";
import { durableWrite } from "../../infrastructure/persistence/directory";

/**
 * The Governor's audit signing key (ADR 0078): an ed25519 pair made at first start. The private half is a file in the data directory,
 * owner-only, and never leaves it; the public half is in `audit_keys` and is what checkpoints are checked against. Rotation retires the
 * old key (its public half stays so older checkpoints stay verifiable, its private half is deleted) and hands over with a signature.
 */
export interface ActiveKey { readonly keyId: string; readonly publicKey: string }
interface KeyRow { key_id: string; public_key: string; created_at_ms: number; retired_at_ms: number | null; previous_key_id: string | null; rotation_signature: string | null }

export class AuditKeys {
  private readonly dir: string;
  constructor(private readonly store: Store) {
    this.dir = join(store.dataDir, "audit");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!this.activeRow()) this.create(undefined);
  }

  private path(keyId: string): string { return join(this.dir, `${keyId}.key`); }
  private activeRow(): KeyRow | undefined {
    return this.store.control.prepare("SELECT * FROM audit_keys WHERE retired_at_ms IS NULL ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get() as KeyRow | undefined;
  }

  private create(previous: { keyId: string; privateKey: KeyObject | undefined } | undefined): KeyRow {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const keyId = auditKeyId(publicB64);
    durableWrite(this.path(keyId), privateKey.export({ format: "pem", type: "pkcs8" }));
    const signature = previous?.privateKey ? edSign(null, rotationSigningBytes(previous.keyId, keyId, publicB64), previous.privateKey).toString("base64") : null;
    this.store.control.prepare("INSERT INTO audit_keys(key_id,public_key,created_at_ms,previous_key_id,rotation_signature) VALUES (?,?,?,?,?)").run(keyId, publicB64, this.store.now(), previous?.keyId ?? null, signature);
    return this.store.control.prepare("SELECT * FROM audit_keys WHERE key_id=?").get(keyId) as KeyRow;
  }

  active(): ActiveKey { const row = this.activeRow()!; return { keyId: row.key_id, publicKey: row.public_key }; }

  /** The active key's private half; undefined (with a reason) when the file is gone or not owner-only. */
  private privateKey(keyId: string): { key?: KeyObject; problem?: string } {
    const path = this.path(keyId);
    if (!existsSync(path)) return { problem: `The audit signing key file for ${keyId} is missing from the data directory.` };
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) return { problem: "The audit signing key is not a regular file." };
    if ((st.mode & 0o077) !== 0) { try { chmodSync(path, 0o600); } catch { return { problem: "The audit signing key file is readable by other users and could not be fixed." }; } }
    try { return { key: createPrivateKey(readFileSync(path)) }; } catch { return { problem: "The audit signing key file could not be read." }; }
  }

  /** Why signing is impossible right now, or undefined when it is possible. */
  problem(): string | undefined { return this.privateKey(this.active().keyId).problem; }

  sign(bytes: Uint8Array): { keyId: string; signature: string } {
    const { keyId } = this.active();
    const { key, problem } = this.privateKey(keyId);
    if (!key) throw new Error(problem ?? "audit signing key unavailable");
    return { keyId, signature: edSign(null, bytes, key).toString("base64") };
  }

  list(): AuditKey[] {
    return (this.store.control.prepare("SELECT key_id,public_key,created_at_ms,retired_at_ms FROM audit_keys ORDER BY created_at_ms, rowid").all() as KeyRow[])
      .map((r) => ({ keyId: r.key_id, algorithm: "ed25519" as const, publicKey: r.public_key, createdAtMs: r.created_at_ms, retiredAtMs: r.retired_at_ms }));
  }

  /** Every key's record for the chain: id, public half and (for a rotated-in key) who handed over to it and the hand-over signature. */
  records(): Array<{ keyId: string; publicKey: string; previousKeyId: string | null; rotationSignature: string | null }> {
    return (this.store.control.prepare("SELECT * FROM audit_keys ORDER BY created_at_ms, rowid").all() as KeyRow[])
      .map((r) => ({ keyId: r.key_id, publicKey: r.public_key, previousKeyId: r.previous_key_id, rotationSignature: r.rotation_signature }));
  }

  /** Retires the active key and makes a new one, handed over with a signature from the old one when its private half is still there. */
  rotate(): { retiredKeyId: string; active: ActiveKey } {
    const old = this.active();
    const { key } = this.privateKey(old.keyId);
    const row = this.store.inTx(this.store.control, () => {
      this.store.control.prepare("UPDATE audit_keys SET retired_at_ms=? WHERE key_id=?").run(this.store.now(), old.keyId);
      return this.create({ keyId: old.keyId, privateKey: key });
    });
    try { unlinkSync(this.path(old.keyId)); } catch { /* already gone */ }
    return { retiredKeyId: old.keyId, active: { keyId: row.key_id, publicKey: row.public_key } };
  }
}
