import type { MemoryQuery, MemoryResult } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";

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
  // eslint-disable-next-line security/detect-unsafe-regex -- Linear, bounded secret-name matcher.
  /\b[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*_(KEY|TOKEN|SECRET|PASSWORD)\s*=/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** Words that never carry a topic: "the" must not make an unrelated goal match. */
const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "that", "the", "this", "to", "was", "we", "with", "you", "your", "do", "does", "can", "how", "what", "which", "will", "about", "into", "than", "then", "there", "their", "these", "those", "us", "who", "why", "also"]);

/** The distinct topical words of a sentence, lower-cased, for an FTS5 OR query. */
export function ftsTerms(text: string, max = 12): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** Terms as quoted FTS5 phrases joined by OR; quoting keeps user text from being read as syntax. */
export const ftsOr = (terms: readonly string[]): string => terms.map((term) => `"${term}"`).join(" OR ");

type AssetRow = {
  id: string; organization_id: string; workspace_id: string | null; source_id: string; body: string;
  source_type: string; status: "reviewed" | "unverified"; title: string; self_reviewed: number; created_at_ms: number; rank: number;
};

/** Source types the local store answers itself even when a remote memory service is configured. */
export const LOCAL_ONLY_SOURCE_TYPES: readonly string[] = ["knowledge", "document"];

export interface MemoryPublishInput {
  organizationId: string; workspaceId: string | null; sourceId: string; text: string;
  sourceType?: "chat" | "skill" | "wiki" | "codegraph" | "knowledge";
  status?: "reviewed" | "unverified"; title?: string; selfReviewed?: boolean;
}

// Local scoped memory store (#75): one SQLite FTS5 index in control.db over published
// memory assets, plus the workspace's saved documents read live from their own FTS index.
// TencentDB sits behind this same gateway port and is never claimed as covered here.
export class MemoryStore {
  constructor(private readonly store: Store) {}

  publish(input: MemoryPublishInput): string {
    if (looksLikeSecret(input.text) || looksLikeSecret(input.title ?? "")) {
      throw new BrainDomainError("INVALID_ARGUMENT", "memory content appears to contain a secret; scrub before publication");
    }
    const c = this.store.control;
    // Idempotent per source: a crash between this write and the caller's follow-up write is safe to retry.
    const existing = c.prepare("SELECT id FROM memory_assets WHERE organization_id=? AND COALESCE(workspace_id,'')=? AND source_id=? AND revoked=0").get(input.organizationId, input.workspaceId ?? "", input.sourceId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = this.store.id("mem");
    const title = input.title ?? "";
    this.store.inTx(c, () => {
      c.prepare("INSERT INTO memory_assets(id, organization_id, workspace_id, source_id, body, acl_generation, source_type, status, title, self_reviewed, created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, input.organizationId, input.workspaceId, input.sourceId, input.text, 1, input.sourceType ?? "wiki", input.status ?? "unverified", title, input.selfReviewed ? 1 : 0, this.store.now());
      c.prepare("INSERT INTO memory_fts(asset_id,title,body) VALUES (?,?,?)").run(id, title, input.text);
    });
    return id;
  }

  revoke(organizationId: string, workspaceId: string, sourceId: string): void {
    const c = this.store.control;
    this.store.inTx(c, () => {
      const rows = c.prepare("SELECT id FROM memory_assets WHERE organization_id=? AND workspace_id=? AND source_id=? AND revoked=0").all(organizationId, workspaceId, sourceId) as Array<{ id: string }>;
      c.prepare("UPDATE memory_assets SET revoked=1 WHERE organization_id=? AND workspace_id=? AND source_id=?").run(organizationId, workspaceId, sourceId);
      for (const row of rows) c.prepare("DELETE FROM memory_fts WHERE asset_id=?").run(row.id);
    });
  }

  search(query: MemoryQuery, scope: { organizationId: string; workspaceId?: string }): { results: MemoryResult[]; degraded: boolean; store: "local"; storeLabel: string; reason?: string } {
    if (query.scope.organizationId !== scope.organizationId) {
      throw new BrainDomainError("NOT_FOUND", "memory scope not found");
    }
    const terms = ftsTerms(query.query);
    const limit = Math.min(Math.max(query.limit, 1), 8);
    const maxChars = Math.max(0, query.maxChars || 12000);
    const types = new Set<string>(query.sourceTypes?.length ? query.sourceTypes : ["chat", "skill", "wiki", "codegraph", "knowledge", "document"]);
    const ranked: Array<{ rank: number; at: number; result: MemoryResult }> = [];
    if (terms.length > 0) {
      const assetTypes = ["chat", "skill", "wiki", "codegraph", "knowledge"].filter((type) => types.has(type));
      if (assetTypes.length > 0) {
        const rows = this.store.control.prepare(`SELECT a.*, bm25(memory_fts, 1.0, 3.0, 1.0) AS rank FROM memory_fts f JOIN memory_assets a ON a.id=f.asset_id
          WHERE memory_fts MATCH ? AND a.revoked=0 AND a.organization_id=? AND (a.workspace_id IS NULL OR ? IS NULL OR a.workspace_id=?)
            AND a.source_type IN (${assetTypes.map(() => "?").join(",")})
          ORDER BY rank, a.created_at_ms DESC LIMIT ?`).all(ftsOr(terms), scope.organizationId, scope.workspaceId ?? null, scope.workspaceId ?? null, ...assetTypes, limit) as AssetRow[];
        for (const a of rows) {
          ranked.push({ rank: a.rank, at: a.created_at_ms, result: {
            sourceId: a.source_id,
            scope: a.workspace_id
              ? { organizationId: a.organization_id, visibility: "workspace" as const, workspaceId: a.workspace_id }
              : { organizationId: a.organization_id, visibility: "global-approved" as const },
            sourceVersion: "local-1", updatedAt: new Date(a.created_at_ms).toISOString(), classification: "internal" as const,
            content: a.body.slice(0, maxChars), provenance: [a.source_id], status: a.status,
            ...(a.title ? { title: a.title } : {}), sourceType: a.source_type as NonNullable<MemoryResult["sourceType"]>,
            ...(a.self_reviewed ? { selfReviewed: true } : {}),
          } });
        }
      }
      if (types.has("document") && scope.workspaceId) {
        const db = this.store.workspaceDb(scope.workspaceId, scope.organizationId);
        const docs = db.prepare(`SELECT d.id, d.title, d.updated_at_ms, v.id AS version_id, v.extracted_text, bm25(document_fts, 1.0, 1.0, 3.0, 1.0) AS rank
          FROM document_fts f JOIN documents d ON d.id=f.document_id JOIN document_versions v ON v.id=d.current_version_id
          WHERE document_fts MATCH ? AND d.state='active' ORDER BY rank, d.updated_at_ms DESC LIMIT ?`).all(ftsOr(terms), limit) as Array<{ id: string; title: string; updated_at_ms: number; version_id: string; extracted_text: string | null; rank: number }>;
        for (const d of docs) {
          ranked.push({ rank: d.rank, at: d.updated_at_ms, result: {
            sourceId: d.id,
            scope: { organizationId: scope.organizationId, visibility: "workspace" as const, workspaceId: scope.workspaceId },
            sourceVersion: d.version_id, updatedAt: new Date(d.updated_at_ms).toISOString(), classification: "internal" as const,
            content: (d.extracted_text ?? d.title).slice(0, maxChars) || d.title, provenance: [d.id], status: "unverified" as const,
            title: d.title, sourceType: "document",
          } });
        }
      }
    }
    ranked.sort((x, y) => x.rank - y.rank || y.at - x.at);
    return { results: ranked.slice(0, limit).map((entry) => entry.result), degraded: false, store: "local", storeLabel: "Local store" };
  }

  exportScope(organizationId: string, workspaceId: string): { completeness: "complete" | "partial"; missing: string[]; count: number } {
    const count = (this.store.control.prepare("SELECT COUNT(*) AS n FROM memory_assets WHERE organization_id=? AND (workspace_id=? OR workspace_id IS NULL)").get(organizationId, workspaceId) as { n: number }).n;
    // TencentDB Wiki/CodeGraph are not exported by the local store: honest partial.
    return { completeness: "partial", missing: ["tencentdb-wiki", "tencentdb-codegraph"], count };
  }
}
