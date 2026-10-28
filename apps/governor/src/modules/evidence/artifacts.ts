import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Digest } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";
import { assertAttemptLive, casPathOf, loadAttempt } from "../jobs/index";

/**
 * Attempt-scoped artifact ingestion (T27): a runner pins its exact output
 * bytes into the organization's CAS under its live attempt. Ownership binds
 * to the attempt, the digest must match the bytes, and the attempt must be
 * current — a fenced or expired attempt cannot publish artifacts.
 */
export function acceptAttemptArtifact(
  s: Store,
  runner: { runnerId: string; epoch: number; organizationId: string },
  attemptId: string,
  input: { digest: string; bytesBase64: string; mediaType?: string },
): { artifactId: string; digest: string; bytes: number } {
  const row = loadAttempt(s, attemptId);
  assertAttemptLive(s, { runnerId: runner.runnerId, epoch: runner.epoch }, row);
  if (String(row["organization_id"]) !== runner.organizationId) throw new BrainDomainError("FORBIDDEN", "attempt tenant mismatch");
  if (String(row["state"]) !== "running") throw new BrainDomainError("CONFLICT", "attempt is not running; artifacts bind to live attempts");
  const bytes = new Uint8Array(Buffer.from(input.bytesBase64, "base64"));
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "attempt artifact must be 1 byte..8 MiB");
  const digest = sha256Digest(bytes);
  if (digest !== input.digest) throw new BrainDomainError("INVALID_CONTRACT", "artifact digest does not match bytes");
  const organizationId = String(row["organization_id"]);
  const workspaceId = String(row["workspace_id"]);
  const artifactId = `att-${attemptId}-${digest.slice(7, 19)}`;
  const existing = s.control.prepare("SELECT digest FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(artifactId, organizationId) as { digest: string } | undefined;
  if (existing && existing.digest !== digest) throw new BrainDomainError("CONFLICT", "attempt artifact id already pinned to different bytes");
  const path = casPathOf(s.dataDir, digest);
  mkdirSync(join(path, ".."), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, bytes);
  if (!existing) {
    s.control.prepare(`INSERT INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms)
      VALUES (?,?,?,?,'attempt',?,'internal',?)`).run(artifactId, organizationId, workspaceId, digest, attemptId, s.now());
    const ws = s.workspaceDb(workspaceId, organizationId);
    ws.prepare("INSERT OR IGNORE INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES (?,?,?,?, 'internal','verified',?)")
      .run(artifactId, digest, bytes.length, input.mediaType ?? "application/octet-stream", s.now());
  }
  return { artifactId, digest, bytes: bytes.length };
}
