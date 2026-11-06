import { sha256Digest } from "@brain/contracts";
import type { ActorContext, JsonValue } from "@brain/contracts";
import { requireWorkspaceRead } from "../../application/authz";
import type { Store } from "../../application/store";
import { iso } from "../../domain/clock";
import { BrainDomainError } from "../../domain/errors";
import { putBytes, putStream } from "./cas";
import { registerArtifact } from "./registry";

/**
 * Uploads (T27): an upload declares its digest and size up front, is
 * completable only by its initiator before it expires, and becomes an
 * internal artifact of its workspace. A mismatched or oversize completion
 * rejects the upload.
 */

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

interface OpenUpload { organization_id: string; workspace_id: string; expected_digest: string; expected_bytes: number }

export function initUpload(store: Store, actor: ActorContext, body: Record<string, unknown>): JsonValue {
  const s = store;
  const workspaceId = String(body["workspaceId"] ?? "");
  requireWorkspaceRead(s, actor, workspaceId);
  const id = s.id("upl");
  s.control.prepare(`INSERT INTO artifact_uploads(id, organization_id, workspace_id, initiated_by, attempt_id, expected_digest, expected_bytes, state, expires_at_ms, created_at_ms)
    VALUES (?,?,?,?,?,?,?,'open',?,?)`).run(id, actor.organizationId, workspaceId, actor.actorId, body["attemptId"] ? String(body["attemptId"]) : null,
    String(body["expectedDigest"]), Number(body["expectedBytes"] ?? 0), s.now() + 24 * 3600_000, s.now());
  return { uploadId: id, expiresAt: iso(s.now() + 24 * 3600_000) } as unknown as JsonValue;
}

function loadOpenUpload(store: Store, actor: ActorContext, uploadId: string): OpenUpload {
  const row = store.control.prepare("SELECT organization_id, workspace_id, initiated_by, expected_digest, expected_bytes, state, expires_at_ms FROM artifact_uploads WHERE id=?").get(uploadId) as
    | (OpenUpload & { initiated_by: string; state: string; expires_at_ms: number }) | undefined;
  // An upload is completable only by its initiator (T27 ownership).
  if (!row || row.organization_id !== actor.organizationId || row.initiated_by !== actor.actorId) {
    throw new BrainDomainError("NOT_FOUND", "upload not found");
  }
  if (row.state !== "open" || row.expires_at_ms <= store.now()) throw new BrainDomainError("CONFLICT", "upload closed or expired");
  return row;
}

function reject(store: Store, uploadId: string): void {
  store.control.prepare("UPDATE artifact_uploads SET state='rejected' WHERE id=?").run(uploadId);
}

function finalize(store: Store, uploadId: string, row: OpenUpload, digest: string, bytes: number): JsonValue {
  const s = store;
  const artifactId = `art-${uploadId}`;
  s.inTx(s.control, () => {
    s.control.prepare("UPDATE artifact_uploads SET state='complete', received_bytes=? WHERE id=?").run(bytes, uploadId);
    registerArtifact(s, {
      artifactId, organizationId: row.organization_id, workspaceId: row.workspace_id, digest, bytes,
      mediaType: "application/octet-stream", classification: "internal", owner: { kind: "upload", id: uploadId },
    });
  });
  return { artifactId, digest, bytes, mediaType: "application/octet-stream", classification: "internal" } as unknown as JsonValue;
}

/** Completes an upload with its whole body. */
export function completeUpload(store: Store, actor: ActorContext, uploadId: string, bytes: Uint8Array): JsonValue {
  const row = loadOpenUpload(store, actor, uploadId);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "artifact exceeds 100 MiB");
  // Hash before storing: mismatched bytes are never written.
  const digest = sha256Digest(bytes);
  if (digest !== row.expected_digest || bytes.length !== row.expected_bytes) {
    reject(store, uploadId);
    throw new BrainDomainError("INVALID_CONTRACT", "artifact digest/size mismatch");
  }
  putBytes(store, bytes);
  return finalize(store, uploadId, row, digest, bytes.length);
}

/**
 * Completes an upload from a stream: bytes go to a temp file with an
 * incremental digest, so multi-megabyte artifacts never sit whole in memory.
 * Oversize streams abort mid-flight and the upload is rejected.
 */
export async function completeUploadStream(store: Store, actor: ActorContext, uploadId: string, chunks: AsyncIterable<Uint8Array>): Promise<JsonValue> {
  const row = loadOpenUpload(store, actor, uploadId);
  let stored: { digest: string; bytes: number };
  try {
    stored = await putStream(store, chunks, { digest: row.expected_digest, bytes: row.expected_bytes, limit: MAX_UPLOAD_BYTES, tempName: uploadId });
  } catch (e) {
    reject(store, uploadId);
    throw e;
  }
  return finalize(store, uploadId, row, stored.digest, stored.bytes);
}
