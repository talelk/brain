import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { unifiedHunks } from "./diff";
import { readVerified } from "../artifacts/index";

/** Read one artifact's verified bytes; the CAS is content-addressed and re-checked. */
export function readArtifactBytes(store: Store, actor: ActorContext, artifactId: string): Uint8Array {
  const row = store.control.prepare("SELECT workspace_id, digest FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(artifactId, actor.organizationId) as
    | { workspace_id: string; digest: string } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "artifact not found");
  requireWorkspaceRead(store, actor, row.workspace_id);
  return readVerified(store, row.digest);
}

/** Resolve one artifact by id or digest within the actor's organization. */
export function artifactRowFor(store: Store, actor: ActorContext, ref: { artifactId?: string; digest?: string }): { workspaceId: string; row: Record<string, unknown> } {
  if (ref.artifactId) {
    const assoc = store.control.prepare("SELECT workspace_id FROM artifact_associations WHERE artifact_id=? AND organization_id=?").get(ref.artifactId, actor.organizationId) as { workspace_id: string } | undefined;
    if (!assoc) throw new BrainDomainError("NOT_FOUND", "artifact not found");
    requireWorkspaceRead(store, actor, assoc.workspace_id);
    const row = store.workspaceDb(assoc.workspace_id, actor.organizationId).prepare("SELECT id, digest, bytes, media_type, classification, state, created_at_ms FROM artifacts WHERE id=?").get(ref.artifactId) as Record<string, unknown> | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "artifact not found");
    return { workspaceId: assoc.workspace_id, row };
  }
  if (ref.digest) {
    const assocs = store.control.prepare("SELECT workspace_id, artifact_id FROM artifact_associations WHERE digest=? AND organization_id=?").all(ref.digest, actor.organizationId) as Array<{ workspace_id: string; artifact_id: string }>;
    for (const assoc of assocs) {
      try {
        requireWorkspaceRead(store, actor, assoc.workspace_id);
        const row = store.workspaceDb(assoc.workspace_id, actor.organizationId).prepare("SELECT id, digest, bytes, media_type, classification, state, created_at_ms FROM artifacts WHERE id=?").get(assoc.artifact_id) as Record<string, unknown> | undefined;
        if (row) return { workspaceId: assoc.workspace_id, row };
      } catch { /* no membership for this workspace; try the next association */ }
    }
    throw new BrainDomainError("NOT_FOUND", "artifact not found");
  }
  throw new BrainDomainError("INVALID_ARGUMENT", "artifactId or digest required");
}

export interface ArtifactListFilters {
  jobId?: string;
  runId?: string;
  workItemId?: string;
  state?: string;
  classification?: string;
}

/** artifacts.list: verified artifacts in the workspace, optionally scoped to a job/run/work item. */
export function listArtifacts(store: Store, actor: ActorContext, workspaceId: string, filters: ArtifactListFilters): JsonValue {
  const ws = store.workspaceDb(workspaceId, actor.organizationId);
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];
  if (filters.state) {
    if (!["uploading", "verified", "quarantined", "deleted"].includes(filters.state)) throw new BrainDomainError("INVALID_ARGUMENT", "invalid artifact state filter");
    clauses.push("state=?"); parameters.push(filters.state);
  } else {
    clauses.push("state='verified'");
  }
  if (filters.classification) {
    if (!["public", "internal", "confidential", "restricted"].includes(filters.classification)) throw new BrainDomainError("INVALID_ARGUMENT", "invalid artifact classification filter");
    clauses.push("classification=?"); parameters.push(filters.classification);
  }
  if (filters.jobId || filters.runId || filters.workItemId) {
    const jobIds = new Set<string>();
    if (filters.workItemId) {
      for (const link of ws.prepare("SELECT job_id FROM execution_links WHERE work_item_id=?").all(filters.workItemId) as Array<{ job_id: string | null }>) {
        if (link.job_id) jobIds.add(link.job_id);
      }
      for (const link of ws.prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").all(filters.workItemId) as Array<{ run_id: string }>) {
        for (const job of store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? AND organization_id=?").all(link.run_id, actor.organizationId) as Array<{ id: string }>) jobIds.add(job.id);
      }
    }
    if (filters.runId) {
      for (const job of store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? AND organization_id=?").all(filters.runId, actor.organizationId) as Array<{ id: string }>) jobIds.add(job.id);
    }
    if (filters.jobId) jobIds.add(filters.jobId);
    const attemptIds: string[] = [];
    if (jobIds.size > 0) {
      const marks = [...jobIds].map(() => "?").join(",");
      for (const attempt of store.control.prepare(`SELECT id FROM job_attempts WHERE job_id IN (${marks})`).all(...jobIds) as Array<{ id: string }>) attemptIds.push(attempt.id);
    }
    const ownerClauses: string[] = [];
    const ownerParams: Array<string | number> = [actor.organizationId, workspaceId];
    if (attemptIds.length > 0) { ownerClauses.push(`(owner_kind='attempt' AND owner_id IN (${attemptIds.map(() => "?").join(",")}))`); ownerParams.push(...attemptIds); }
    if (jobIds.size > 0) { ownerClauses.push(`(owner_kind='job' AND owner_id IN (${[...jobIds].map(() => "?").join(",")}))`); ownerParams.push(...jobIds); }
    const ids = ownerClauses.length === 0 ? [] : (store.control.prepare(`SELECT artifact_id FROM artifact_associations WHERE organization_id=? AND workspace_id=? AND (${ownerClauses.join(" OR ")})`).all(...ownerParams) as Array<{ artifact_id: string }>).map((r) => r.artifact_id);
    const boundedIds = ids.slice(0, 400);
    if (boundedIds.length === 0) return { items: [] } as unknown as JsonValue;
    clauses.push(`id IN (${boundedIds.map(() => "?").join(",")})`);
    parameters.push(...boundedIds);
  }
  const rows = ws.prepare(`SELECT id,digest,bytes,media_type,classification,created_at_ms FROM artifacts WHERE ${clauses.join(" AND ")} ORDER BY created_at_ms DESC,id LIMIT 100`).all(...parameters) as { id: string; digest: string; bytes: number; media_type: string; classification: string; created_at_ms: number }[];
  return { items: rows.map((row) => ({ artifactId: row.id, digest: row.digest, bytes: row.bytes, mediaType: row.media_type, classification: row.classification, createdAt: iso(row.created_at_ms) })) } as unknown as JsonValue;
}

/** artifacts.history: the artifact, its producing attempt/job, and every bundle that pins it. */
export function artifactHistory(store: Store, actor: ActorContext, ref: { artifactId?: string; digest?: string }): JsonValue {
  const { workspaceId, row } = artifactRowFor(store, actor, ref);
  const digest = String(row["digest"]);
  const ws = store.workspaceDb(workspaceId, actor.organizationId);
  // Producer fallback join: the association owner binds the producing
  // attempt (or job for execution artifacts) when no bundle pins the digest.
  const producerAssoc = store.control.prepare(`SELECT owner_kind, owner_id FROM artifact_associations
    WHERE artifact_id=? AND organization_id=? AND owner_kind IN ('attempt','job')
    ORDER BY CASE owner_kind WHEN 'attempt' THEN 0 ELSE 1 END LIMIT 1`).get(String(row["id"]), actor.organizationId) as { owner_kind: string; owner_id: string } | undefined;
  let producer: JsonValue | undefined;
  if (producerAssoc?.owner_kind === "attempt") {
    const attempt = store.control.prepare("SELECT id, job_id, state, attempt_no FROM job_attempts WHERE id=?").get(producerAssoc.owner_id) as Record<string, unknown> | undefined;
    if (attempt) producer = { attemptId: String(attempt["id"]), jobId: String(attempt["job_id"]), state: String(attempt["state"]), number: Number(attempt["attempt_no"]) } as unknown as JsonValue;
  } else if (producerAssoc?.owner_kind === "job") {
    producer = { jobId: producerAssoc.owner_id } as unknown as JsonValue;
  }
  // Verification lookup (stated): evidence bundles pinning the digest in
  // manifest_json, with the bundle state and the latest verdict outcome.
  const bundles = ws.prepare(`SELECT digest, bundle_id, job_id, attempt_id, state, created_at_ms FROM evidence_bundles
    WHERE EXISTS (SELECT 1 FROM json_each(evidence_bundles.manifest_json,'$.artifacts') item WHERE json_extract(item.value,'$.digest')=?)
    ORDER BY created_at_ms DESC LIMIT 50`).all(digest) as Array<Record<string, unknown>>;
  const history = bundles.map((bundle) => {
    const verdict = ws.prepare("SELECT outcome, created_at_ms FROM verification_verdicts WHERE bundle_digest=? ORDER BY created_at_ms DESC LIMIT 1").get(String(bundle["digest"])) as { outcome: string; created_at_ms: number } | undefined;
    return {
      bundleId: String(bundle["bundle_id"]), bundleDigest: String(bundle["digest"]),
      jobId: String(bundle["job_id"]), attemptId: String(bundle["attempt_id"]),
      state: String(bundle["state"]), createdAt: iso(Number(bundle["created_at_ms"])),
      ...(verdict ? { verification: { outcome: verdict.outcome, at: iso(Number(verdict.created_at_ms)) } as unknown as JsonValue } : {}),
    } as unknown as JsonValue;
  });
  return {
    artifactId: String(row["id"]), digest, bytes: Number(row["bytes"]), mediaType: String(row["media_type"]),
    classification: String(row["classification"]), state: String(row["state"]), createdAt: iso(Number(row["created_at_ms"])),
    workspaceId, ...(producer ? { producer } : {}), history,
  } as unknown as JsonValue;
}

function diffableArtifact(store: Store, actor: ActorContext, artifactId: string, maxBytes: number): { ref: Record<string, JsonValue>; text: string } {
  const { row } = artifactRowFor(store, actor, { artifactId });
  const bytes = readArtifactBytes(store, actor, String(row["id"]));
  if (bytes.length > maxBytes) throw new BrainDomainError("PAYLOAD_TOO_LARGE", `artifact exceeds the diff byte bound (${maxBytes})`);
  const mediaType = String(row["media_type"]);
  const textLike = /^text\//u.test(mediaType) || /\+(json|xml)$/u.test(mediaType)
    || /^(application\/(json|x-ndjson|xml|yaml|x-yaml|javascript|typescript|sql))$/u.test(mediaType);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!textLike || text.includes("\u0000")) {
    throw new BrainDomainError("INVALID_ARGUMENT", `artifact ${artifactId} (${mediaType || "unknown"}) is binary; diffs cover text, json, code and csv only`);
  }
  return { ref: { artifactId: String(row["id"]), digest: String(row["digest"]), bytes: Number(row["bytes"]), mediaType }, text };
}

/** artifacts.diff: unified line hunks between two text artifacts. */
export function diffArtifacts(store: Store, actor: ActorContext, leftId: string, rightId: string, maxBytes: number): JsonValue {
  const bounded = Math.min(Math.max(Math.floor(maxBytes) || 262_144, 1), 262_144);
  const left = diffableArtifact(store, actor, leftId, bounded);
  const right = diffableArtifact(store, actor, rightId, bounded);
  return {
    left: left.ref,
    right: right.ref,
    maxBytes: bounded,
    hunks: unifiedHunks(left.text.split("\n"), right.text.split("\n")) as unknown as JsonValue,
  } as unknown as JsonValue;
}

/** search.global helper: verified artifacts whose id, digest or media type match. */
export function searchArtifacts(
  store: Store,
  organizationId: string,
  workspaceId: string,
  matches: (value: unknown) => boolean,
): Array<Record<string, JsonValue>> {
  const ws = store.workspaceDb(workspaceId, organizationId);
  const artifacts = ws.prepare("SELECT id, digest, media_type, created_at_ms FROM artifacts WHERE state='verified' ORDER BY created_at_ms DESC, id LIMIT 100").all() as Array<{ id: string; digest: string; media_type: string; created_at_ms: number }>;
  const results: Array<Record<string, JsonValue>> = [];
  for (const artifact of artifacts) {
    if (matches(artifact.id) || matches(artifact.digest) || matches(artifact.media_type)) {
      results.push({ category: "artifact", title: artifact.id, reason: `${artifact.media_type} · ${artifact.digest.slice(7, 19)}`, resourceId: artifact.id, workspaceId, updatedAt: iso(artifact.created_at_ms) });
    }
  }
  return results;
}
