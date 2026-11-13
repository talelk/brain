import type { Store } from "../../application/store";

type Db = ReturnType<Store["workspaceDb"]>;

/** A knowledge entry stays offered this long after it was written or last helped. */
export const KNOWLEDGE_TTL_MS = 90 * 86_400_000;

/**
 * "Helped N times" and the expiry of one knowledge entry, computed from records, never stored twice. An entry helped when a mission
 * kept it as a starting point, used it, and then achieved its goal. Each such mission also renews the entry for another period, so
 * knowledge that keeps helping stays and knowledge nobody uses ages out.
 */
export function knowledgeLife(db: Db, asset: { id: string; created_at_ms: number; expires_at_ms: number | null }): { helpedCount: number; expiresAtMs: number } {
  const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(m.updated_at_ms),0) AS last FROM reuse_attachments a JOIN missions m ON m.id=a.mission_id
    WHERE a.item_ref=? AND a.used=1 AND a.decision='kept' AND m.state='closed' AND m.outcome='achieved'`).get(`knowledge:${asset.id}`) as { n: number; last: number };
  const base = asset.expires_at_ms ?? asset.created_at_ms + KNOWLEDGE_TTL_MS;
  return { helpedCount: row.n, expiresAtMs: Math.max(base, row.last > 0 ? row.last + KNOWLEDGE_TTL_MS : 0) };
}

export function knowledgeExpired(db: Db, asset: { id: string; created_at_ms: number; expires_at_ms: number | null }, now: number): boolean {
  return knowledgeLife(db, asset).expiresAtMs <= now;
}
