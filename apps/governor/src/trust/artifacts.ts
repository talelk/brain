import { BrainError, isDigest, sha256Digest, type Digest } from "@brain/contracts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accessOf } from "../access";
import type { Db } from "../db";
import type { Gov } from "../dispatch";

/**
 * Content-addressed bytes under `<data>/cas`. A digest names exactly one file, written once and never rewritten; every read re-checks
 * the digest, so a changed or truncated file reads as missing rather than as content.
 */
export function casPath(dataDir: string, digest: Digest): string {
  if (!isDigest(digest)) throw new BrainError("INVALID_INPUT", "Not a digest");
  const hex = digest.slice("sha256:".length);
  return join(dataDir, "cas", hex.slice(0, 2), hex);
}

/** Stores bytes under their digest; storing the same bytes again changes nothing. */
export function putArtifact(gov: Gov, bytes: Uint8Array): Digest {
  const digest = sha256Digest(bytes);
  const path = casPath(gov.dataDir, digest);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const partial = `${path}.${process.pid}.part`;
    writeFileSync(partial, bytes, { mode: 0o600 });
    renameSync(partial, path);
  }
  gov.db.prepare("INSERT OR IGNORE INTO artifacts(digest, bytes, created_at_ms) VALUES (?,?,?)").run(digest, bytes.length, gov.clock.nowMs());
  return digest;
}

/** The stored bytes of a digest; NOT_FOUND when they are absent or no longer match it. */
export function readArtifact(gov: Gov, digest: Digest): Uint8Array {
  const path = casPath(gov.dataDir, digest);
  if (!existsSync(path)) throw new BrainError("NOT_FOUND", `Stored content ${digest} is missing`);
  const bytes = new Uint8Array(readFileSync(path));
  if (sha256Digest(bytes) !== digest) throw new BrainError("NOT_FOUND", `Stored content ${digest} no longer matches its digest`);
  return bytes;
}

export interface ArtifactLinkInput {
  readonly digest: Digest;
  readonly workspaceId: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly name: string;
  /** `patch`, `output`, `log`, ... */
  readonly kind: string;
  readonly mediaType: string;
}
/** Records what stored bytes belong to; this is also what lets a member of the workspace download them. */
export function linkArtifact(tx: Db, link: ArtifactLinkInput, atMs: number): void {
  tx.prepare("INSERT INTO artifact_links(digest, workspace_id, task_id, attempt_id, name, kind, media_type, created_at_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(link.digest, link.workspaceId, link.taskId ?? null, link.attemptId ?? null, link.name, link.kind, link.mediaType, atMs);
}

/** The link under which this person may read the bytes: one in a workspace they can see. */
export function readableLink(gov: Gov, digest: Digest, userId: string): { name: string; mediaType: string } | undefined {
  const links = gov.db.prepare("SELECT l.workspace_id AS workspaceId, l.name, l.media_type AS mediaType FROM artifact_links l WHERE l.digest=? ORDER BY l.id").all(digest) as Array<{ workspaceId: string; name: string; mediaType: string }>;
  return links.find((link) => accessOf(gov, userId, link.workspaceId));
}
