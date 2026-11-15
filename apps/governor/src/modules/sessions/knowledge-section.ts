import type { Store } from "../../application/store";
import { describeChange, markStaleKnowledge, staleOf } from "../knowledge/index";
import type { PackSection } from "./context-pack";

type Db = ReturnType<Store["workspaceDb"]>;

interface KeptRow { id: string; title: string; state: string; stale_at_ms: number | null; stale_changes_json: string; reconfirmed_at_ms: number | null }

/** What a pack says about one kept asset, compared with what the task's previous pack said. */
function seenKey(row: KeptRow): string {
  if (row.state !== "published") return "withdrawn";
  if (row.stale_at_ms !== null) return `stale:${row.stale_at_ms}`;
  return row.reconfirmed_at_ms !== null ? `confirmed:${row.reconfirmed_at_ms}` : "current";
}

/**
 * The knowledge a mission kept as a starting point, in a task's context pack (#133): what is stale is labelled with what changed, and
 * what changed since the task's previous pack (a source changed and the knowledge was marked, a person re-confirmed it, or it was
 * withdrawn) is listed on its own, so a session rereads only that. What each pack said is recorded per task, so a change is listed
 * once. Deterministic text from records, never a model summary. The pack names the knowledge; its text is read with knowledge.search,
 * which re-checks the live source on every read.
 */
export function knowledgeSections(db: Db, missionId: string, workItemId: string, now: number): PackSection[] {
  markStaleKnowledge(db, now);
  const rows = db.prepare(`SELECT k.id, k.title, k.state, k.stale_at_ms, k.stale_changes_json, k.reconfirmed_at_ms
    FROM reuse_attachments a JOIN knowledge_assets k ON 'knowledge:' || k.id = a.item_ref
    WHERE a.mission_id=? AND a.decision='kept' AND a.kind='knowledge' ORDER BY a.decided_at_ms, a.id LIMIT 50`).all(missionId) as KeptRow[];
  if (rows.length === 0) return [];
  const seen = new Map((db.prepare("SELECT asset_id, seen FROM knowledge_pack_seen WHERE work_item_id=?").all(workItemId) as Array<{ asset_id: string; seen: string }>).map((row) => [row.asset_id, row.seen]));
  const name = (row: KeptRow): string => row.title || row.id;
  const changed: string[] = [];
  const listed = [];
  for (const row of rows) {
    const key = seenKey(row);
    const stale = row.state === "published" ? staleOf(row) : undefined;
    const sentence = stale?.changes.map(describeChange).join("; ");
    if (row.state === "published") {
      listed.push({ id: `kept-${row.id}`, prose: false, text: stale
        ? `- "${name(row)}" (knowledge:${row.id}) is STALE: ${sentence}. Reread it with knowledge.search and check the source before relying on it.`
        : `- "${name(row)}" (knowledge:${row.id})` });
    }
    const before = seen.get(row.id);
    if (before !== undefined && before !== key) {
      changed.push(key === "withdrawn" ? `- "${name(row)}" was withdrawn; do not rely on it.`
        : stale ? `- "${name(row)}" went stale: ${sentence}.`
        : `- "${name(row)}" was re-confirmed by a person; it holds against its sources as they are now.`);
    }
    db.prepare("INSERT INTO knowledge_pack_seen(work_item_id,asset_id,seen) VALUES (?,?,?) ON CONFLICT(work_item_id,asset_id) DO UPDATE SET seen=excluded.seen").run(workItemId, row.id, key);
  }
  return [
    { id: "knowledge-changes", title: "Knowledge that changed since your last context", label: "fact", items: changed.map((text, index) => ({ id: `changed-${index}`, text, prose: false })) },
    { id: "knowledge", title: "Knowledge this mission kept as a starting point (earlier work, not evidence)", label: "claim", items: listed },
  ];
}
