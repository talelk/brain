# 59. Stale knowledge is a mark on a published asset, cleared only by a person

Status: accepted, 2026-11-15. Extends ADR 0007 (a sole owner may review own knowledge) and ADR 0015 (knowledge is a claim). Expiry (90 days, renewed when it helps) is unchanged and independent.

Knowledge aged out by time and use only. Nothing noticed that the document or output a write-up was built from had changed, so an asset could keep being offered after its source moved on.

## Decision
1. **Stale is a mark, not a lifecycle state.** A stale asset stays `published`: still readable, still searchable, still reusable, never deleted. The mark is `stale_at_ms` plus the list of changes (`stale_changes_json`) on `knowledge_assets`. Search results carry the contract's existing `stale` status and the changes; reuse items and the Knowledge page carry the same label.
2. **Sources are fingerprinted when the write-up is made.** A mission write-up records the version digest of each document associated with the mission or its tasks and the latest verified version of each mission output. A source changed when its document has a newer version or is removed, or its output has a newer verified version or a later mission continued it with a verified version. A saved-document asset is itself the source, so a newer document version still replaces it (saved documents, GLOSSARY: Knowledge asset), and is not marked.
3. **Marking is deterministic and lazy.** One pure check (`markStaleKnowledge`) runs on the capitalization pass and before every read that returns knowledge (search, reuse, context pack, the Knowledge list). No model.
4. **Only a person clears it.** A read or a sweep never clears the mark, even if a source returns to its old content. A reviewer **re-confirms** (`knowledge.review` decision `reconfirm`: sources are fingerprinted again as they are now, the mark is cleared, the producer-or-other-reviewer rule of ADR 0007 applies) or **revokes** (`revoke`: out of search and reuse, kept as a record). Both apply to published stale assets only.
5. **Context packs name it.** A task's pack lists the knowledge its mission kept, labelled STALE with what changed, and a separate section lists what changed since that task's previous pack (went stale, re-confirmed, withdrawn). What each pack said is recorded per task (`knowledge_pack_seen`), so a change is listed once and a session rereads only what changed.

## Consequences
- Assets written before this change carry no fingerprints and are never marked: no backfill.
- Reuse still re-checks the live source on every read; a stale item stays offered, flagged, until a person decides.
