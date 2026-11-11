import type { Store } from "../../application/store";

/**
 * What the read tools of the starter agents could read in one workspace, and so whether each tool is worth offering at all. A tool with
 * nothing to read can only fail (live, 2026-11-11: documents.read failed 21 of 21 calls in a workspace with no documents, each failure a
 * wasted model round trip), so the Governor says "not available" in the registry, leaves it out of the agent's tool list and tells the
 * model in its context. Everything here is derived from the workspace's own records, never configured.
 */

export interface ReadableSources {
  /** Active documents whose text was extracted, newest first (bounded). */
  readonly documents: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly documentCount: number;
  /** Verified CSV artifacts a read tool may open (media type text/csv or application/csv), newest first (bounded). */
  readonly csvFiles: ReadonlyArray<{ readonly id: string; readonly bytes: number }>;
  readonly csvCount: number;
}

export interface ToolAvailability { readonly available: boolean; readonly reason?: string }

const LISTED = 10;
/** csv.query reads at most this much of one artifact (see the Governor's csvArtifact port). */
const CSV_MAX_BYTES = 2 * 1024 * 1024;

export function readableSources(store: Store, organizationId: string, workspaceId: string): ReadableSources {
  const db = store.workspaceDb(workspaceId, organizationId);
  const documents = db.prepare(`SELECT d.id AS id, d.title AS title FROM documents d JOIN document_versions v ON v.id=d.current_version_id
    WHERE d.state='active' AND v.extraction_status='ready' AND v.extracted_text IS NOT NULL ORDER BY d.updated_at_ms DESC, d.id LIMIT ?`).all(LISTED) as Array<{ id: string; title: string }>;
  const documentCount = (db.prepare(`SELECT COUNT(*) AS n FROM documents d JOIN document_versions v ON v.id=d.current_version_id
    WHERE d.state='active' AND v.extraction_status='ready' AND v.extracted_text IS NOT NULL`).get() as { n: number }).n;
  const csvWhere = "state='verified' AND bytes<=? AND lower(media_type) IN ('text/csv','application/csv')";
  const csvFiles = db.prepare(`SELECT id, bytes FROM artifacts WHERE ${csvWhere} ORDER BY created_at_ms DESC, id LIMIT ?`).all(CSV_MAX_BYTES, LISTED) as Array<{ id: string; bytes: number }>;
  const csvCount = (db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE ${csvWhere}`).get(CSV_MAX_BYTES) as { n: number }).n;
  return { documents, documentCount, csvFiles, csvCount };
}

/**
 * Availability of one tool given what the workspace holds. `referencesInContext` is true when the task's own context pack contains
 * shortened text with an `artifact:sha256:...` reference: documents.read can open those even in a workspace with no documents.
 */
export function toolAvailability(toolId: string, sources: ReadableSources, options: { referencesInContext?: boolean } = {}): ToolAvailability {
  if (toolId === "documents.read" && sources.documentCount === 0 && !options.referencesInContext) {
    return { available: false, reason: "no documents yet" };
  }
  if (toolId === "csv.query" && sources.csvCount === 0) return { available: false, reason: "no CSV files yet" };
  return { available: true };
}
