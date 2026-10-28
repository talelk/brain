import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrainDomainError } from "../../domain/errors";

export const OWNER_FILE = ".governor-owner.db";

// Kernel-held ownership is released on process exit, including a crash. It is
// not operational state and must never be copied into a backup.
export function acquireDirectory(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink()) {
    throw new BrainDomainError("CONFLICT", "data directory must be a real directory");
  }
  const path = join(dataDir, OWNER_FILE);
  if (existsSync(path)) assertRegularFile(path);
  const lock = new Database(path, { timeout: 0 });
  try {
    chmodSync(path, 0o600);
    lock.exec("BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new BrainDomainError("CONFLICT", "data directory is in use; stop its Governor before maintenance");
  }
  return () => { if (lock.open) lock.close(); };
}

export function assertRegularFile(path: string): void {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) {
    throw new BrainDomainError("EVIDENCE_MISSING", "expected a regular file with a single hard link");
  }
}

export function durableWrite(path: string, bytes: string | Uint8Array): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

// Private operational key material, never Git configuration. Same-version
// restarts must retain session digests and pagination signatures.
export function authorityKeys(dataDir: string): Uint8Array {
  const path = join(dataDir, "authority.keys");
  if (!existsSync(path)) {
    durableWrite(path, randomBytes(64));
    const parent = openSync(dataDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  assertRegularFile(path);
  const st = lstatSync(path);
  if ((st.mode & 0o077) !== 0 || st.size !== 64) {
    throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "authority.keys must contain 64 bytes with owner-only permissions");
  }
  return readFileSync(path);
}
