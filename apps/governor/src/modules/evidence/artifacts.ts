import { sha256Digest } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";
import { assertAttemptLive, loadAttempt } from "../jobs/index";
import { putBytes, registerArtifact } from "../artifacts/index";

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
  const mediaType = input.mediaType ?? "application/octet-stream";
  if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/u.test(mediaType)) throw new BrainDomainError("INVALID_CONTRACT", "artifact media type malformed");
  const identity = sha256Digest(new TextEncoder().encode(JSON.stringify({ digest, mediaType })));
  const artifactId = `att-${attemptId}-${identity.slice(7,31)}`;
  putBytes(s, bytes);
  registerArtifact(s, { artifactId, organizationId, workspaceId, digest, bytes: bytes.length, mediaType, classification: "internal", owner: { kind: "attempt", id: attemptId } });
  return { artifactId, digest, bytes: bytes.length };
}
