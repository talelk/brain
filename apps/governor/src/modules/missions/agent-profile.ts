import type { ActivityProfile, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { FAILURE_LABEL, isFailureClass } from "../../domain/failure";
import { ALL_SPEND } from "./usage";

type Db = ReturnType<Store["workspaceDb"]>;
type Status = ActivityProfile["status"]["state"];

/** The trailing window every rate of a profile is computed over, the same one the Quality page uses. */
export const PROFILE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const RECENT_RUNS = 10;
const TOP_FAILURES = 5;

const STATUS_DEFINITION = "Worked out from the session records every time it is read, never stored: working when a session of it is starting, running or stopping; else waiting when one is waiting for a person or an answer; else failing when its latest ended session failed; else idle.";
const VERIFIED_DEFINITION = "Results this agent's attempts submitted in the window that an independent check judged, divided into those judged verified (the latest verdict on each result counts). An attempt with no result, or a result not yet judged, is not counted.";
const FAILURE_DEFINITION = "Failed task runs in the window whose attempt this agent made, grouped by failure class (the class the Governor stored for the run). Each run counts once.";

interface AttributedSession {
  id: string; job_id: string | null; attempt_id: string | null; work_item_id: string | null; mission_id: string | null; task: string; state: string;
  created_at_ms: number; updated_at_ms: number; agent_id: string; member_id: string | null; run_id: string | null;
}

/**
 * Every session of the workspace with the agent definition it ran (stamped when the Governor created it) and the team member its attempt was
 * charged to (the ledger's member, ADR 0051, else the member the task is assigned to). Newest first.
 */
function attributedSessions(db: Db, where: string, params: readonly unknown[], limit: number): AttributedSession[] {
  return db.prepare(`SELECT * FROM (
      SELECT s.id, s.job_id, s.attempt_id, s.work_item_id, COALESCE(s.mission_id, w.mission_id, sp.mission_id) AS mission_id, s.task, s.state, s.created_at_ms, s.updated_at_ms, s.agent_id,
        COALESCE(sp.member_id, CASE WHEN json_extract(w.assignment_json,'$.kind')='agent' THEN json_extract(w.assignment_json,'$.id') END) AS member_id, sp.run_id
      FROM sessions s LEFT JOIN ${ALL_SPEND} sp ON sp.attempt_id=s.attempt_id LEFT JOIN work_items w ON w.id=s.work_item_id
    ) WHERE ${where} ORDER BY updated_at_ms DESC, id LIMIT ?`).all(...params as never[], limit) as AttributedSession[];
}

const WORKING = new Set(["starting", "running", "stopping"]);

/** The first status that holds, in the order the definition states. A session that has ended is `stopped` or `failed`. */
export function deriveStatus(sessions: readonly Pick<AttributedSession, "id" | "state" | "updated_at_ms">[]): ActivityProfile["status"] {
  const hit = (test: (state: string) => boolean) => sessions.find((session) => test(session.state));
  const make = (state: Status, reason: string, session?: Pick<AttributedSession, "id" | "updated_at_ms">): ActivityProfile["status"] =>
    ({ state, reason, definition: STATUS_DEFINITION, ...(session ? { sessionId: session.id, since: iso(session.updated_at_ms) } : {}) });
  const working = hit((state) => WORKING.has(state));
  if (working) return make("working", "A session of it is running now.", working);
  const waiting = hit((state) => state === "waiting");
  if (waiting) return make("waiting", "A session of it is waiting for a person or an answer.", waiting);
  const latest = sessions.find((session) => session.state === "stopped" || session.state === "failed");
  if (latest?.state === "failed") return make("failing", "Its latest ended session failed.", latest);
  return make("idle", sessions.length === 0 ? "No session of it has run yet." : "None of its sessions is running or waiting, and its latest ended well.", latest);
}

function runOf(session: AttributedSession): ActivityProfile["recentRuns"][number] {
  return {
    sessionId: session.id, task: session.task, state: session.state as ActivityProfile["recentRuns"][number]["state"], createdAt: iso(session.created_at_ms), updatedAt: iso(session.updated_at_ms),
    ...(session.job_id ? { jobId: session.job_id } : {}), ...(session.run_id ? { runId: session.run_id } : {}),
    ...(session.mission_id ? { missionId: session.mission_id } : {}), ...(session.work_item_id ? { workItemId: session.work_item_id } : {}), ...(session.member_id ? { memberId: session.member_id } : {}),
  };
}

/** The attempts the ledger charged to this agent (or to this member of one mission): the Governor's own attribution, the same rows usage reads. */
interface Scope { sql: string; params: readonly unknown[] }

function figures(store: Store, db: Db, attempts: Scope, failureWhere: string, failureParams: readonly unknown[], sessions: AttributedSession[]): Pick<ActivityProfile, "status" | "sessions" | "recentRuns" | "metrics" | "failureClasses" | "window"> {
  const to = store.now();
  const from = to - PROFILE_WINDOW_DAYS * DAY_MS;
  const attemptIds = `SELECT attempt_id FROM ${ALL_SPEND} WHERE source='attempt' AND ${attempts.sql}`;
  const verdicts = db.prepare(`SELECT COUNT(*) AS judged, COALESCE(SUM(CASE WHEN outcome='verified' THEN 1 ELSE 0 END),0) AS verified FROM (
      SELECT (SELECT v.outcome FROM verification_verdicts v WHERE v.bundle_digest=eb.digest ORDER BY COALESCE(v.finalized_at_ms, v.created_at_ms) DESC, v.id DESC LIMIT 1) AS outcome
      FROM evidence_bundles eb WHERE eb.created_at_ms>=? AND eb.attempt_id IN (${attemptIds})) WHERE outcome IS NOT NULL`).get(from, ...attempts.params as never[]) as { judged: number; verified: number };
  const classes = db.prepare(`SELECT tf.failure_class AS code, COUNT(*) AS count FROM task_failures tf WHERE tf.created_at_ms>=? AND ${failureWhere}
      AND tf.run_id IN (SELECT run_id FROM ${ALL_SPEND} WHERE source='attempt' AND ${attempts.sql}) GROUP BY tf.failure_class ORDER BY count DESC, tf.failure_class LIMIT ?`)
    .all(from, ...failureParams as never[], ...attempts.params as never[], TOP_FAILURES) as Array<{ code: string; count: number }>;
  return {
    status: deriveStatus(sessions),
    sessions: { live: sessions.filter((session) => ["starting", "running", "waiting", "stopping"].includes(session.state)).length, total: sessions.length },
    recentRuns: sessions.slice(0, RECENT_RUNS).map(runOf),
    metrics: [{ id: "verified-rate", label: "Verified rate", unit: "ratio", definition: VERIFIED_DEFINITION, numerator: verdicts.verified, denominator: verdicts.judged, ...(verdicts.judged ? { value: verdicts.verified / verdicts.judged } : {}) }],
    failureClasses: { definition: FAILURE_DEFINITION, items: classes.filter((entry) => isFailureClass(entry.code)).map((entry) => ({ code: entry.code as keyof typeof FAILURE_LABEL, label: FAILURE_LABEL[entry.code as keyof typeof FAILURE_LABEL], count: entry.count })) },
    window: { from: iso(from), to: iso(to), days: PROFILE_WINDOW_DAYS },
  };
}

/** One agent definition's activity: derived status, recent runs, verified rate, top failure classes. Cost is `usage.agent`. */
export function agentProfile(store: Store, db: Db, agentId: string): ActivityProfile {
  const sessions = attributedSessions(db, "agent_id=?", [agentId], 500);
  return { scope: "agent", id: agentId, agentId, ...figures(store, db, { sql: "agent_id=?", params: [agentId] }, "1=1", [], sessions) };
}

/** The agents the workspace has seen at work, each with its profile: what the Library's Agents list shows next to the release's definitions. */
export function agentProfiles(store: Store, db: Db): ActivityProfile[] {
  const ids = (db.prepare("SELECT DISTINCT agent_id FROM sessions WHERE agent_id!='' ORDER BY agent_id LIMIT 100").all() as Array<{ agent_id: string }>).map((row) => row.agent_id);
  return ids.map((id) => agentProfile(store, db, id));
}

/**
 * One team member of one mission (`<missionId>:<memberId>`, a member id being the plan's own label): its sessions, tasks, status and rates.
 * Cost is `usage.member`. The member of a session is the one its attempt was charged to.
 */
export function memberProfile(store: Store, db: Db, missionId: string, memberId: string): ActivityProfile {
  const sessions = attributedSessions(db, "mission_id=? AND member_id=?", [missionId, memberId], 500);
  const tasks = (db.prepare("SELECT id, title, state, parked, failure_class FROM work_items WHERE mission_id=? AND state!='abandoned' AND json_extract(assignment_json,'$.kind')='agent' AND json_extract(assignment_json,'$.id')=? ORDER BY created_at_ms, id")
    .all(missionId, memberId) as Array<{ id: string; title: string; state: string; parked: number; failure_class: string | null }>)
    .map((row) => ({ workItemId: row.id, title: row.title, state: row.state as "backlog", parked: row.parked === 1, ...(row.failure_class && isFailureClass(row.failure_class) ? { failureClass: row.failure_class } : {}) }));
  const agents = new Set((db.prepare(`SELECT DISTINCT agent_id FROM ${ALL_SPEND} WHERE mission_id=? AND member_id=? AND agent_id IS NOT NULL ORDER BY agent_id`).all(missionId, memberId) as Array<{ agent_id: string }>).map((row) => row.agent_id));
  return {
    scope: "member", id: `${missionId}:${memberId}`, memberId, missionId, ...figures(store, db, { sql: "mission_id=? AND member_id=?", params: [missionId, memberId] }, "tf.mission_id=?", [missionId], sessions),
    tasks, ...(agents.size ? { agentIds: [...agents] } : {}),
  };
}

/** Splits a member profile's `<missionId>:<memberId>` key the way `usage.member` does. */
export function splitMemberKey(resourceId: string | undefined): { missionId: string; memberId: string } {
  const [missionId = "", memberId = ""] = String(resourceId ?? "").split(/:(?=[^:]*$)/u);
  if (!missionId || !memberId) throw new BrainDomainError("INVALID_ARGUMENT", "a member is named <missionId>:<memberId>");
  return { missionId, memberId };
}

export const asJson = (value: ActivityProfile | { items: ActivityProfile[] }): JsonValue => value as unknown as JsonValue;
