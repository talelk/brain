import { BrainError, type SecretName } from "@brain/contracts";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db";
import type { Gov } from "../dispatch";

/**
 * A workspace's secrets, encrypted with AES-256-GCM under a key kept in `<data>/instance.key`. A value is bound to its workspace and name,
 * so a row copied elsewhere does not decrypt. Values leave this file only through `readSecret`, for the Governor's own use; no query
 * returns one.
 */
export function instanceKeys(dataDir: string): Gov["keys"] {
  const path = join(dataDir, "instance.key");
  if (!existsSync(path)) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, randomBytes(64));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== 64) throw new Error(`${path} must be a 64-byte file only its owner can read`);
  const bytes = readFileSync(path);
  return { secrets: bytes.subarray(0, 32), digests: bytes.subarray(32) };
}

const bound = (workspaceId: string, name: string): Buffer => Buffer.from(`${workspaceId}\n${name}`);

export function setSecret(gov: Gov, tx: Db, input: { workspaceId: string; name: string; value: string; by: string }): void {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", gov.keys.secrets, nonce).setAAD(bound(input.workspaceId, input.name));
  const sealed = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  tx.prepare(`INSERT INTO secrets(workspace_id, name, value, updated_by, updated_at_ms) VALUES (?,?,?,?,?)
    ON CONFLICT(workspace_id, name) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at_ms=excluded.updated_at_ms`)
    .run(input.workspaceId, input.name, Buffer.concat([nonce, cipher.getAuthTag(), sealed]), input.by, gov.clock.nowMs());
}

/** True when there was one to delete. */
export function deleteSecret(tx: Db, workspaceId: string, name: string): boolean {
  return tx.prepare("DELETE FROM secrets WHERE workspace_id=? AND name=?").run(workspaceId, name).changes > 0;
}

export function listSecrets(db: Db, workspaceId: string): SecretName[] {
  return db.prepare("SELECT name, updated_at_ms AS updatedAt FROM secrets WHERE workspace_id=? ORDER BY name").all(workspaceId) as SecretName[];
}

export const hasSecret = (gov: Gov, workspaceId: string, name: string): boolean => gov.db.prepare("SELECT 1 FROM secrets WHERE workspace_id=? AND name=?").get(workspaceId, name) !== undefined;

/** The secret itself, for the Governor's own use (a model key, a credential, a lease to a tool). Undefined when it is not set. */
export function readSecret(gov: Gov, workspaceId: string, name: string): string | undefined {
  const row = gov.db.prepare("SELECT value FROM secrets WHERE workspace_id=? AND name=?").get(workspaceId, name) as { value: Buffer } | undefined;
  if (!row) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", gov.keys.secrets, row.value.subarray(0, 12)).setAAD(bound(workspaceId, name)).setAuthTag(row.value.subarray(12, 28));
    return Buffer.concat([decipher.update(row.value.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new BrainError("INTERNAL", `The secret ${name} cannot be decrypted with this Governor's key`);
  }
}
