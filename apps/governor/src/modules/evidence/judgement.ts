import type { HandoffNotes, MissionJudge } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { latestBundleRow } from "./handoff";

type Db = ReturnType<Store["workspaceDb"]>;
type Reason = NonNullable<MissionJudge["reason"]>;

/** A failed model call is tried again after this long, up to the limit; after that the sign-off view says the judge was unavailable (ADR 0023). */
export const JUDGE_RETRY_MS = 5 * 60_000;
export const JUDGE_MAX_TRIES = 3;
const MATERIAL_CHARS = 24_000;
const RESULT_CHARS = 8_000;

export interface Judgement { readonly bundleDigest: string; readonly missionId: string; readonly state: MissionJudge["state"]; readonly tries: number; readonly updatedAtMs: number }
type JudgementRow = { bundle_digest: string; mission_id: string; state: MissionJudge["state"]; tries: number; updated_at_ms: number };
const viewOf = (row: JudgementRow): Judgement => ({ bundleDigest: row.bundle_digest, missionId: row.mission_id, state: row.state, tries: row.tries, updatedAtMs: row.updated_at_ms });

function announce(store: Store, db: Db, missionId: string, digest: string): void {
  store.emit(db, { aggregateType: "mission", aggregateId: missionId, eventType: "mission.bundleJudged", payload: { missionId, digest } });
}

/**
 * The judge's work list (#95): the current bundle of every verifying mission that is still submitted and has no request yet gets one, and a
 * request whose bundle was judged by a person, replaced or left by its mission is closed as too late. A failed request that is due is tried
 * again; one a restart left running (nothing in this process holds it) goes back to pending. Returns the requests that are pending now.
 */
export function judgeWorkList(store: Store, db: Db, inFlight: ReadonlySet<string>, open: boolean): Judgement[] {
  const now = store.now();
  if (open) {
    for (const { id } of db.prepare("SELECT id FROM missions WHERE state='verifying'").all() as Array<{ id: string }>) {
      const latest = latestBundleRow(db, id);
      if (latest?.state !== "submitted" || db.prepare("SELECT 1 FROM mission_bundle_judgements WHERE bundle_digest=?").get(latest.digest)) continue;
      db.prepare("INSERT INTO mission_bundle_judgements(bundle_digest,state,created_at_ms,updated_at_ms) VALUES (?,'pending',?,?)").run(latest.digest, now, now);
    }
  }
  const live = db.prepare(`SELECT j.bundle_digest, b.mission_id, j.state, j.tries, j.updated_at_ms, m.state AS mission_state FROM mission_bundle_judgements j
    JOIN mission_evidence_bundles b ON b.digest=j.bundle_digest JOIN missions m ON m.id=b.mission_id
    WHERE j.state IN ('pending','running') OR (j.state='unavailable' AND j.tries<? AND j.updated_at_ms<=?)`).all(JUDGE_MAX_TRIES, now - JUDGE_RETRY_MS) as Array<JudgementRow & { mission_state: string }>;
  const out: Judgement[] = [];
  for (const row of live) {
    if (row.state === "running" && inFlight.has(row.bundle_digest)) continue;
    const latest = latestBundleRow(db, row.mission_id);
    if (latest?.digest !== row.bundle_digest || latest.state !== "submitted" || row.mission_state !== "verifying") { finishJudgement(store, db, row.bundle_digest, row.mission_id, { state: "not-run", reason: "too-late" }); continue; }
    if (row.state !== "pending") db.prepare("UPDATE mission_bundle_judgements SET state='pending', updated_at_ms=? WHERE bundle_digest=?").run(now, row.bundle_digest);
    out.push(viewOf({ ...row, state: "pending" }));
  }
  return out;
}

/** Takes a pending request for this process; false when another pass already holds it, so a bundle is never judged (or charged) twice. */
export function claimJudgement(store: Store, db: Db, digest: string, missionId: string, model: string): boolean {
  const claimed = db.prepare("UPDATE mission_bundle_judgements SET state='running', model=?, updated_at_ms=? WHERE bundle_digest=? AND state='pending'").run(model, store.now(), digest).changes === 1;
  if (claimed) announce(store, db, missionId, digest);
  return claimed;
}

export function finishJudgement(store: Store, db: Db, digest: string, missionId: string, end: { state: "done" | "unavailable" | "not-run"; reason?: Reason; detail?: string; failed?: boolean }): void {
  db.prepare("UPDATE mission_bundle_judgements SET state=?, reason=?, detail=?, tries=tries+?, updated_at_ms=? WHERE bundle_digest=? AND state IN ('pending','running')")
    .run(end.state, end.reason ?? "", (end.detail ?? "").slice(0, 500), end.failed ? 1 : 0, store.now(), digest);
  announce(store, db, missionId, digest);
}

/** The criterion ids the judge already gave an opinion on for this bundle (a resumed request does not ask, or charge, again). */
export function judgedCriteria(db: Db, digest: string): Set<string> {
  return new Set((db.prepare("SELECT criterion_id FROM mission_bundle_checks WHERE bundle_digest=? AND evaluator LIKE 'judge:%'").all(digest) as Array<{ criterion_id: string }>).map((row) => row.criterion_id));
}

/**
 * An evaluator's check on a mission's current evidence bundle (T44). Checks inform the mission verdict; recording one never changes the
 * bundle's state. Evidence must be a real artifact of the workspace. `bundleDigest`, when given, must still be the current submitted
 * bundle: a late opinion of the advisory judge is never stamped on a later bundle.
 */
export function recordBundleCheck(store: Store, db: Db, input: { missionId: string; bundleDigest?: string; criterionId: string; evaluator: string; outcome: "passed" | "failed" | "incomplete"; evidenceDigest: string; advisory?: boolean }): void {
  const bundle = latestBundleRow(db, input.missionId);
  if (!bundle) throw new BrainDomainError("NOT_FOUND", "the mission has no evidence bundle");
  if (input.bundleDigest !== undefined && bundle.digest !== input.bundleDigest) throw new BrainDomainError("CONFLICT", "the mission's evidence bundle has been replaced");
  if (bundle.state !== "submitted") throw new BrainDomainError("CONFLICT", `a ${bundle.state} mission evidence bundle takes no new checks`);
  if (!db.prepare("SELECT 1 FROM artifacts WHERE digest=?").get(input.evidenceDigest)) throw new BrainDomainError("EVIDENCE_MISSING", "check evidence artifact not found in workspace");
  db.prepare("INSERT OR REPLACE INTO mission_bundle_checks(bundle_digest, criterion_id, evaluator, outcome, evidence_digest, advisory, created_at_ms) VALUES (?,?,?,?,?,?,?)")
    .run(bundle.digest, input.criterionId, input.evaluator, input.outcome, input.evidenceDigest, input.advisory ? 1 : 0, store.now());
}

/**
 * What the judge may read for one criterion: per serving work item, its handoff summary and decisions, the verified checks that name the
 * criterion and the written result. Nothing is invented: a criterion no readable text backs gets no material, so no model call and no check.
 */
export function criterionMaterial(db: Db, criterion: { criterionId: string; workItemIds: readonly string[]; checks: ReadonlyArray<{ name: string; outcome: string }> }, resultOf: (workItemId: string) => string | undefined): string | undefined {
  const parts: string[] = [];
  for (const workItemId of criterion.workItemIds) {
    const item = db.prepare("SELECT title, state FROM work_items WHERE id=?").get(workItemId) as { title: string; state: string } | undefined;
    if (!item) continue;
    const handoff = db.prepare("SELECT notes_json FROM handoffs WHERE work_item_id=? AND superseded_by IS NULL AND delegation_id IS NULL").get(workItemId) as { notes_json: string } | undefined;
    const notes = handoff ? JSON.parse(handoff.notes_json) as HandoffNotes : undefined;
    const result = resultOf(workItemId)?.trim();
    const lines = [
      ...(notes ? [`Handoff summary: ${notes.summary}`, ...(notes.decisions ?? []).map((decision) => `Decision: ${decision}`), ...(notes.openQuestions ?? []).map((question) => `Open question: ${question}`)] : []),
      ...(result ? [`Written result:\n${result.slice(0, RESULT_CHARS)}`] : []),
    ];
    if (lines.length > 0) parts.push([`Task "${item.title}" (${item.state})`, ...lines].join("\n"));
  }
  if (parts.length === 0) return undefined;
  const checks = criterion.checks.map((check) => `Verified check ${check.name}: ${check.outcome}`);
  return [...parts, ...checks].join("\n\n").slice(0, MATERIAL_CHARS);
}
