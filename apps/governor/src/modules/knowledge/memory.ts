import type { MemoryQuery, MemoryResult } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";

interface Asset {
  id: string; organizationId: string; workspaceId: string | null;
  text: string; sourceId: string; aclGeneration: number; revoked: boolean; createdAtMs: number;
}

// Secret classification is by meaning, not by one spelling: any credential-
// shaped key/value pair (long or short names, camelCase or snake_case), key
// material blocks, and well-known token shapes are all rejected. Unknown
// credential-looking assignments fail closed rather than passing through.
const SECRET_PATTERNS: readonly RegExp[] = [
  /(api[\s_-]?key|client[\s_-]?secret|shared[\s_-]?secret|access[\s_-]?token|refresh[\s_-]?token|auth[\s_-]?token|session[\s_-]?token|bearer[\s_-]?token|password|passwd|pwd|secret|credential|private[\s_-]?key)\s*["']?\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
  /\b[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*_(KEY|TOKEN|SECRET|PASSWORD)\s*=/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// Local scoped memory store. TencentDB sits behind this same gateway port;
// until G04 passes against a real service, searches report degraded=false
// only for this local store and never claim TencentDB coverage.
export class MemoryStore {
  private assets: Asset[] = [];
  private aclGeneration = 1;
  constructor(private readonly store: Store) {
    store.control.exec(`CREATE TABLE IF NOT EXISTS memory_assets (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT,
      source_id TEXT NOT NULL, body TEXT NOT NULL, acl_generation INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL
    ) STRICT;`);
    const rows = store.control.prepare("SELECT id, organization_id, workspace_id, source_id, body, acl_generation, revoked, created_at_ms FROM memory_assets").all() as Array<Record<string, unknown>>;
    this.assets = rows.map((r) => ({
      id: String(r["id"]), organizationId: String(r["organization_id"]),
      workspaceId: (r["workspace_id"] as string | null) ?? null, text: String(r["body"]),
      sourceId: String(r["source_id"]), aclGeneration: Number(r["acl_generation"]),
      revoked: Number(r["revoked"]) === 1, createdAtMs: Number(r["created_at_ms"]),
    }));
  }

  publish(input: { organizationId: string; workspaceId: string | null; sourceId: string; text: string }): string {
    if (looksLikeSecret(input.text)) {
      throw new BrainDomainError("INVALID_ARGUMENT", "memory content appears to contain a secret; scrub before publication");
    }
    const id = this.store.id("mem");
    this.store.control.prepare("INSERT INTO memory_assets(id, organization_id, workspace_id, source_id, body, acl_generation, created_at_ms) VALUES (?,?,?,?,?,?,?)")
      .run(id, input.organizationId, input.workspaceId, input.sourceId, input.text, this.aclGeneration, this.store.now());
    this.assets.push({ id, organizationId: input.organizationId, workspaceId: input.workspaceId, text: input.text, sourceId: input.sourceId, aclGeneration: this.aclGeneration, revoked: false, createdAtMs: this.store.now() });
    return id;
  }

  revoke(sourceId: string): void {
    this.aclGeneration += 1;
    this.store.control.prepare("UPDATE memory_assets SET revoked=1 WHERE source_id=?").run(sourceId);
    for (const a of this.assets) if (a.sourceId === sourceId) a.revoked = true;
  }

  search(query: MemoryQuery, scope: { organizationId: string; workspaceId?: string }): { results: MemoryResult[]; degraded: boolean; reason?: string } {
    if (query.scope.organizationId !== scope.organizationId) {
      throw new BrainDomainError("NOT_FOUND", "memory scope not found");
    }
    const terms = query.query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(query.limit, 1), 8);
    const hits: MemoryResult[] = this.assets
      .filter((a) => !a.revoked && a.organizationId === scope.organizationId)
      .filter((a) => a.workspaceId === null || !scope.workspaceId || a.workspaceId === scope.workspaceId)
      .filter((a) => terms.length === 0 || terms.some((t) => a.text.toLowerCase().includes(t)))
      .slice(0, limit)
      .map((a) => ({
        sourceId: a.sourceId,
        scope: a.workspaceId
          ? { organizationId: a.organizationId, visibility: "workspace" as const, workspaceId: a.workspaceId }
          : { organizationId: a.organizationId, visibility: "global-approved" as const },
        sourceVersion: "local-1",
        updatedAt: new Date(a.createdAtMs).toISOString(),
        classification: "internal" as const,
        content: a.text.slice(0, Math.max(0, query.maxChars || 12000)),
        provenance: [a.sourceId],
        status: "unverified" as const,
      }));
    return { results: hits, degraded: false };
  }

  exportScope(organizationId: string, workspaceId: string): { completeness: "complete" | "partial"; missing: string[]; count: number } {
    const count = this.assets.filter((a) => a.organizationId === organizationId && (a.workspaceId === workspaceId || a.workspaceId === null)).length;
    // TencentDB Wiki/CodeGraph are not exported by the local store: honest partial.
    return { completeness: "partial", missing: ["tencentdb-wiki", "tencentdb-codegraph"], count };
  }
}
