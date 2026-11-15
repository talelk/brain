import type { MemoryQuery, MemoryResult, MemoryScope } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { MemoryViewer } from "./scope";
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
  visibility: MemoryScope["visibility"]; team_id: string | null; owner_id: string | null;
  source_type: string; status: "reviewed" | "unverified"; title: string; self_reviewed: number; created_at_ms: number; rank: number;
};

/** Source types the local store answers itself even when a remote memory service is configured. */
export const LOCAL_ONLY_SOURCE_TYPES: readonly string[] = ["knowledge", "document"];

export interface MemoryPublishInput {
  organizationId: string; workspaceId: string | null; sourceId: string; text: string;
  /** Who may read it; omitted means the workspace (or every workspace when `workspaceId` is null). A team asset also names its mission, a private one its author. */
  visibility?: MemoryScope["visibility"]; teamId?: string; ownerId?: string;
  sourceType?: "chat" | "skill" | "wiki" | "codegraph" | "knowledge";
  status?: "reviewed" | "unverified"; title?: string; selfReviewed?: boolean;
}

function scopeOfRow(a: AssetRow): MemoryScope {
  if (a.visibility === "team" && a.team_id) return { organizationId: a.organization_id, visibility: "team", teamId: a.team_id };
  if (a.visibility === "private" && a.workspace_id && a.owner_id) return { organizationId: a.organization_id, visibility: "private", workspaceId: a.workspace_id, ownerId: a.owner_id };
  if (a.workspace_id) return { organizationId: a.organization_id, visibility: "workspace", workspaceId: a.workspace_id };
  return { organizationId: a.organization_id, visibility: "global-approved" };
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
    const visibility = input.visibility ?? (input.workspaceId ? "workspace" : "global-approved");
    if ((visibility === "global-approved") !== (input.workspaceId === null)) throw new BrainDomainError("INVALID_ARGUMENT", "only global memory has no workspace");
    if (visibility === "team" && !input.teamId) throw new BrainDomainError("INVALID_ARGUMENT", "team memory names its team");
    if (visibility === "private" && !input.ownerId) throw new BrainDomainError("INVALID_ARGUMENT", "private memory names its author");
    const teamId = visibility === "team" ? input.teamId ?? null : null;
    const ownerId = visibility === "private" ? input.ownerId ?? null : null;
    const c = this.store.control;
    // Idempotent per source: a crash between this write and the caller's follow-up write is safe to retry. A source is one asset in every
    // scope, so publishing it again at another scope is refused: publication never widens (or moves) what exists; promotion is a review (setScope).
    const existing = c.prepare("SELECT id, visibility, workspace_id, team_id, owner_id FROM memory_assets WHERE organization_id=? AND source_id=? AND revoked=0").get(input.organizationId, input.sourceId) as
      | { id: string; visibility: string; workspace_id: string | null; team_id: string | null; owner_id: string | null } | undefined;
    if (existing) {
      if (existing.visibility !== visibility || existing.workspace_id !== input.workspaceId || existing.team_id !== teamId || existing.owner_id !== ownerId) {
        throw new BrainDomainError("CONFLICT", "this memory is already published at another scope; a wider scope needs a review of its own");
      }
      return existing.id;
    }
    const id = this.store.id("mem");
    const title = input.title ?? "";
    this.store.inTx(c, () => {
      c.prepare("INSERT INTO memory_assets(id, organization_id, workspace_id, source_id, body, acl_generation, source_type, status, title, self_reviewed, created_at_ms, visibility, team_id, owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, input.organizationId, input.workspaceId, input.sourceId, input.text, 1, input.sourceType ?? "wiki", input.status ?? "unverified", title, input.selfReviewed ? 1 : 0, this.store.now(), visibility, teamId, ownerId);
      c.prepare("INSERT INTO memory_fts(asset_id,title,body) VALUES (?,?,?)").run(id, title, input.text);
    });
    return id;
  }

  /**
   * Moves one published asset of a workspace to another scope in place. The caller has decided it may (a review for a wider scope);
   * team and private rows keep their workspace. Returns false when the asset is not published here.
   */
  setScope(organizationId: string, workspaceId: string, sourceId: string, target: { visibility: "workspace" | "team" | "private"; teamId?: string; ownerId?: string }, selfReviewed?: boolean): boolean {
    const c = this.store.control;
    const row = c.prepare("SELECT id FROM memory_assets WHERE organization_id=? AND workspace_id=? AND source_id=? AND revoked=0").get(organizationId, workspaceId, sourceId) as { id: string } | undefined;
    if (!row) return false;
    c.prepare("UPDATE memory_assets SET visibility=?, team_id=?, owner_id=?, self_reviewed=COALESCE(?, self_reviewed) WHERE id=?")
      .run(target.visibility, target.visibility === "team" ? target.teamId ?? null : null, target.visibility === "private" ? target.ownerId ?? null : null, selfReviewed === undefined ? null : selfReviewed ? 1 : 0, row.id);
    return true;
  }

  revoke(organizationId: string, workspaceId: string, sourceId: string): void {
    const c = this.store.control;
    this.store.inTx(c, () => {
      const rows = c.prepare("SELECT id FROM memory_assets WHERE organization_id=? AND workspace_id=? AND source_id=? AND revoked=0").all(organizationId, workspaceId, sourceId) as Array<{ id: string }>;
      c.prepare("UPDATE memory_assets SET revoked=1 WHERE organization_id=? AND workspace_id=? AND source_id=?").run(organizationId, workspaceId, sourceId);
      for (const row of rows) c.prepare("DELETE FROM memory_fts WHERE asset_id=?").run(row.id);
    });
  }

  search(query: MemoryQuery, scope: { organizationId: string; workspaceId: string }, viewer: MemoryViewer): { results: MemoryResult[]; degraded: boolean; store: "local"; storeLabel: string; reason?: string } {
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
        // Scope is enforced here on every read: global memory, then in this workspace what is workspace-wide, what belongs to a team the viewer
        // is on, and what the viewer authored. Nothing else matches, whatever the query's own claimed scope says.
        const teams = viewer.teamIds.slice(0, 500);
        const rows = this.store.control.prepare(`SELECT a.*, bm25(memory_fts, 1.0, 3.0, 1.0) AS rank FROM memory_fts f JOIN memory_assets a ON a.id=f.asset_id
          WHERE memory_fts MATCH ? AND a.revoked=0 AND a.organization_id=?
            AND (a.visibility='global-approved' OR (a.workspace_id=? AND (a.visibility='workspace'
              OR (a.visibility='team' AND a.team_id IN (${teams.map(() => "?").join(",") || "NULL"}))
              OR (a.visibility='private' AND a.owner_id IS NOT NULL AND a.owner_id=?))))
            AND a.source_type IN (${assetTypes.map(() => "?").join(",")})
          ORDER BY rank, a.created_at_ms DESC LIMIT ?`).all(ftsOr(terms), scope.organizationId, scope.workspaceId, ...teams, viewer.ownerId ?? "", ...assetTypes, limit) as AssetRow[];
        for (const a of rows) {
          ranked.push({ rank: a.rank, at: a.created_at_ms, result: {
            sourceId: a.source_id,
            scope: scopeOfRow(a),
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
          WHERE document_fts MATCH ? AND d.state='active'
            AND NOT EXISTS (SELECT 1 FROM knowledge_assets k WHERE k.operation_id='saved-document' AND k.state='published' AND k.superseded_by IS NULL AND json_extract(k.provenance_json,'$[0].rootRunId')=d.id)
          ORDER BY rank, d.updated_at_ms DESC LIMIT ?`).all(ftsOr(terms), limit) as Array<{ id: string; title: string; updated_at_ms: number; version_id: string; extracted_text: string | null; rank: number }>;
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
    const count = (this.store.control.prepare("SELECT COUNT(*) AS n FROM memory_assets WHERE organization_id=? AND revoked=0 AND visibility IN ('global-approved','workspace') AND (workspace_id=? OR workspace_id IS NULL)").get(organizationId, workspaceId) as { n: number }).n;
    // TencentDB Wiki/CodeGraph are not exported by the local store: honest partial.
    return { completeness: "partial", missing: ["tencentdb-wiki", "tencentdb-codegraph"], count };
  }
}
