import type { ActorContext, Agent, Evaluator, JsonValue, Workflow } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { putBytes, readVerified } from "../artifacts/index";
import { requireConfigurationAdmin } from "./activation";
import { compileRelease, type AgentInstruction, type SourceDoc, type ToolScript } from "./compiler";

/**
 * Release storage: the configuration module is the only writer of
 * config_releases, release_files and active_config. A release is
 * content-addressed but owned per organization, so every read is keyed by
 * (organization, digest). Other modules read releases through the typed
 * records below, never through their own SQL.
 */

/** The stored body of a compiled release. */
export interface StoredRelease {
  manifest: {
    documents: Array<{ kind: string; id: string; digest: string }>;
    tools?: Array<{ id: string; digest: string; effectClass: "read" | "write" | "privileged"; inputSchemaRef: string; outputSchemaRef: string }>;
    primitiveVersions?: Record<string, string>;
    compilerDigest?: string;
  } & Record<string, unknown>;
  workflows?: Record<string, Workflow>;
  agents?: Record<string, Agent>;
  evaluators?: Record<string, Evaluator>;
  tools?: unknown;
  schemas?: Record<string, JsonValue>;
}

/** One organization's release. */
export interface ReleaseRecord {
  readonly digest: string;
  readonly sourceRevision: string;
  readonly compilerDigest: string;
  readonly release: StoredRelease;
}

interface ReleaseRow { digest: string; source_revision: string; compiler_digest: string; manifest_json: string }

const toRecord = (row: ReleaseRow): ReleaseRecord => ({
  digest: row.digest, sourceRevision: row.source_revision, compilerDigest: row.compiler_digest, release: JSON.parse(row.manifest_json) as StoredRelease,
});

/** The organization's release with this digest, if it staged one. */
export function releaseRecord(store: Store, organizationId: string, digest: string): ReleaseRecord | undefined {
  const row = store.control.prepare("SELECT digest, source_revision, compiler_digest, manifest_json FROM config_releases WHERE organization_id=? AND digest=?").get(organizationId, digest) as ReleaseRow | undefined;
  return row ? toRecord(row) : undefined;
}

/** The organization's active release, if one is active. */
export function activeReleaseRecord(store: Store, organizationId: string): ReleaseRecord | undefined {
  const row = store.control.prepare(`SELECT r.digest, r.source_revision, r.compiler_digest, r.manifest_json FROM active_config a
    JOIN config_releases r ON r.organization_id=a.organization_id AND r.digest=a.release_digest WHERE a.organization_id=?`).get(organizationId) as ReleaseRow | undefined;
  return row ? toRecord(row) : undefined;
}

/** Organizations that have an active release. */
export function organizationsWithActiveRelease(store: Store): string[] {
  return (store.control.prepare("SELECT organization_id FROM active_config ORDER BY organization_id").all() as Array<{ organization_id: string }>).map((r) => r.organization_id);
}

/** A workflow of the organization's active release, pinned to that release's digest. */
export function activeWorkflow(store: Store, organizationId: string, workflowId: string): { workflow: Workflow; configDigest: string } {
  const active = activeReleaseRecord(store, organizationId);
  if (!active) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "no active config release");
  const workflow = active.release.workflows?.[workflowId];
  if (!workflow) throw new BrainDomainError("NOT_FOUND", `workflow ${workflowId} not in active release`);
  return { workflow, configDigest: active.digest };
}

/** The source documents the active release was compiled from (draft seeding). */
export function activeSourceDocuments(store: Store, organizationId: string): SourceDoc[] {
  const row = store.control.prepare(`SELECT r.source_documents_json FROM active_config a
    JOIN config_releases r ON r.organization_id=a.organization_id AND r.digest=a.release_digest WHERE a.organization_id=?`).get(organizationId) as { source_documents_json: string } | undefined;
  return row ? JSON.parse(row.source_documents_json) as SourceDoc[] : [];
}

/** The active release's schemas and stored files as editable text assets (draft seeding). */
export function activeReleaseAssets(store: Store, organizationId: string): Array<{ path: string; text: string }> {
  const active = activeReleaseRecord(store, organizationId);
  if (!active) return [];
  const schemas = Object.entries(active.release.schemas ?? {}).map(([path, schema]) => ({ path, text: `${JSON.stringify(schema, null, 2)}\n` }));
  const files = store.control.prepare("SELECT entrypoint,digest FROM release_files WHERE release_digest=?").all(active.digest) as Array<{ entrypoint: string; digest: string }>;
  return [...schemas, ...files.map((file) => ({ path: file.entrypoint, text: Buffer.from(readVerified(store, file.digest)).toString("utf8") }))];
}

/** The organization's 50 most recent releases, marking the active one. */
export function listReleases(store: Store, actor: ActorContext): JsonValue {
  requireConfigurationAdmin(store, actor);
  const active = activeReleaseRecord(store, actor.organizationId);
  const rows = store.control.prepare("SELECT digest,source_revision,manifest_json,created_at_ms FROM config_releases WHERE organization_id=? ORDER BY created_at_ms DESC LIMIT 50").all(actor.organizationId) as Array<{ digest: string; source_revision: string; manifest_json: string; created_at_ms: number }>;
  return { items: rows.map((row) => {
    const stored = JSON.parse(row.manifest_json) as { manifest?: { documents?: Array<{ kind: string }> } };
    const documents = stored.manifest?.documents ?? [];
    return { digest: row.digest, sourceRevision: row.source_revision, createdAt: iso(row.created_at_ms), active: row.digest === active?.digest,
      agents: documents.filter((doc) => doc.kind === "Agent").length, workflows: documents.filter((doc) => doc.kind === "Workflow").length,
      assets: documents.filter((doc) => doc.kind !== "Agent" && doc.kind !== "Workflow").length };
  }) } as JsonValue;
}

/** One release's full stored body, with the active digest for a compare-and-swap activation. */
export function inspectRelease(store: Store, actor: ActorContext, digest: string): JsonValue {
  requireConfigurationAdmin(store, actor);
  const record = releaseRecord(store, actor.organizationId, digest);
  if (!record) throw new BrainDomainError("NOT_FOUND", "config release not found");
  const active = activeReleaseRecord(store, actor.organizationId);
  return { digest: record.digest, sourceRevision: record.sourceRevision, expectedActiveDigest: active?.digest ?? null, ...record.release } as unknown as JsonValue;
}

/** Compiles and stages an immutable release for the organization; activates nothing. */
export function stageRelease(store: Store, actor: ActorContext, docs: readonly SourceDoc[], sourceRevision: string, scripts?: readonly ToolScript[], instructions: readonly AgentInstruction[] = [], schemas: readonly SourceDoc[] = []): { digest: string } {
  requireConfigurationAdmin(store, actor);
  const request = validate("ReleaseStageRequest",{ documents: docs, sourceRevision, scripts, instructions, schemas });
  if (!request.ok) throw new BrainDomainError("INVALID_CONTRACT",request.errors.join("; "));
  if (!/^(sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/u.test(sourceRevision)) {
    throw new BrainDomainError("INVALID_CONTRACT", "sourceRevision must be sha1:<40 hex> or sha256:<64 hex>");
  }
  if (scripts && scripts.length > 64) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "too many tool scripts");
  if (instructions.length > 100) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "too many agent instruction assets");
  for (const script of scripts ?? []) {
    if (!/^[A-Za-z0-9._-]+$/u.test(script.entrypoint) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(script.toolId)) {
      throw new BrainDomainError("INVALID_CONTRACT", "tool script toolId/entrypoint malformed");
    }
    if (Buffer.from(script.bytesBase64, "base64").length > 1024 * 1024) {
      throw new BrainDomainError("PAYLOAD_TOO_LARGE", "tool script exceeds 1 MiB");
    }
  }
  for (const instruction of instructions) {
    const bytes = Buffer.byteLength(instruction.text, "utf8");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(instruction.agentId) || !/^[A-Za-z0-9][A-Za-z0-9/_-]*\.md$/u.test(instruction.path) || instruction.path.includes("..")) {
      throw new BrainDomainError("INVALID_CONTRACT", "agent instruction agentId/path malformed");
    }
    if (bytes > 256 * 1024) throw new BrainDomainError("PAYLOAD_TOO_LARGE", "agent instructions exceed 256 KiB");
  }
  const compiled = compileRelease(docs, sourceRevision, scripts, instructions, schemas);
  const s = store;
  s.inTx(s.control, () => {
    const compilerDigest = (compiled.manifest as { compilerDigest?: string }).compilerDigest ?? compiled.digest;
    s.control.prepare("INSERT OR IGNORE INTO config_releases(digest, organization_id, source_revision, compiler_digest, source_documents_json, manifest_json, created_at_ms) VALUES (?,?,?,?,?,?,?)")
      .run(compiled.digest, actor.organizationId, sourceRevision, compilerDigest, JSON.stringify(docs), JSON.stringify({ manifest: compiled.manifest, workflows: compiled.workflows, agents: compiled.agents, evaluators: compiled.evaluators, tools: compiled.tools, schemas: compiled.schemas }), s.now());
    for (const script of scripts ?? []) {
      const bytes = new Uint8Array(Buffer.from(script.bytesBase64, "base64"));
      const digest = putBytes(s, bytes);
      s.control.prepare("INSERT OR REPLACE INTO release_files(release_digest, tool_id, entrypoint, digest, bytes, created_at_ms) VALUES (?,?,?,?,?,?)")
        .run(compiled.digest, script.toolId, script.entrypoint, digest, bytes.length, s.now());
    }
    for (const instruction of instructions) {
      const bytes = new TextEncoder().encode(instruction.text);
      const digest = putBytes(s, bytes);
      s.control.prepare("INSERT OR REPLACE INTO release_files(release_digest, tool_id, entrypoint, digest, bytes, created_at_ms) VALUES (?,?,?,?,?,?)")
        .run(compiled.digest, `agent:${instruction.agentId}`, instruction.path, digest, bytes.length, s.now());
    }
    s.emit(s.control, { organizationId: actor.organizationId, aggregateType: "config", aggregateId: compiled.digest, eventType: "config.compiled", payload: { digest: compiled.digest } });
  });
  return { digest: compiled.digest };
}
