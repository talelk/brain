import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import type { Db } from "../../infrastructure/persistence/open";

/**
 * Artifact registration: the organization-wide association (who owns which
 * bytes, in which workspace) and the workspace's artifact row. The artifacts
 * module is the only writer of artifact_associations and artifacts.
 */

export interface ArtifactRegistration {
  artifactId: string;
  organizationId: string;
  workspaceId: string;
  digest: string;
  bytes: number;
  mediaType: string;
  classification: "internal";
  owner: { kind: "attempt" | "job" | "upload"; id: string };
}

/**
 * Registers stored bytes as an artifact. Registering the same id with the
 * same digest again is a no-op; the same id with different bytes is a
 * CONFLICT. Returns whether this call created the artifact.
 */
export function registerArtifact(store: Store, input: ArtifactRegistration): boolean {
  const s = store;
  const existing = s.control.prepare("SELECT digest FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(input.artifactId, input.organizationId) as { digest: string } | undefined;
  if (existing) {
    if (existing.digest !== input.digest) throw new BrainDomainError("CONFLICT", `artifact ${input.artifactId} is already pinned to different bytes`);
    return false;
  }
  s.control.prepare(`INSERT INTO artifact_associations(artifact_id, organization_id, workspace_id, digest, owner_kind, owner_id, classification, verified_at_ms)
    VALUES (?,?,?,?,?,?,?,?)`).run(input.artifactId, input.organizationId, input.workspaceId, input.digest, input.owner.kind, input.owner.id, input.classification, s.now());
  recordWorkspaceArtifact(s.workspaceDb(input.workspaceId, input.organizationId), input, s.now());
  return true;
}

/**
 * The workspace's artifact row alone, written through the caller's workspace
 * handle so it commits inside the caller's transaction (document versions).
 */
export function recordWorkspaceArtifact(db: Db, input: { artifactId: string; digest: string; bytes: number; mediaType: string; classification: "internal" | "workspace" }, nowMs: number): void {
  db.prepare("INSERT OR IGNORE INTO artifacts(id, digest, bytes, media_type, classification, state, created_at_ms) VALUES (?,?,?,?,?,'verified',?)")
    .run(input.artifactId, input.digest, input.bytes, input.mediaType, input.classification, nowMs);
}
