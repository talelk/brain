import type { AutonomyDecisionRecord, AutonomyFigure, AutonomyPreset, AutonomySuggestion, Workflow } from "@brain/contracts";
import type { Store } from "../../application/store";
import { iso } from "../../domain/clock";
import { FAILURE_LABEL, isFailureClass } from "../../domain/failure";
import { effectfulStep, repeatSettings } from "./repeat";
import { GENERAL_TASK_WORKFLOW } from "../workflows/task-experience";

type Db = ReturnType<Store["workspaceDb"]>;

/** The trailing window a track record is counted in: the Quality summary's. */
export const SUGGESTION_WINDOW_DAYS = 30;
/** Completed tasks a record needs before Brain suggests anything. */
export const SUGGESTION_MIN_COMPLETED = 5;
const DAY_MS = 86_400_000;

export const PRESET_ORDER: readonly AutonomyPreset[] = ["supervised", "standard", "autonomous"];
/** The preset one step above, or none at the top. */
export const nextPreset = (preset: AutonomyPreset): AutonomyPreset | undefined => PRESET_ORDER[PRESET_ORDER.indexOf(preset) + 1];

const NEVER_AUTO_APPROVES = "Raising autonomy never approves an effect: every effect still needs its own approval, and intent, constraints, budget, started work and declaring a mission achieved stay with a person.";
export const REPEAT_FROM = "ask each time";
export const REPEAT_TO = "confirm automatically";

const DEFINITIONS = {
  completed: `Tasks that reached Done in the counted period, over the missions named below. A suggestion needs at least ${SUGGESTION_MIN_COMPLETED}.`,
  verified: `Results of those missions' runs that an independent check judged in the counted period, divided into those whose latest verdict is verified. A suggestion needs at least ${SUGGESTION_MIN_COMPLETED} judged results and every one verified.`,
  stall: "Tasks parked after repeated failures in the counted period, divided by tasks created or changed in it. A suggestion needs none.",
  reopen: "Sign-offs rejected, tasks sent back from review and missions re-opened after Verifying in the counted period; each also saves an eval case. A suggestion needs none.",
  failures: "Failed task runs recorded in the counted period. A suggestion needs none.",
} as const;

const COUNTED = `The counted period starts at the latest of: ${SUGGESTION_WINDOW_DAYS} days ago, the last rejected verdict, failed run, parked task, eval case or re-opened mission, and the last time a person accepted or dismissed a suggestion for this. A new problem therefore withdraws a suggestion at once, and it comes back only after fresh clean work.`;

interface TrackRecord {
  readonly since: number;
  readonly reason: string;
  /** True when nothing but the trailing window limits the count: no problem and no decision of a person in it. */
  readonly windowOnly: boolean;
  readonly figures: AutonomyFigure[];
  readonly met: boolean;
  readonly evidence: AutonomySuggestion["evidence"];
}

const marks = (ids: readonly string[]) => ids.map(() => "?").join(",");

/** Everything one suggestion subject's missions have done: figures over the counted period, whether every need is met, and the evidence to open. */
function trackRecord(store: Store, db: Db, missionIds: readonly string[], lastDecisionMs: number | undefined): TrackRecord {
  const to = store.now();
  const windowStart = to - SUGGESTION_WINDOW_DAYS * DAY_MS;
  if (missionIds.length === 0) return emptyRecord(windowStart);
  const M = marks(missionIds);
  const problems: Array<{ at: number; why: string }> = [];
  const bundles = db.prepare(`SELECT d.digest AS digest,
      (SELECT v.outcome FROM verification_verdicts v WHERE v.bundle_digest=d.digest ORDER BY COALESCE(v.finalized_at_ms, v.created_at_ms) DESC, v.id DESC LIMIT 1) AS outcome,
      (SELECT COALESCE(v.finalized_at_ms, v.created_at_ms) FROM verification_verdicts v WHERE v.bundle_digest=d.digest ORDER BY COALESCE(v.finalized_at_ms, v.created_at_ms) DESC, v.id DESC LIMIT 1) AS at
    FROM (SELECT DISTINCT eb.digest FROM evidence_bundles eb JOIN execution_links el ON el.job_id=eb.job_id WHERE el.mission_id IN (${M})) d`).all(...missionIds) as Array<{ digest: string; outcome: string | null; at: number | null }>;
  const judged = bundles.filter((row) => row.outcome !== null && row.at !== null) as Array<{ outcome: string; at: number }>;
  for (const row of judged) if (row.outcome !== "verified") problems.push({ at: row.at, why: "a result was not verified" });
  for (const row of db.prepare(`SELECT created_at_ms AS at FROM task_failures WHERE mission_id IN (${M})`).all(...missionIds) as Array<{ at: number }>) problems.push({ at: row.at, why: "a task run failed" });
  const evalAts = (db.prepare(`SELECT created_at_ms AS at FROM eval_cases WHERE mission_id IN (${M})`).all(...missionIds) as Array<{ at: number }>).map((row) => row.at);
  for (const at of evalAts) problems.push({ at, why: "an eval case was saved" });
  const parkedAts = (db.prepare(`SELECT e.created_at_ms AS at FROM events e JOIN work_items w ON w.id=e.aggregate_id WHERE e.event_type='workItem.parked' AND w.mission_id IN (${M})`).all(...missionIds) as Array<{ at: number }>).map((row) => row.at);
  for (const at of parkedAts) problems.push({ at, why: "a task was parked" });
  const reopenAts: number[] = [];
  const latestState = new Map<string, string>();
  for (const event of db.prepare(`SELECT aggregate_id AS id, json_extract(payload_json,'$.missionState') AS state, created_at_ms AS at FROM events WHERE event_type='mission.stateChanged' AND aggregate_id IN (${M}) ORDER BY cursor`).all(...missionIds) as Array<{ id: string; state: string; at: number }>) {
    if (event.state === "active" && latestState.get(event.id) === "verifying") reopenAts.push(event.at);
    latestState.set(event.id, event.state);
  }
  for (const at of reopenAts) problems.push({ at, why: "a mission was re-opened" });

  const inWindow = problems.filter((problem) => problem.at >= windowStart).sort((a, b) => b.at - a.at);
  const lastProblem = inWindow[0];
  // Counted records are those strictly after `since`: a problem and the work around it at the same instant stay on the problem's side.
  const since = Math.max(windowStart - 1, lastProblem?.at ?? 0, lastDecisionMs ?? 0);
  const decided = lastDecisionMs !== undefined && lastDecisionMs >= windowStart;
  const windowOnly = !decided && !lastProblem;
  const reason = decided && lastDecisionMs >= (lastProblem?.at ?? 0) ? "a person last decided on this" : lastProblem ? lastProblem.why : `the start of the ${SUGGESTION_WINDOW_DAYS}-day window`;

  const completed = (db.prepare(`SELECT COUNT(DISTINCT e.aggregate_id) AS n FROM events e JOIN work_items w ON w.id=e.aggregate_id
      WHERE e.event_type='workItem.transitioned' AND json_extract(e.payload_json,'$.state')='done' AND e.created_at_ms>? AND w.mission_id IN (${M})`).get(since, ...missionIds) as { n: number }).n;
  const judgedNow = judged.filter((row) => row.at > since);
  const verified = judgedNow.filter((row) => row.outcome === "verified").length;
  const active = (db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE mission_id IN (${M}) AND (updated_at_ms>? OR created_at_ms>?)`).get(...missionIds, since, since) as { n: number }).n;
  const parked = new Set(parkedAts.filter((at) => at > since)).size;
  const evalCount = evalAts.filter((at) => at > since).length + reopenAts.filter((at) => at > since).length;
  const failed = (db.prepare(`SELECT COUNT(*) AS n FROM task_failures WHERE mission_id IN (${M}) AND created_at_ms>?`).get(...missionIds, since) as { n: number }).n;

  const figures: AutonomyFigure[] = [
    { id: "completed-tasks", label: "Tasks completed", unit: "count", numerator: completed, needed: `at least ${SUGGESTION_MIN_COMPLETED}`, met: completed >= SUGGESTION_MIN_COMPLETED, definition: DEFINITIONS.completed },
    { id: "verified-rate", label: "Verified rate", unit: "ratio", numerator: verified, denominator: judgedNow.length, ...(judgedNow.length ? { value: verified / judgedNow.length } : {}),
      needed: `at least ${SUGGESTION_MIN_COMPLETED} judged, all verified`, met: judgedNow.length >= SUGGESTION_MIN_COMPLETED && verified === judgedNow.length, definition: DEFINITIONS.verified },
    { id: "stall-rate", label: "Stall rate", unit: "ratio", numerator: parked, denominator: active, ...(active ? { value: parked / active } : {}), needed: "none parked", met: parked === 0, definition: DEFINITIONS.stall },
    { id: "reopened-and-eval-cases", label: "Re-opened or sent back", unit: "count", numerator: evalCount, needed: "none", met: evalCount === 0, definition: DEFINITIONS.reopen },
    { id: "failed-runs", label: "Failed task runs", unit: "count", numerator: failed, needed: "none", met: failed === 0, definition: DEFINITIONS.failures },
  ];

  const classes = db.prepare(`SELECT failure_class AS code, COUNT(*) AS count FROM task_failures WHERE mission_id IN (${M}) AND created_at_ms>=? GROUP BY failure_class ORDER BY count DESC, failure_class LIMIT 5`).all(...missionIds, windowStart) as Array<{ code: string; count: number }>;
  const agents = (db.prepare(`SELECT DISTINCT s.agent_id AS id FROM sessions s JOIN work_items w ON w.id=s.work_item_id WHERE s.agent_id!='' AND w.mission_id IN (${M}) ORDER BY s.agent_id LIMIT 20`).all(...missionIds) as Array<{ id: string }>).map((row) => row.id);
  const evalInWindow = (db.prepare(`SELECT COUNT(*) AS n FROM eval_cases WHERE mission_id IN (${M}) AND created_at_ms>=?`).get(...missionIds, windowStart) as { n: number }).n;
  return {
    since: Math.max(windowStart, since), reason, windowOnly, figures, met: figures.every((figure) => figure.met),
    evidence: {
      missionIds: [...missionIds].slice(0, 50), agentIds: agents, evalCases: evalInWindow,
      failureClasses: classes.filter((entry) => isFailureClass(entry.code)).map((entry) => ({ code: entry.code as keyof typeof FAILURE_LABEL, label: FAILURE_LABEL[entry.code as keyof typeof FAILURE_LABEL], count: entry.count })),
    },
  };
}

function emptyRecord(windowStart: number): TrackRecord {
  const figures: AutonomyFigure[] = [{ id: "completed-tasks", label: "Tasks completed", unit: "count", numerator: 0, needed: `at least ${SUGGESTION_MIN_COMPLETED}`, met: false, definition: DEFINITIONS.completed }];
  return { since: windowStart, reason: `the start of the ${SUGGESTION_WINDOW_DAYS}-day window`, windowOnly: true, figures, met: false, evidence: { missionIds: [], agentIds: [], evalCases: 0, failureClasses: [] } };
}

/** The latest accepted or dismissed decision about one subject; it restarts the counted period. */
function lastDecision(db: Db, kind: string, subjectId: string): { decided_at_ms: number; decision: string; to_value: string } | undefined {
  return db.prepare("SELECT decided_at_ms, decision, to_value FROM autonomy_decisions WHERE kind=? AND subject_id=? ORDER BY decided_at_ms DESC, rowid DESC LIMIT 1").get(kind, subjectId) as { decided_at_ms: number; decision: string; to_value: string } | undefined;
}

/** The default preset a person accepted for a Play, if any: a mission started from the Play takes it before the release's own (always clipped to the workspace ceiling). */
export function acceptedPlayPreset(db: Db, playId: string): AutonomyPreset | undefined {
  const row = db.prepare("SELECT to_value FROM autonomy_decisions WHERE kind='play' AND subject_id=? AND decision='accepted' ORDER BY decided_at_ms DESC, rowid DESC LIMIT 1").get(playId) as { to_value: AutonomyPreset } | undefined;
  return row?.to_value;
}

export interface SuggestionContext {
  readonly store: Store;
  readonly db: Db;
  readonly organizationId: string;
  /** The plays of the active release. */
  readonly plays: Readonly<Record<string, { title: string; autonomy?: AutonomyPreset }>>;
  readonly workflows: Readonly<Record<string, Workflow>>;
  /** The most autonomy the workspace allows. */
  readonly ceiling: AutonomyPreset;
}

function make(kind: AutonomySuggestion["kind"], subjectId: string, subjectTitle: string, from: string, to: string, record: TrackRecord, now: number, extra: Partial<AutonomySuggestion> = {}): AutonomySuggestion {
  return {
    suggestionId: `${kind}:${subjectId}`, kind, subjectId, subjectTitle, from, to,
    window: { from: iso(now - SUGGESTION_WINDOW_DAYS * DAY_MS), to: iso(now), days: SUGGESTION_WINDOW_DAYS },
    counted: { since: iso(record.since), reason: record.reason, windowOnly: record.windowOnly, definition: COUNTED },
    figures: record.figures, evidence: record.evidence, effectsNote: NEVER_AUTO_APPROVES, ...extra,
  };
}

/** Every suggestion that holds right now, newest evidence first. Nothing here is stored; a record that turns bad simply stops producing its suggestion. */
export function currentSuggestions(ctx: SuggestionContext, filter?: { kind: string; subjectId: string }): AutonomySuggestion[] {
  const { store, db } = ctx;
  const now = store.now();
  const wants = (kind: string, id: string) => !filter || (filter.kind === kind && filter.subjectId === id);
  const ceilingIndex = PRESET_ORDER.indexOf(ctx.ceiling);
  const out: AutonomySuggestion[] = [];
  const within = (to: AutonomyPreset | undefined): to is AutonomyPreset => to !== undefined && PRESET_ORDER.indexOf(to) <= ceilingIndex;

  // A Play: the missions it started, against the preset its next mission would get.
  for (const [playId, play] of Object.entries(ctx.plays)) {
    if (!wants("play", playId)) continue;
    const current = acceptedPlayPreset(db, playId) ?? play.autonomy ?? "standard";
    const to = nextPreset(current);
    if (!within(to)) continue;
    const ids = (db.prepare("SELECT id FROM missions WHERE play_id=? ORDER BY created_at_ms DESC, id LIMIT 200").all(playId) as Array<{ id: string }>).map((row) => row.id);
    const record = trackRecord(store, db, ids, lastDecision(db, "play", playId)?.decided_at_ms);
    if (record.met) out.push(make("play", playId, play.title, current, to, record, now));
  }

  // A mission still open: its own tasks, against its own preset.
  for (const row of db.prepare("SELECT id, title, policy_json FROM missions WHERE state!='closed' ORDER BY updated_at_ms DESC, id LIMIT 200").all() as Array<{ id: string; title: string; policy_json: string }>) {
    if (!wants("mission", row.id)) continue;
    const preset = (() => { try { return (JSON.parse(row.policy_json) as { preset?: AutonomyPreset }).preset; } catch { return undefined; } })();
    const to = preset ? nextPreset(preset) : undefined;
    if (!preset || !within(to)) continue;
    const record = trackRecord(store, db, [row.id], lastDecision(db, "mission", row.id)?.decided_at_ms);
    if (record.met) out.push(make("mission", row.id, row.title, preset, to, record, now));
  }

  // A repeated plan whose schedule asks each time: only where ADR 0017's own conditions already hold, so the switch would do something.
  for (const row of db.prepare("SELECT id, title, input_json FROM automations WHERE state='active' ORDER BY updated_at_ms DESC, id LIMIT 100").all() as Array<{ id: string; title: string; input_json: string | null }>) {
    if (!wants("repeat", row.id)) continue;
    const settings = repeatSettings(row.input_json);
    if (settings.autoConfirm || !settings.sourceMissionId) continue;
    const source = db.prepare("SELECT m.state, m.outcome, m.policy_json AS policy, p.tasks_json AS tasks FROM missions m LEFT JOIN plan_versions p ON p.id=m.active_plan_version_id WHERE m.id=?").get(settings.sourceMissionId) as { state: string; outcome: string | null; policy: string; tasks: string | null } | undefined;
    if (!source?.tasks || source.state !== "closed" || source.outcome !== "achieved") continue;
    const bundle = db.prepare("SELECT state FROM mission_evidence_bundles WHERE mission_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(settings.sourceMissionId) as { state: string } | undefined;
    if (bundle?.state !== "verified") continue;
    const preset = (() => { try { return (JSON.parse(source.policy) as { preset?: string }).preset; } catch { return undefined; } })();
    if (preset !== "standard" && preset !== "autonomous") continue;
    const tasks = JSON.parse(source.tasks) as Array<{ workflowId?: string }>;
    if (tasks.some((task) => effectfulStep(ctx.workflows, task.workflowId ?? GENERAL_TASK_WORKFLOW))) continue;
    const ids = [settings.sourceMissionId, ...(db.prepare("SELECT m.id AS id FROM missions m JOIN automation_occurrences o ON o.id=m.started_by_occurrence WHERE o.automation_id=?").all(row.id) as Array<{ id: string }>).map((entry) => entry.id)];
    const record = trackRecord(store, db, [...new Set(ids)], lastDecision(db, "repeat", row.id)?.decided_at_ms);
    if (record.met) out.push(make("repeat", row.id, row.title, REPEAT_FROM, REPEAT_TO, record, now, { sourceMissionId: settings.sourceMissionId }));
  }
  return out;
}

export function recordDecision(store: Store, db: Db, input: { kind: AutonomySuggestion["kind"]; subjectId: string; decision: "accepted" | "dismissed"; suggestion: AutonomySuggestion; actorId: string }): string {
  const id = store.id("autonomy");
  db.prepare("INSERT INTO autonomy_decisions(id,kind,subject_id,decision,from_value,to_value,figures_json,decided_by,decided_at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, input.kind, input.subjectId, input.decision, input.suggestion.from, input.suggestion.to, JSON.stringify({ figures: input.suggestion.figures, counted: input.suggestion.counted, evidence: input.suggestion.evidence }), input.actorId, store.now());
  return id;
}

/** A person's decisions, newest first: who decided, when, and the figures that stood then. */
export function listDecisions(db: Db, filter: { kind: string; subjectId: string } | undefined, limit: number): AutonomyDecisionRecord[] {
  const rows = (filter
    ? db.prepare("SELECT * FROM autonomy_decisions WHERE kind=? AND subject_id=? ORDER BY decided_at_ms DESC, rowid DESC LIMIT ?").all(filter.kind, filter.subjectId, limit)
    : db.prepare("SELECT * FROM autonomy_decisions ORDER BY decided_at_ms DESC, rowid DESC LIMIT ?").all(limit)) as Array<{ id: string; kind: AutonomyDecisionRecord["kind"]; subject_id: string; decision: AutonomyDecisionRecord["decision"]; from_value: string; to_value: string; figures_json: string; decided_by: string; decided_at_ms: number }>;
  return rows.map((row) => {
    const stored = JSON.parse(row.figures_json) as { figures: AutonomyFigure[]; counted: AutonomySuggestion["counted"] };
    return { decisionId: row.id, kind: row.kind, subjectId: row.subject_id, decision: row.decision, from: row.from_value, to: row.to_value, figures: stored.figures, counted: stored.counted, decidedBy: row.decided_by, decidedAt: iso(row.decided_at_ms) };
  });
}
