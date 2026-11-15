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

/** One source a knowledge asset was built from, as it stood when the asset was written (or last re-confirmed). */
export interface SourceFingerprint { kind: "document" | "output"; id: string; title: string; digest: string }
export interface StaleChange { kind: "document" | "output"; id: string; title: string; what: "revised" | "removed" | "superseded" }

/**
 * The sources a mission's write-up rests on, fingerprinted now: the documents associated with the mission or its tasks (by version
 * digest) and the mission's verified outputs, the evidence the write-up quotes (by their latest verified version). Deterministic, no model.
 */
export function fingerprintSources(db: Db, missionId: string): SourceFingerprint[] {
  const documents = db.prepare(`SELECT DISTINCT d.id, d.title, v.digest FROM resource_associations a JOIN documents d ON d.id=a.document_id AND d.state='active'
    JOIN document_versions v ON v.id=d.current_version_id
    WHERE (a.resource_kind='mission' AND a.resource_id=?) OR (a.resource_kind='workItem' AND a.resource_id IN (SELECT id FROM work_items WHERE mission_id=?))
    ORDER BY d.id LIMIT 50`).all(missionId, missionId) as Array<{ id: string; title: string; digest: string }>;
  const outputs = db.prepare(`SELECT o.id, o.name, (SELECT v.id FROM output_versions v WHERE v.output_id=o.id AND v.verified=1 ORDER BY v.created_at_ms DESC, v.id DESC LIMIT 1) AS version
    FROM mission_outputs o WHERE o.mission_id=? ORDER BY o.id LIMIT 50`).all(missionId) as Array<{ id: string; name: string; version: string | null }>;
  return [
    ...documents.map((row): SourceFingerprint => ({ kind: "document", id: row.id, title: row.title.slice(0, 256), digest: row.digest })),
    ...outputs.flatMap((row): SourceFingerprint[] => (row.version ? [{ kind: "output", id: row.id, title: row.name.slice(0, 256), digest: row.version }] : [])),
  ];
}

/** What changed in the live sources since the fingerprints were taken: a newer document version, a removed document, a newer or continued output. */
export function changedSources(db: Db, fingerprints: readonly SourceFingerprint[]): StaleChange[] {
  const changes: StaleChange[] = [];
  for (const source of fingerprints) {
    if (source.kind === "document") {
      const live = db.prepare("SELECT d.state, d.title, v.digest FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=?").get(source.id) as { state: string; title: string; digest: string } | undefined;
      if (!live || live.state !== "active") changes.push({ kind: "document", id: source.id, title: source.title, what: "removed" });
      else if (live.digest !== source.digest) changes.push({ kind: "document", id: source.id, title: live.title.slice(0, 256), what: "revised" });
    } else {
      const latest = db.prepare("SELECT id FROM output_versions WHERE output_id=? AND verified=1 ORDER BY created_at_ms DESC, id DESC LIMIT 1").get(source.id) as { id: string } | undefined;
      if (latest && latest.id !== source.digest) { changes.push({ kind: "output", id: source.id, title: source.title, what: "revised" }); continue; }
      // A later mission continued this output with a verified version of its own: this one is no longer the current result.
      const continued = db.prepare("SELECT 1 FROM mission_outputs o JOIN output_versions v ON v.output_id=o.id AND v.verified=1 WHERE o.continues_output_id=? LIMIT 1").get(source.id);
      if (continued) changes.push({ kind: "output", id: source.id, title: source.title, what: "superseded" });
    }
  }
  return changes;
}

/**
 * Marks published knowledge stale when a source it was fingerprinted from changed (the contract's `stale`). The mark is kept: the
 * asset is never deleted, stays readable and labelled, and neither a read nor a later sweep clears it, even if a source returns to its
 * old content. Only a person's re-confirm (which re-fingerprints) or revoke ends it. Returns the assets marked by this call.
 */
export function markStaleKnowledge(db: Db, now: number): string[] {
  const marked: string[] = [];
  const rows = db.prepare("SELECT id, source_fingerprints_json FROM knowledge_assets WHERE state='published' AND stale_at_ms IS NULL AND source_fingerprints_json<>'[]'").all() as Array<{ id: string; source_fingerprints_json: string }>;
  for (const row of rows) {
    const changes = changedSources(db, JSON.parse(row.source_fingerprints_json) as SourceFingerprint[]);
    if (changes.length === 0) continue;
    db.prepare("UPDATE knowledge_assets SET stale_at_ms=?, stale_changes_json=? WHERE id=? AND stale_at_ms IS NULL").run(now, JSON.stringify(changes), row.id);
    marked.push(row.id);
  }
  return marked;
}

/** The persisted stale mark of an asset row, as the contract shows it. */
export function staleOf(row: { stale_at_ms: number | null; stale_changes_json: string }): { since: string; changes: StaleChange[] } | undefined {
  return row.stale_at_ms === null ? undefined : { since: new Date(row.stale_at_ms).toISOString(), changes: JSON.parse(row.stale_changes_json) as StaleChange[] };
}

/** A person's one-line reading of a change, for the pack, the Library and the reuse list. */
export const describeChange = (change: StaleChange): string => `${change.kind} "${change.title}" was ${change.what}`;
