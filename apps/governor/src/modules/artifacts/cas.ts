import { createHash } from "node:crypto";
import { closeSync, constants, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Digest } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";

/**
 * Content-addressed byte storage on the local disk. A digest names exactly
 * one file, written once and never rewritten; every read re-checks the
 * digest, so a changed or truncated file reads as missing evidence rather
 * than as content.
 */

/** Where a digest's bytes live. Production code goes through put/read; tests use it to tamper. */
export function casFilePath(store: Store, digest: string): string {
  const hex = digest.replace("sha256:", "");
  return join(store.dataDir, "cas", hex.slice(0, 2), hex);
}

/** Stores bytes under their digest; storing the same bytes again is a no-op. */
export function putBytes(store: Store, bytes: Uint8Array): string {
  const digest = sha256Digest(bytes);
  const path = casFilePath(store, digest);
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path)) {
    if (sha256Digest(readFileSync(path)) !== digest) throw new BrainDomainError("CONFLICT", `stored content ${digest} is corrupted`);
    return digest;
  }
  writeFileSync(path, bytes, { flag: "wx" });
  return digest;
}

/**
 * Streams bytes into storage without holding them in memory. The stream must
 * produce exactly `expectedBytes` bytes with digest `expectedDigest`;
 * otherwise nothing is stored and the call throws PAYLOAD_TOO_LARGE (over
 * the limit) or INVALID_CONTRACT (any other mismatch).
 */
export async function putStream(store: Store, chunks: AsyncIterable<Uint8Array>, expected: { digest: string; bytes: number; limit: number; tempName: string }): Promise<{ digest: string; bytes: number }> {
  const limit = Math.min(expected.limit, expected.bytes);
  const tmpDir = join(store.dataDir, "upload-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `${expected.tempName}.part`);
  const discard = (): void => { try { unlinkSync(tmpPath); } catch { /* already gone */ } };
  const hash = createHash("sha256");
  let received = 0;
  const out = createWriteStream(tmpPath);
  try {
    for await (const chunk of chunks) {
      received += chunk.length;
      if (received > limit) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "artifact stream exceeds declared size");
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    discard();
    throw e;
  }
  const digest = `sha256:${hash.digest("hex")}`;
  if (digest !== expected.digest || received !== expected.bytes) {
    discard();
    throw new BrainDomainError("INVALID_CONTRACT", "artifact digest/size mismatch");
  }
  const path = casFilePath(store, digest);
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path)) discard();
  else renameSync(tmpPath, path);
  return { digest, bytes: received };
}

/** The stored bytes for a digest; EVIDENCE_MISSING when absent or changed. */
export function readVerified(store: Store, digest: string, expectedBytes?: number): Uint8Array {
  const path = casFilePath(store, digest);
  if (!existsSync(path)) throw new BrainDomainError("EVIDENCE_MISSING", `stored content ${digest} is missing`);
  const bytes = new Uint8Array(readFileSync(path));
  if (sha256Digest(bytes) !== digest || (expectedBytes !== undefined && bytes.length !== expectedBytes)) {
    throw new BrainDomainError("EVIDENCE_MISSING", `stored content ${digest} does not match its digest`);
  }
  return bytes;
}

/**
 * Checks stored bytes against a digest and size without loading them:
 * streamed, refusing symlinks and anything over 100 MiB.
 */
export function verifyStored(store: Store, digest: string, bytes: number): void {
  let fd: number | undefined;
  try {
    fd = openSync(casFilePath(store, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== bytes || stat.size > 100 * 1024 * 1024) throw new Error("size");
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let count = 0;
    for (;;) { const read = readSync(fd, buffer); if (!read) break; count += read; if (count > bytes) throw new Error("changed"); hash.update(buffer.subarray(0, read)); }
    if (count !== bytes || `sha256:${hash.digest("hex")}` !== digest) throw new Error("digest");
  } catch { throw new BrainDomainError("EVIDENCE_MISSING", "artifact bytes are missing or changed"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Removes stored files no one references once they are older than the grace
 * window. Referenced: every artifact association, every release file, every
 * open upload's expected digest, every immutable document version, and the
 * content of every support draft and memory publication.
 */
export function sweepStorage(store: Store, graceMs = 24 * 3600_000): { scanned: number; removed: number; retained: number } {
  const s = store;
  const referenced = new Set<string>();
  for (const r of s.control.prepare("SELECT digest FROM artifact_associations").all() as Array<{ digest: string }>) {
    referenced.add(r.digest.replace("sha256:", ""));
  }
  for (const r of s.control.prepare("SELECT digest FROM release_files").all() as Array<{ digest: string }>) {
    referenced.add(r.digest.replace("sha256:", ""));
  }
  for (const r of s.control.prepare("SELECT expected_digest FROM artifact_uploads WHERE state='open' AND expires_at_ms>?").all(s.now()) as Array<{ expected_digest: string }>) {
    referenced.add(r.expected_digest.replace("sha256:", ""));
  }
  for (const workspace of s.control.prepare("SELECT id,organization_id FROM workspaces").all() as Array<{ id: string; organization_id: string }>) {
    const db = s.workspaceDb(workspace.id, workspace.organization_id);
    const workspaceRefs = db.prepare(`SELECT digest FROM document_versions
      UNION SELECT content_digest FROM support_drafts UNION SELECT content_digest FROM memory_publications
      UNION SELECT artifact_digest FROM output_versions`).all() as Array<{ digest: string }>;
    for (const ref of workspaceRefs) referenced.add(ref.digest.replace("sha256:", ""));
  }
  const casDir = join(s.dataDir, "cas");
  let scanned = 0, removed = 0, retained = 0;
  if (!existsSync(casDir)) return { scanned, removed, retained };
  for (const shard of readdirSync(casDir, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardDir = join(casDir, shard.name);
    for (const name of readdirSync(shardDir)) {
      scanned++;
      const full = join(shardDir, name);
      if (referenced.has(name)) { retained++; continue; }
      const age = s.now() - statSync(full).mtimeMs;
      if (age < graceMs) { retained++; continue; }
      unlinkSync(full);
      removed++;
    }
  }
  return { scanned, removed, retained };
}
