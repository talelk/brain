import type { Store } from "../../application/store";
import { readVerified } from "../artifacts/index";
import { looksLikeSecret } from "../knowledge/index";

type Db = ReturnType<Store["workspaceDb"]>;

/** The readable asset stays inside the contract's 12000 characters, cut section by section. */
export const ASSET_CHARS = 12000;

/**
 * Below this much substance a finished mission is not written up (row 48). Substance is the characters of the worker's
 * Result summary and deliverable, accepted decisions and verified output previews together. A short run that produced
 * nothing a later mission could use would only add one more row to the Review inbox and one more weak hit to search.
 * `docs/specs/reuse-memory-tools-and-context.md` (Capitalization write-up) documents the rule.
 */
export const SUBSTANCE_MIN_CHARS = 200;
/** The shipped install check ("Try a sample goal") and missions titled as tests are never worth reusing. */
export const TRIVIAL_TITLE = /^(sample goal\b|test\b|smoke\b|demo\b|dummy\b|hello\b)/iu;
const EXCERPT_CHARS = 2400;

/** The shape of a finished general-task report (`task-output.json`), read defensively. */
interface WorkerReport { summary?: unknown; deliverable?: unknown; criteria?: unknown; assumptions?: unknown }
export interface ReportedResult { title: string; summary: string; deliverable: string; criteria: Array<{ criterion: string; met: boolean; evidence: string }>; assumptions: string[] }

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);

/** A section is left out when it has nothing to say; an empty heading is noise. */
const section = (heading: string, lines: readonly string[], budget: number): string => {
  if (lines.length === 0) return "";
  const body: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) { body.push(`(${lines.length - body.length} more not shown)`); break; }
    body.push(line); used += line.length + 1;
  }
  return `${heading}\n${body.join("\n")}`;
};

/** The goal as a key two write-ups share when they ask for the same thing: case, spacing and punctuation do not matter. */
export const goalKey = (intent: string): string => intent.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** What the finished work items of a mission reported, from the step outputs of their succeeded runs (the same join the Result page uses). */
export function reportedResults(db: Db, missionId: string): ReportedResult[] {
  const items = db.prepare("SELECT id, title FROM work_items WHERE mission_id=? AND state='done' ORDER BY rowid").all(missionId) as Array<{ id: string; title: string }>;
  const out: ReportedResult[] = [];
  for (const item of items) {
    const rows = db.prepare(`SELECT o.output_json FROM execution_links l JOIN workflow_runs r ON r.id=l.run_id AND r.state='succeeded'
      JOIN step_outputs o ON o.run_id=r.id WHERE l.work_item_id=? ORDER BY l.created_at_ms DESC, o.rowid`).all(item.id) as Array<{ output_json: string }>;
    for (const row of rows) {
      let report: WorkerReport;
      try { report = JSON.parse(row.output_json) as WorkerReport; } catch { continue; }
      const deliverable = text(report.deliverable);
      const summary = text(report.summary);
      if (!deliverable && !summary) continue;
      const criteria = Array.isArray(report.criteria) ? (report.criteria as Array<Record<string, unknown>>).flatMap((entry) => {
        const criterion = text(entry["criterion"]);
        return criterion ? [{ criterion, met: entry["met"] === true, evidence: text(entry["evidence"]) }] : [];
      }) : [];
      const assumptions = Array.isArray(report.assumptions) ? (report.assumptions as unknown[]).map(text).filter(Boolean) : [];
      out.push({ title: item.title, summary, deliverable, criteria, assumptions });
      break;
    }
  }
  return out;
}

/** A bounded excerpt that ends at a paragraph or sentence where it can, never mid-word, and never carries something that looks like a secret. */
function excerptOf(deliverable: string): string {
  if (!deliverable || looksLikeSecret(deliverable)) return "";
  if (deliverable.length <= EXCERPT_CHARS) return deliverable;
  const cut = deliverable.slice(0, EXCERPT_CHARS);
  const boundary = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return `${(boundary > EXCERPT_CHARS / 2 ? cut.slice(0, boundary + 1) : cut.replace(/\s+\S*$/u, "")).trimEnd()}\n(excerpt: the first ${EXCERPT_CHARS} of ${deliverable.length} characters; the full text is in the mission's Result)`;
}

const normalise = (value: string): string => value.toLowerCase().replace(/\s+/gu, " ").replace(/[.\s]+$/u, "").trim();

export interface Writeup {
  readonly content: string;
  readonly title: string;
  /** Why the mission is not written up (shown nowhere but the capitalization run's count), else undefined. */
  readonly skipped?: string;
}

/**
 * The deterministic knowledge write-up of an achieved mission: goal, the worker's Result summary and a bounded excerpt of
 * the deliverable, each success criterion with how it was checked, assumptions, decisions, verified outputs, what was
 * reused, what the verdict rejected, workflows, cost and time. Every claim says where it came from: the verified result,
 * the worker's own statement, or the mission verdict. Member notes, messages and transcripts are never read. Sections with
 * nothing to say are omitted. A mission below the substance threshold returns `skipped`.
 */
export function buildWriteup(store: Store, db: Db, mission: { id: string; title: string; intent: string; success_criteria_json: string; active_ms: number }, verified: { digest: string; created_at_ms: number }, rejectedBundles: ReadonlyArray<{ digest: string; findings_json: string }>): Writeup {
  const checks = db.prepare("SELECT evaluator, outcome, advisory FROM mission_bundle_checks WHERE bundle_digest=? ORDER BY criterion_id, evaluator").all(verified.digest) as Array<{ evaluator: string; outcome: string; advisory: number }>;
  const independent = checks.filter((check) => check.advisory === 0 && check.outcome === "passed");
  const advisory = checks.filter((check) => check.advisory === 1);
  const verdictDay = new Date(verified.created_at_ms).toISOString().slice(0, 10);
  const basis = independent.length > 0
    ? `verified: ${independent.length} independent check${independent.length === 1 ? "" : "s"} passed (${[...new Set(independent.map((check) => check.evaluator))].join(", ")}) and a mission verdict recorded by a person on ${verdictDay}${advisory.length ? `; ${advisory.length} advisory model-opinion check${advisory.length === 1 ? "" : "s"} did not decide the outcome` : ""}`
    : `verified: human sign-off, mission verdict recorded by a person on ${verdictDay}`;
  const reports = reportedResults(db, mission.id);
  const decisions = (db.prepare("SELECT statement, source_kind FROM accepted_decisions WHERE mission_id=? AND superseded_by IS NULL ORDER BY introduced_version, id").all(mission.id) as Array<{ statement: string; source_kind: string }>)
    .map((row) => `- ${row.statement} (accepted by a person; source: ${row.source_kind})`);
  const outputs = (db.prepare("SELECT o.name, v.artifact_digest FROM output_versions v JOIN mission_outputs o ON o.id=v.output_id WHERE o.mission_id=? AND v.verified=1 ORDER BY o.name, v.id").all(mission.id) as Array<{ name: string; artifact_digest: string }>)
    .map((row) => {
      let preview = "";
      try { preview = new TextDecoder("utf-8", { fatal: true }).decode(readVerified(store, row.artifact_digest)).replace(/\s+/gu, " ").trim().slice(0, 240); } catch { preview = "(binary or unreadable content)"; }
      return { line: `- ${row.name} [${row.artifact_digest}]${preview && !looksLikeSecret(preview) ? `: ${preview}` : ""}`, chars: preview.length };
    });
  const lastWithDeliverable = [...reports].reverse().find((report) => report.deliverable);
  const excerpt = lastWithDeliverable ? excerptOf(lastWithDeliverable.deliverable) : "";
  const summaries = reports.filter((report) => report.summary).map((report) => (reports.length > 1 ? `- ${report.title}: ${clip(report.summary, 600)}` : clip(report.summary, 1500)));
  const substance = reports.reduce((sum, report) => sum + report.summary.length + report.deliverable.length, 0) + decisions.join("").length + outputs.reduce((sum, output) => sum + output.chars, 0);
  const goal = mission.intent.trim();
  if (TRIVIAL_TITLE.test(mission.title.trim())) return { content: "", title: mission.title, skipped: "a sample or test mission" };
  if (substance < SUBSTANCE_MIN_CHARS) return { content: "", title: mission.title, skipped: `less than ${SUBSTANCE_MIN_CHARS} characters of result` };

  const criteriaText = (JSON.parse(mission.success_criteria_json) as string[]);
  const reported = reports.flatMap((report) => report.criteria);
  const criteria = criteriaText.map((criterion) => {
    const row = reported.find((entry) => normalise(entry.criterion) === normalise(criterion));
    const how = row ? ` Worker's report: ${row.met ? "met" : "not met"}${row.evidence ? `, ${clip(row.evidence, 300)}` : ""}.` : "";
    return `- ${criterion} [${basis}]${how}`;
  });
  const assumptions = [...new Set(reports.flatMap((report) => report.assumptions))].map((entry) => `- ${clip(entry, 300)} (the worker's assumption, not checked)`);
  const reused = (db.prepare("SELECT kind, title, provenance_json, self_reviewed FROM reuse_attachments WHERE mission_id=? AND decision='kept' ORDER BY decided_at_ms, id").all(mission.id) as Array<{ kind: string; title: string; provenance_json: string; self_reviewed: number }>)
    .map((row) => {
      const provenance = JSON.parse(row.provenance_json) as { missionId?: string };
      return `- ${row.kind}: ${row.title}${provenance.missionId ? ` (from mission ${provenance.missionId})` : ""}${row.self_reviewed ? ", self-reviewed" : ""}`;
    });
  const rejected = rejectedBundles.flatMap((bundle) => (JSON.parse(bundle.findings_json) as string[]).map((finding) => `- ${finding} (verdict ${bundle.digest.slice(0, 19)}...)`));
  const workflows = (db.prepare("SELECT DISTINCT workflow_id FROM work_items WHERE mission_id=? AND workflow_id IS NOT NULL ORDER BY workflow_id").all(mission.id) as Array<{ workflow_id: string }>).map((row) => `- ${row.workflow_id}`);
  const spend = (db.prepare("SELECT COALESCE(SUM(settled_micro_usd),0) AS micro FROM mission_spend WHERE mission_id=?").get(mission.id) as { micro: number }).micro;
  const minutes = Math.max(1, Math.round(mission.active_ms / 60_000));
  const footer = "Claim basis: [verified: ...] comes from the mission's verified evidence bundle; the Result summary, deliverable excerpt, worker's report and assumptions are what the worker wrote and passed the checks above, not independent proof. This is a record of past work, not evidence for a new mission.";
  const body = [
    `# ${mission.title}`,
    section("## Goal", [goal], 1200),
    section("## Result (the worker's summary, from the verified result)", summaries, 1600),
    excerpt ? `## Deliverable (excerpt)\n${excerpt}` : "",
    section("## Success criteria and how each was checked", criteria, 2200),
    section("## Assumptions made", assumptions, 900),
    section("## Decisions accepted along the way", decisions, 1000),
    section("## Verified outputs", outputs.map((output) => output.line), 1000),
    section("## What was reused", reused, 600),
    section("## What the verdict rejected, and why", rejected, 800),
    section("## Workflows used", workflows, 300),
    section("## Cost and time", [`- Settled spend: $${(spend / 1_000_000).toFixed(4)}`, `- Active time: about ${minutes} minute${minutes === 1 ? "" : "s"}`], 200),
  ].filter(Boolean).join("\n\n").slice(0, ASSET_CHARS - footer.length - 4);
  return { content: `${body}\n\n${footer}`, title: mission.title };
}
