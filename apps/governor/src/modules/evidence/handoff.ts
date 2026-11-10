import { domainDigest } from "@brain/contracts";
import type { Handoff, HandoffFacts, HandoffNotes, JsonValue, MissionEvidenceBundle, WorkItemState } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

type Db = ReturnType<Store["workspaceDb"]>;
type HandoffRow = { id: string; mission_id: string; work_item_id: string; version: number; notes_json: string; facts_json: string | null; submitted_by: string; superseded_by: string | null; created_at_ms: number };
type BundleRow = { digest: string; mission_id: string; state: MissionEvidenceBundle["state"]; manifest_json: string; findings_json: string; created_at_ms: number };

/** Member notes stay claims and stay small (issue #33). */
const NOTES_CHAR_CAP = 6000;

function notesChars(notes: HandoffNotes): number {
  return notes.summary.length + (notes.nextAction?.length ?? 0) + [...(notes.decisions ?? []), ...(notes.openQuestions ?? [])].reduce((sum, entry) => sum + entry.length, 0);
}

function toHandoff(row: HandoffRow): Handoff {
  return {
    handoffId: row.id, missionId: row.mission_id, workItemId: row.work_item_id, version: row.version,
    notes: JSON.parse(row.notes_json) as HandoffNotes, ...(row.facts_json ? { facts: JSON.parse(row.facts_json) as HandoffFacts } : {}),
    submittedBy: row.submitted_by, ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}), createdAt: iso(row.created_at_ms),
  };
}

/** A member's handoff notes for a work item; a later submission supersedes, so rework produces a new version. */
export function submitHandoff(store: Store, db: Db, input: { workItemId: string; submittedBy: string; notes: HandoffNotes }): string {
  const item = db.prepare("SELECT mission_id, state FROM work_items WHERE id=?").get(input.workItemId) as { mission_id: string; state: WorkItemState } | undefined;
  if (!item) throw new BrainDomainError("NOT_FOUND", "work item not found");
  if (item.state === "done" || item.state === "abandoned") throw new BrainDomainError("CONFLICT", `a ${item.state} work item takes no new handoff`);
  if (notesChars(input.notes) > NOTES_CHAR_CAP) throw new BrainDomainError("INVALID_ARGUMENT", `handoff notes exceed ${NOTES_CHAR_CAP} characters`);
  const id = store.id("handoff");
  store.inTx(db, () => {
    const prior = db.prepare("SELECT id, version FROM handoffs WHERE work_item_id=? AND superseded_by IS NULL").get(input.workItemId) as { id: string; version: number } | undefined;
    db.prepare("INSERT INTO handoffs(id,mission_id,work_item_id,version,notes_json,submitted_by,created_at_ms) VALUES (?,?,?,?,?,?,?)")
      .run(id, item.mission_id, input.workItemId, (prior?.version ?? 0) + 1, JSON.stringify(input.notes), input.submittedBy, store.now());
    if (prior) db.prepare("UPDATE handoffs SET superseded_by=? WHERE id=?").run(id, prior.id);
    store.emit(db, { aggregateType: "workItem", aggregateId: input.workItemId, eventType: "handoff.submitted", payload: { workItemId: input.workItemId, missionId: item.mission_id } });
  });
  return id;
}

/**
 * Structural check at Done (E116). A work item that others depend on needs a
 * current handoff; whatever it references must be a final output version of
 * this item; and the Governor derives the facts (evidence, criterion status,
 * output versions) itself and freezes them on the handoff. The notes' prose is
 * never verified, only carried as claims.
 */
export function finalizeHandoff(db: Db, workItemId: string, evidenceDigest: string): void {
  const dependents = db.prepare("SELECT COUNT(*) AS n FROM work_item_dependencies d JOIN work_items w ON w.id=d.work_item_id WHERE d.depends_on_work_item_id=? AND w.state!='abandoned'").get(workItemId) as { n: number };
  const handoff = db.prepare("SELECT * FROM handoffs WHERE work_item_id=? AND superseded_by IS NULL").get(workItemId) as HandoffRow | undefined;
  if (!handoff) {
    if (dependents.n > 0) throw new BrainDomainError("EVIDENCE_MISSING", "work that others depend on needs a handoff before Done");
    return;
  }
  const finals = (db.prepare("SELECT id FROM output_versions WHERE work_item_id=? AND state='final' ORDER BY created_at_ms, id").all(workItemId) as Array<{ id: string }>).map((row) => row.id);
  const notes = JSON.parse(handoff.notes_json) as HandoffNotes;
  const foreign = (notes.referencedOutputs ?? []).filter((id) => !finals.includes(id));
  if (foreign.length > 0) throw new BrainDomainError("EVIDENCE_MISSING", `the handoff references outputs this work did not produce as final: ${foreign.join(", ")}`);
  const bundle = db.prepare("SELECT manifest_json FROM evidence_bundles WHERE digest=?").get(evidenceDigest) as { manifest_json: string } | undefined;
  const manifest = bundle ? JSON.parse(bundle.manifest_json) as { checks?: Array<{ criterionId: string; status: string }>; sourceRevision?: string } : {};
  const criteria = JSON.parse((db.prepare("SELECT criteria_json FROM work_items WHERE id=?").get(workItemId) as { criteria_json: string }).criteria_json) as string[];
  const facts: HandoffFacts = {
    evidenceDigest,
    criteria: criteria.map((criterionId) => {
      const check = (manifest.checks ?? []).find((entry) => entry.criterionId === criterionId);
      if (!check && workflowCovers(manifest.checks, criteria)) return { criterionId, status: "passed" as const };
      return { criterionId, status: check ? (check.status === "passed" ? "passed" : "failed") : "missing" };
    }),
    outputVersions: finals, ...(manifest.sourceRevision ? { sourceRevision: manifest.sourceRevision } : {}),
  };
  db.prepare("UPDATE handoffs SET facts_json=? WHERE id=?").run(JSON.stringify(facts), handoff.id);
}

/** What a dependent receives: the current handoffs of its direct dependencies only. */
export function dependencyHandoffs(db: Db, workItemId: string): Handoff[] {
  return (db.prepare(`SELECT h.* FROM work_item_dependencies d JOIN handoffs h ON h.work_item_id=d.depends_on_work_item_id
    WHERE d.work_item_id=? AND h.superseded_by IS NULL ORDER BY h.work_item_id`).all(workItemId) as HandoffRow[]).map(toHandoff);
}

/**
 * Assembles the mission evidence bundle a mission verdict judges (issue #25):
 * every live work item with its evidence and handoff, the verified outputs and
 * the brief version. Work still open makes the bundle incomplete.
 */
export function assembleMissionBundle(store: Store, db: Db, missionId: string, briefVersion: number): { digest: string; complete: boolean } {
  const items = db.prepare("SELECT id, state, evidence_digest FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY id").all(missionId) as Array<{ id: string; state: WorkItemState; evidence_digest: string | null }>;
  const handoffs = new Map((db.prepare("SELECT id, work_item_id FROM handoffs WHERE mission_id=? AND superseded_by IS NULL").all(missionId) as Array<{ id: string; work_item_id: string }>).map((row) => [row.work_item_id, row.id]));
  const outputVersions = (db.prepare("SELECT v.id FROM output_versions v JOIN mission_outputs o ON o.id=v.output_id WHERE o.mission_id=? AND v.verified=1 ORDER BY v.id").all(missionId) as Array<{ id: string }>).map((row) => row.id);
  const complete = items.length > 0 && items.every((item) => item.state === "done");
  const manifest = {
    missionId, briefVersion, outputVersions, complete,
    items: items.map((item) => ({ workItemId: item.id, state: item.state, ...(item.evidence_digest ? { evidenceDigest: item.evidence_digest } : {}), ...(handoffs.has(item.id) ? { handoffId: handoffs.get(item.id) } : {}) })),
  };
  const digest = domainDigest("brain:mission-evidence:v1", { ...manifest, assembledAt: store.now() } as unknown as JsonValue);
  const findings = complete ? [] : items.filter((item) => item.state !== "done").map((item) => `Work item ${item.id} is ${item.state}, not done`);
  db.prepare("INSERT INTO mission_evidence_bundles(digest,mission_id,state,manifest_json,findings_json,created_at_ms) VALUES (?,?,?,?,?,?)")
    .run(digest, missionId, complete ? "submitted" : "incomplete", JSON.stringify(manifest), JSON.stringify(findings), store.now());
  store.emit(db, { aggregateType: "mission", aggregateId: missionId, eventType: "mission.bundleAssembled", payload: { missionId, digest } });
  return { digest, complete };
}

/** A verdict on the mission's current bundle; only a submitted bundle can be judged, once. */
export function recordMissionVerdict(store: Store, db: Db, input: { missionId: string; digest: string; outcome: "verified" | "rejected"; findings: readonly string[]; by: string }): void {
  const latest = latestBundleRow(db, input.missionId);
  if (!latest || latest.digest !== input.digest) throw new BrainDomainError("CONFLICT", "the verdict must judge the mission's current evidence bundle");
  if (latest.state !== "submitted") throw new BrainDomainError("CONFLICT", `a ${latest.state} mission evidence bundle takes no verdict`);
  db.prepare("UPDATE mission_evidence_bundles SET state=?,findings_json=?,verdict_by=? WHERE digest=? AND state='submitted'").run(input.outcome, JSON.stringify(input.findings), input.by, input.digest);
  store.emit(db, { aggregateType: "mission", aggregateId: input.missionId, eventType: "mission.verdictRecorded", payload: { missionId: input.missionId, digest: input.digest } });
}

function latestBundleRow(db: Db, missionId: string): BundleRow | undefined {
  return db.prepare("SELECT * FROM mission_evidence_bundles WHERE mission_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(missionId) as BundleRow | undefined;
}

export function latestMissionBundle(db: Db, missionId: string): MissionEvidenceBundle | undefined {
  const row = latestBundleRow(db, missionId);
  if (!row) return undefined;
  const manifest = JSON.parse(row.manifest_json) as Omit<MissionEvidenceBundle, "digest" | "state" | "findings" | "createdAt">;
  const checks = (db.prepare("SELECT criterion_id, evaluator, outcome, evidence_digest, advisory FROM mission_bundle_checks WHERE bundle_digest=? ORDER BY criterion_id, evaluator").all(row.digest) as Array<{ criterion_id: string; evaluator: string; outcome: "passed" | "failed" | "incomplete"; evidence_digest: string; advisory: number }>)
    .map((check) => ({ criterionId: check.criterion_id, evaluator: check.evaluator, outcome: check.outcome, evidenceDigest: check.evidence_digest, advisory: check.advisory === 1 }));
  return { ...manifest, digest: row.digest, state: row.state, findings: JSON.parse(row.findings_json) as string[], checks, createdAt: iso(row.created_at_ms) };
}

/**
 * Free-text task criteria cannot name the checks a workflow's evaluator
 * defines. When none of the criteria share a name with any check (the checks
 * speak the workflow's vocabulary, not the task's), they are covered if every
 * check of the verified bundle passed; the bundle is the task's own run's and
 * carries an independent verdict (both asserted before Done). Any overlap means
 * the checks do address the criteria, so each criterion needs its own passed check.
 */
export function workflowCovers(checks: ReadonlyArray<{ criterionId?: string; status: string }> | undefined, criteria: readonly string[]): boolean {
  const list = checks ?? [];
  return list.length > 0 && list.every((check) => check.status === "passed") && !list.some((check) => check.criterionId !== undefined && criteria.includes(check.criterionId));
}
