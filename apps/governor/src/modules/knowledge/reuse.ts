import type { ActorContext, ReuseItem } from "@brain/contracts";
import type { Store } from "../../application/store";
import { requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { activeReleaseRecord } from "../configuration/index";
import { readVerified } from "../artifacts/index";
import { ftsOr, ftsTerms } from "./memory";

type Db = ReturnType<Store["workspaceDb"]>;
type Kind = ReuseItem["kind"];

interface IndexRow { item_ref: string; kind: Kind; mission_id: string | null; title: string; body: string; source_digest: string | null; verified_at_ms: number; rank?: number }
interface Live { title: string; kind: Kind; summary: string; verifiedAtMs: number; provenance: ReuseItem["provenance"]; selfReviewed?: boolean; startFrom?: ReuseItem["startFrom"] }

const SUMMARY_CHARS = 600;
const BODY_CHARS = 6000;
const PROMPT_CHARS = 6000;

/** Reads as a sentence, not markup: headings lose their marks; a written-up mission shows its Goal section. */
const readable = (body: string): string => {
  const goal = /^## Goal\n([\s\S]*?)(?:\n\n## |$)/mu.exec(body);
  return (goal?.[1] ?? body).replace(/^#+\s*/gmu, "");
};
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** `kind:id` with a known kind, or nothing: refs from a client are never trusted further than this. */
export function parseItemRef(ref: string): { kind: Kind; id: string } | undefined {
  const at = ref.indexOf(":");
  if (at < 1) return undefined;
  const kind = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (!["mission", "output", "knowledge", "play", "handoff"].includes(kind) || id.length === 0 || id.length > 190) return undefined;
  return { kind: kind as Kind, id };
}

/**
 * The reuse index (#66): what Brain can offer a new mission, drawn from achieved
 * missions, their verified outputs and handoff facts, published knowledge and the
 * active release's Plays. Retrieval is SQLite FTS5 (BM25 then recency): no model
 * call. Index rows are written when a source becomes reusable and every read
 * re-checks the live source, so a revoked or superseded item never appears.
 * Reused items are claims with provenance and are never evidence for a criterion.
 */
export class ReuseService {
  constructor(private readonly store: Store) {}

  private db(actor: ActorContext, workspaceId: string): Db {
    requireWorkspaceRead(this.store, actor, workspaceId);
    return this.store.workspaceDb(workspaceId, actor.organizationId);
  }

  // ---- write points ------------------------------------------------------

  /** An achieved, closed mission becomes reusable with its verified outputs and handoff facts. */
  indexMission(organizationId: string, workspaceId: string, missionId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const mission = db.prepare("SELECT id, title, intent, success_criteria_json, state, outcome, updated_at_ms FROM missions WHERE id=?").get(missionId) as
      | { id: string; title: string; intent: string; success_criteria_json: string; state: string; outcome: string | null; updated_at_ms: number } | undefined;
    if (!mission || mission.state !== "closed" || mission.outcome !== "achieved") return;
    const verified = this.verifiedBundle(db, missionId);
    const verifiedAt = verified?.created_at_ms ?? mission.updated_at_ms;
    const criteria = JSON.parse(mission.success_criteria_json) as string[];
    const decisions = (db.prepare("SELECT statement FROM accepted_decisions WHERE mission_id=? AND superseded_by IS NULL ORDER BY introduced_version, id").all(missionId) as Array<{ statement: string }>).map((row) => row.statement);
    this.store.inTx(db, () => {
      this.upsert(db, { ref: `mission:${missionId}`, kind: "mission", missionId, title: mission.title,
        body: [mission.intent, ...criteria, ...decisions].join("\n"), sourceDigest: verified?.digest ?? null, verifiedAt });
      const outputs = db.prepare("SELECT v.id, v.artifact_digest, v.created_at_ms, o.name FROM output_versions v JOIN mission_outputs o ON o.id=v.output_id WHERE o.mission_id=? AND v.verified=1 ORDER BY v.id").all(missionId) as Array<{ id: string; artifact_digest: string; created_at_ms: number; name: string }>;
      for (const output of outputs) {
        this.upsert(db, { ref: `output:${output.id}`, kind: "output", missionId, title: `${output.name} (from ${mission.title})`, body: this.preview(output.artifact_digest, output.name),
          sourceDigest: output.artifact_digest, verifiedAt: output.created_at_ms });
      }
      const handoffs = db.prepare("SELECT h.id, h.facts_json, h.created_at_ms, w.title FROM handoffs h JOIN work_items w ON w.id=h.work_item_id WHERE h.mission_id=? AND h.superseded_by IS NULL AND h.facts_json IS NOT NULL ORDER BY h.id").all(missionId) as Array<{ id: string; facts_json: string; created_at_ms: number; title: string }>;
      for (const handoff of handoffs) {
        this.upsert(db, { ref: `handoff:${handoff.id}`, kind: "handoff", missionId, title: `Findings of ${handoff.title}`, body: clip(handoff.facts_json, BODY_CHARS), sourceDigest: verified?.digest ?? null, verifiedAt });
      }
    });
  }

  /** Published knowledge becomes reusable; called by the approve path. */
  indexKnowledge(organizationId: string, workspaceId: string, assetId: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    const asset = db.prepare("SELECT id, title, content, mission_id, state, provenance_json, updated_at_ms FROM knowledge_assets WHERE id=?").get(assetId) as
      | { id: string; title: string; content: string; mission_id: string | null; state: string; provenance_json: string; updated_at_ms: number } | undefined;
    if (!asset || asset.state !== "published") return;
    const verified = asset.mission_id ? this.verifiedBundle(db, asset.mission_id) : undefined;
    this.store.inTx(db, () => this.upsert(db, { ref: `knowledge:${assetId}`, kind: "knowledge", missionId: asset.mission_id, title: asset.title || "Knowledge", body: clip(asset.content, BODY_CHARS), sourceDigest: verified?.digest ?? null, verifiedAt: verified?.created_at_ms ?? asset.updated_at_ms }));
  }

  /** A revoked asset leaves the index at once. */
  unindex(organizationId: string, workspaceId: string, ref: string): void {
    const db = this.store.workspaceDb(workspaceId, organizationId);
    this.store.inTx(db, () => {
      db.prepare("DELETE FROM reuse_items WHERE item_ref=?").run(ref);
      db.prepare("DELETE FROM reuse_fts WHERE item_ref=?").run(ref);
    });
  }

  /** Plays are release content: indexed lazily and re-indexed whenever the active release changes. */
  private syncPlays(organizationId: string, db: Db): void {
    const active = activeReleaseRecord(this.store, organizationId);
    const have = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT source_digest) AS d, MIN(source_digest) AS digest FROM reuse_items WHERE kind='play'").get() as { n: number; d: number; digest: string | null };
    const plays = Object.entries(active?.release.plays ?? {});
    if (have.n === plays.length && (plays.length === 0 || (have.d === 1 && have.digest === active?.digest))) return;
    this.store.inTx(db, () => {
      for (const row of db.prepare("SELECT item_ref FROM reuse_items WHERE kind='play'").all() as Array<{ item_ref: string }>) {
        db.prepare("DELETE FROM reuse_items WHERE item_ref=?").run(row.item_ref);
        db.prepare("DELETE FROM reuse_fts WHERE item_ref=?").run(row.item_ref);
      }
      for (const [playId, play] of plays) {
        this.upsert(db, { ref: `play:${playId}`, kind: "play", missionId: null, title: play.spec.title,
          body: [play.spec.description ?? "", play.spec.intent, ...play.spec.successCriteria, ...play.spec.plan.tasks.map((task) => task.title)].join("\n"),
          sourceDigest: active!.digest, verifiedAt: this.store.now() });
      }
    });
  }

  private upsert(db: Db, row: { ref: string; kind: Kind; missionId: string | null; title: string; body: string; sourceDigest: string | null; verifiedAt: number }): void {
    const now = this.store.now();
    db.prepare("DELETE FROM reuse_fts WHERE item_ref=?").run(row.ref);
    db.prepare(`INSERT INTO reuse_items(item_ref,kind,mission_id,title,body,source_digest,verified_at_ms,indexed_at_ms) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(item_ref) DO UPDATE SET title=excluded.title,body=excluded.body,source_digest=excluded.source_digest,verified_at_ms=excluded.verified_at_ms,indexed_at_ms=excluded.indexed_at_ms`)
      .run(row.ref, row.kind, row.missionId, row.title, clip(row.body, BODY_CHARS), row.sourceDigest, row.verifiedAt, now);
    db.prepare("INSERT INTO reuse_fts(item_ref,title,body) VALUES (?,?,?)").run(row.ref, row.title, clip(row.body, BODY_CHARS));
  }

  private verifiedBundle(db: Db, missionId: string): { digest: string; created_at_ms: number } | undefined {
    return db.prepare("SELECT digest, created_at_ms FROM mission_evidence_bundles WHERE mission_id=? AND state='verified' ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(missionId) as { digest: string; created_at_ms: number } | undefined;
  }

  private preview(digest: string, fallback: string): string {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(readVerified(this.store, digest));
      return clip(text, BODY_CHARS);
    } catch { return fallback; }
  }

  // ---- live source check ---------------------------------------------------

  /** The item as its source is right now, or nothing when it is no longer reusable. */
  private live(organizationId: string, db: Db, row: IndexRow): Live | undefined {
    const parsed = parseItemRef(row.item_ref);
    if (!parsed) return undefined;
    const summary = clip(flat(readable(row.body)), SUMMARY_CHARS);
    switch (parsed.kind) {
      case "mission": {
        const mission = db.prepare("SELECT title, intent, success_criteria_json, state, outcome FROM missions WHERE id=?").get(parsed.id) as { title: string; intent: string; success_criteria_json: string; state: string; outcome: string | null } | undefined;
        if (!mission || mission.state !== "closed" || mission.outcome !== "achieved") return undefined;
        const evidence = this.evidenceOf(db, parsed.id);
        return { kind: "mission", title: mission.title, summary: clip(flat(mission.intent), SUMMARY_CHARS), verifiedAtMs: row.verified_at_ms,
          provenance: { missionId: parsed.id, ...(evidence.verdictDigest ? { verdictDigest: evidence.verdictDigest } : {}), evidenceDigests: evidence.digests, source: "Achieved mission" },
          startFrom: { title: mission.title, intent: mission.intent, successCriteria: JSON.parse(mission.success_criteria_json) as string[] } };
      }
      case "output": {
        const version = db.prepare("SELECT v.artifact_digest, o.mission_id, m.state, m.outcome FROM output_versions v JOIN mission_outputs o ON o.id=v.output_id JOIN missions m ON m.id=o.mission_id WHERE v.id=? AND v.verified=1").get(parsed.id) as { artifact_digest: string; mission_id: string; state: string; outcome: string | null } | undefined;
        if (!version || version.state !== "closed" || version.outcome !== "achieved") return undefined;
        const evidence = this.evidenceOf(db, version.mission_id);
        return { kind: "output", title: row.title, summary, verifiedAtMs: row.verified_at_ms,
          provenance: { missionId: version.mission_id, ...(evidence.verdictDigest ? { verdictDigest: evidence.verdictDigest } : {}), evidenceDigests: [version.artifact_digest], source: "Verified output" } };
      }
      case "knowledge": {
        const asset = db.prepare("SELECT state, mission_id, self_reviewed, provenance_json FROM knowledge_assets WHERE id=?").get(parsed.id) as { state: string; mission_id: string | null; self_reviewed: number; provenance_json: string } | undefined;
        if (!asset || asset.state !== "published") return undefined;
        const evidence = asset.mission_id ? this.evidenceOf(db, asset.mission_id) : { digests: [] as string[], verdictDigest: undefined };
        return { kind: "knowledge", title: row.title, summary, verifiedAtMs: row.verified_at_ms, selfReviewed: asset.self_reviewed === 1,
          provenance: { ...(asset.mission_id ? { missionId: asset.mission_id } : {}), ...(evidence.verdictDigest ? { verdictDigest: evidence.verdictDigest } : {}), evidenceDigests: evidence.digests, source: "Published knowledge" } };
      }
      case "play": {
        const active = activeReleaseRecord(this.store, organizationId);
        const play = active?.release.plays?.[parsed.id];
        if (!active || !play || row.source_digest !== active.digest) return undefined;
        return { kind: "play", title: play.spec.title, summary: clip(flat(play.spec.description ?? play.spec.intent), SUMMARY_CHARS), verifiedAtMs: row.verified_at_ms,
          provenance: { evidenceDigests: [], source: `Play in release ${active.digest.slice(0, 19)}` } };
      }
      case "handoff": {
        const handoff = db.prepare("SELECT h.mission_id, h.superseded_by, h.facts_json, m.state, m.outcome FROM handoffs h JOIN missions m ON m.id=h.mission_id WHERE h.id=?").get(parsed.id) as { mission_id: string; superseded_by: string | null; facts_json: string | null; state: string; outcome: string | null } | undefined;
        if (!handoff || handoff.superseded_by || !handoff.facts_json || handoff.state !== "closed" || handoff.outcome !== "achieved") return undefined;
        const evidence = this.evidenceOf(db, handoff.mission_id);
        return { kind: "handoff", title: row.title, summary, verifiedAtMs: row.verified_at_ms,
          provenance: { missionId: handoff.mission_id, ...(evidence.verdictDigest ? { verdictDigest: evidence.verdictDigest } : {}), evidenceDigests: evidence.digests, source: "Facts the Governor derived from verified work" } };
      }
    }
  }

  private evidenceOf(db: Db, missionId: string): { verdictDigest: string | undefined; digests: string[] } {
    const bundle = this.verifiedBundle(db, missionId);
    if (!bundle) return { verdictDigest: undefined, digests: [] };
    const checks = db.prepare("SELECT DISTINCT evidence_digest FROM mission_bundle_checks WHERE bundle_digest=? ORDER BY evidence_digest LIMIT 19").all(bundle.digest) as Array<{ evidence_digest: string }>;
    return { verdictDigest: bundle.digest, digests: [bundle.digest, ...checks.map((check) => check.evidence_digest)] };
  }

  private used(db: Db, ref: string): number {
    return (db.prepare("SELECT COALESCE(SUM(used),0) AS n FROM reuse_attachments WHERE item_ref=?").get(ref) as { n: number }).n;
  }

  private toItem(db: Db, ref: string, live: Live, extra: Partial<ReuseItem> = {}): ReuseItem {
    return { itemRef: ref, kind: live.kind, title: live.title, summary: live.summary, lastVerifiedAt: iso(live.verifiedAtMs), usedCount: this.used(db, ref),
      ...(live.selfReviewed ? { selfReviewed: true } : {}), provenance: live.provenance, ...(live.startFrom ? { startFrom: live.startFrom } : {}), ...extra };
  }

  // ---- reads --------------------------------------------------------------

  /** Ranked reusable items for a goal sentence. A mission id excludes that mission and what it dropped. */
  search(actor: ActorContext, workspaceId: string, text: string, options: { missionId?: string; limit?: number } = {}): ReuseItem[] {
    const db = this.db(actor, workspaceId);
    this.syncPlays(actor.organizationId, db);
    const terms = ftsTerms(text);
    if (terms.length === 0) return [];
    const need = Math.min(2, terms.length);
    const dropped = new Set(options.missionId ? (db.prepare("SELECT item_ref FROM reuse_attachments WHERE mission_id=? AND decision='dropped'").all(options.missionId) as Array<{ item_ref: string }>).map((row) => row.item_ref) : []);
    const rows = db.prepare(`SELECT i.*, bm25(reuse_fts, 0.0, 3.0, 1.0) AS rank FROM reuse_fts f JOIN reuse_items i ON i.item_ref=f.item_ref
      WHERE reuse_fts MATCH ? ORDER BY rank, i.verified_at_ms DESC, i.item_ref LIMIT 60`).all(ftsOr(terms)) as unknown as IndexRow[];
    const out: ReuseItem[] = [];
    for (const row of rows) {
      if (dropped.has(row.item_ref) || (options.missionId && row.mission_id === options.missionId)) continue;
      const haystack = `${row.title}\n${row.body}`.toLowerCase();
      if (terms.filter((term) => haystack.includes(term)).length < need) continue;
      const live = this.live(actor.organizationId, db, row);
      if (live) out.push(this.toItem(db, row.item_ref, live));
      if (out.length >= Math.min(options.limit ?? 6, 20)) break;
    }
    return out;
  }

  /** What a mission reused, from the attach records only (#70). */
  forMission(actor: ActorContext, workspaceId: string, missionId: string): ReuseItem[] {
    const db = this.db(actor, workspaceId);
    if (!db.prepare("SELECT 1 FROM missions WHERE id=?").get(missionId)) throw new BrainDomainError("NOT_FOUND", "mission not found");
    const rows = db.prepare("SELECT * FROM reuse_attachments WHERE mission_id=? ORDER BY decided_at_ms, id").all(missionId) as Array<{ item_ref: string; kind: Kind; title: string; last_verified_ms: number; provenance_json: string; self_reviewed: number; decision: "kept" | "dropped"; decided_by: string }>;
    return rows.map((row) => ({
      itemRef: row.item_ref, kind: row.kind, title: row.title, summary: "", lastVerifiedAt: iso(row.last_verified_ms), usedCount: this.used(db, row.item_ref),
      ...(row.self_reviewed ? { selfReviewed: true } : {}), provenance: JSON.parse(row.provenance_json) as ReuseItem["provenance"], decision: row.decision, decidedBy: row.decided_by,
    }));
  }

  // ---- attach (the only thing that raises a use count) ----------------------

  /** Keep `refs` for a mission's plan and drop the rest of what was suggested. Idempotent per (mission, item). */
  attach(actor: ActorContext, workspaceId: string, missionId: string, refs: readonly string[]): ReuseItem[] {
    const db = this.db(actor, workspaceId);
    this.syncPlays(actor.organizationId, db);
    if (!db.prepare("SELECT 1 FROM missions WHERE id=?").get(missionId)) throw new BrainDomainError("NOT_FOUND", "mission not found");
    const kept: ReuseItem[] = [];
    for (const ref of new Set(refs)) {
      if (!parseItemRef(ref)) throw new BrainDomainError("INVALID_ARGUMENT", `unknown reuse item ${ref}`);
      const existing = db.prepare("SELECT decision FROM reuse_attachments WHERE mission_id=? AND item_ref=?").get(missionId, ref) as { decision: string } | undefined;
      if (existing?.decision === "dropped") continue;
      const row = db.prepare("SELECT * FROM reuse_items WHERE item_ref=?").get(ref) as unknown as IndexRow | undefined;
      const live = row ? this.live(actor.organizationId, db, row) : undefined;
      if (!row || !live) throw new BrainDomainError("NOT_FOUND", `reuse item ${ref} is no longer reusable`);
      if (!existing) {
        db.prepare(`INSERT INTO reuse_attachments(id,mission_id,item_ref,kind,title,last_verified_ms,provenance_json,self_reviewed,used,decision,decided_by,decided_at_ms) VALUES (?,?,?,?,?,?,?,?,1,'kept',?,?)`)
          .run(this.store.id("reuse"), missionId, ref, live.kind, live.title, live.verifiedAtMs, JSON.stringify(live.provenance), live.selfReviewed ? 1 : 0, actor.actorId, this.store.now());
      }
      kept.push(this.toItem(db, ref, live, { decision: "kept", decidedBy: actor.actorId }));
    }
    return kept;
  }

  /** Drop an item for this mission: it is excluded from every later attach and suggestion (#70). Keep re-includes it. */
  decide(actor: ActorContext, workspaceId: string, missionId: string, ref: string, decision: "keep" | "drop"): void {
    const db = this.db(actor, workspaceId);
    if (!db.prepare("SELECT 1 FROM missions WHERE id=?").get(missionId)) throw new BrainDomainError("NOT_FOUND", "mission not found");
    const parsed = parseItemRef(ref);
    if (!parsed) throw new BrainDomainError("INVALID_ARGUMENT", `unknown reuse item ${ref}`);
    const existing = db.prepare("SELECT 1 FROM reuse_attachments WHERE mission_id=? AND item_ref=?").get(missionId, ref);
    if (decision === "keep") {
      if (existing) db.prepare("UPDATE reuse_attachments SET decision='kept',used=1,decided_by=?,decided_at_ms=? WHERE mission_id=? AND item_ref=?").run(actor.actorId, this.store.now(), missionId, ref);
      else this.attach(actor, workspaceId, missionId, [ref]);
      return;
    }
    if (existing) {
      db.prepare("UPDATE reuse_attachments SET decision='dropped',decided_by=?,decided_at_ms=? WHERE mission_id=? AND item_ref=?").run(actor.actorId, this.store.now(), missionId, ref);
      return;
    }
    // Dropped before it was ever attached: remember the refusal so it is never suggested again for this mission.
    const row = db.prepare("SELECT * FROM reuse_items WHERE item_ref=?").get(ref) as unknown as IndexRow | undefined;
    const live = row ? this.live(actor.organizationId, db, row) : undefined;
    db.prepare(`INSERT INTO reuse_attachments(id,mission_id,item_ref,kind,title,last_verified_ms,provenance_json,self_reviewed,used,decision,decided_by,decided_at_ms) VALUES (?,?,?,?,?,?,?,?,0,'dropped',?,?)`)
      .run(this.store.id("reuse"), missionId, ref, parsed.kind, live?.title ?? row?.title ?? ref, live?.verifiedAtMs ?? row?.verified_at_ms ?? this.store.now(), JSON.stringify(live?.provenance ?? { evidenceDigests: [] }), 0, actor.actorId, this.store.now());
  }

  /**
   * The kept items as the planner's "reused" input: claims with provenance, never evidence.
   * Built from stored attach records and live summaries, so the model sees what the Governor attached.
   */
  promptFor(actor: ActorContext, workspaceId: string, missionId: string): string {
    const db = this.db(actor, workspaceId);
    const rows = db.prepare("SELECT item_ref FROM reuse_attachments WHERE mission_id=? AND decision='kept' ORDER BY decided_at_ms, id").all(missionId) as Array<{ item_ref: string }>;
    const lines: string[] = [];
    for (const { item_ref } of rows) {
      const row = db.prepare("SELECT * FROM reuse_items WHERE item_ref=?").get(item_ref) as unknown as IndexRow | undefined;
      const live = row ? this.live(actor.organizationId, db, row) : undefined;
      if (!live) continue;
      const evidence = live.provenance.evidenceDigests.slice(0, 2).join(", ");
      lines.push(`- [${live.kind}] ${live.title} (last verified ${iso(live.verifiedAtMs).slice(0, 10)}${live.provenance.missionId ? `, mission ${live.provenance.missionId}` : ""}${evidence ? `, evidence ${evidence}` : ""}${live.selfReviewed ? ", self-reviewed" : ""}): ${live.summary}`);
    }
    if (lines.length === 0) return "";
    return clip(`Earlier work Brain found that may help. These are claims from past work with provenance, not evidence for any criterion of this mission; use them as hints and verify.\n${lines.join("\n")}`, PROMPT_CHARS);
  }
}
