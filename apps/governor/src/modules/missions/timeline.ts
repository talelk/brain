import type { MissionTimeline, MissionTimelineEntry, PlanAssignment, TeamMember } from "@brain/contracts";
import type { Store } from "../../application/store";
import { iso } from "../../domain/clock";

type Db = ReturnType<Store["workspaceDb"]>;
type Kind = MissionTimelineEntry["kind"];
type Entry = Omit<MissionTimelineEntry, "entryId" | "at"> & { atMs: number; key: string };

/** Entries of the same instant sort by this rank, so a request reads before its decision and a run before what it produced. */
const RANK: Readonly<Record<Kind, number>> = { plan: 0, decision: 1, message: 2, run: 3, approval: 4, effect: 5, verdict: 6, output: 7 };

const memberOf = (assignmentJson: string | null): string | undefined => {
  const assignment = assignmentJson ? JSON.parse(assignmentJson) as PlanAssignment : undefined;
  return assignment?.kind === "agent" ? assignment.id : undefined;
};
const marks = (values: readonly unknown[]): string => values.map(() => "?").join(",");
const clip = (text: string, max = 400): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The mission timeline: one chronological reading of what happened on a mission and why, composed on demand from records that already
 * exist (plan versions, accepted decisions, messages, runs, approvals, effects, verdicts, outputs). Nothing is stored for it. The
 * Governor returns what happened as an event code with its subject and outcome; the interface words it. Each entry names its source
 * record and, where a team member did or received the work, that member, so a person can filter by either.
 *
 * Control-plane records are read only through this workspace's own jobs, so another workspace's approvals never appear.
 * Order: time, then a fixed kind rank, then the record's key. When more than `limit` entries exist the newest are kept.
 */
export function missionTimeline(store: Store, db: Db, organizationId: string, workspaceId: string, missionId: string, limit: number): MissionTimeline {
  const entries: Entry[] = [];
  const add = (kind: Kind, atMs: number, key: string, entry: Omit<Entry, "kind" | "atMs" | "key">): void => { entries.push({ kind, atMs, key, ...entry }); };

  const mission = db.prepare("SELECT coordinator_member_id AS coordinator FROM missions WHERE id=?").get(missionId) as { coordinator: string | null };
  const plans = db.prepare("SELECT id, revision, state, summary, created_by, team_json, created_at_ms, confirmed_at_ms FROM plan_versions WHERE mission_id=? ORDER BY revision").all(missionId) as
    Array<{ id: string; revision: number; state: string; summary: string | null; created_by: string; team_json: string; created_at_ms: number; confirmed_at_ms: number | null }>;
  const roles = new Map<string, string>();
  for (const plan of plans) {
    for (const member of JSON.parse(plan.team_json) as TeamMember[]) roles.set(member.memberId, member.role);
    const common = { ...(plan.summary ? { subject: clip(plan.summary) } : {}), revision: plan.revision, source: { kind: "plan" as const, id: plan.id } };
    add("plan", plan.created_at_ms, `${plan.id}:0`, { event: "plan.proposed", actorId: plan.created_by, ...common });
    if (plan.confirmed_at_ms !== null) add("plan", plan.confirmed_at_ms, `${plan.id}:1`, { event: "plan.confirmed", ...common });
  }

  for (const row of db.prepare("SELECT id, statement, source_kind, accepted_by, created_at_ms FROM accepted_decisions WHERE mission_id=?").all(missionId) as
    Array<{ id: string; statement: string; source_kind: string; accepted_by: string; created_at_ms: number }>) {
    add("decision", row.created_at_ms, row.id, { event: "decision.accepted", subject: clip(row.statement), outcome: row.source_kind, actorId: row.accepted_by, source: { kind: "decision", id: row.id } });
  }

  for (const row of db.prepare("SELECT id, recipient_member_id, sender_id, body, correction_of, created_at_ms FROM mission_messages WHERE mission_id=?").all(missionId) as
    Array<{ id: string; recipient_member_id: string | null; sender_id: string; body: string; correction_of: string | null; created_at_ms: number }>) {
    add("message", row.created_at_ms, row.id, { event: row.correction_of ? "message.corrected" : "message.sent", subject: clip(row.body), actorId: row.sender_id, ...(row.recipient_member_id ? { memberId: row.recipient_member_id } : {}), source: { kind: "message", id: row.id } });
  }

  // Runs: a task's runs (with the team member its task is assigned to) and the coordinator's own.
  const runs = new Map<string, { startedMs: number; title?: string; memberId?: string; coordinator: boolean }>();
  for (const row of db.prepare("SELECT l.run_id, l.created_at_ms, w.title, w.assignment_json FROM execution_links l JOIN work_items w ON w.id=l.work_item_id WHERE l.mission_id=?").all(missionId) as
    Array<{ run_id: string; created_at_ms: number; title: string; assignment_json: string | null }>) {
    const memberId = memberOf(row.assignment_json);
    runs.set(row.run_id, { startedMs: row.created_at_ms, title: row.title, ...(memberId ? { memberId } : {}), coordinator: false });
  }
  for (const row of db.prepare("SELECT run_id, created_at_ms FROM mission_runs WHERE mission_id=?").all(missionId) as Array<{ run_id: string; created_at_ms: number }>) {
    if (!runs.has(row.run_id)) runs.set(row.run_id, { startedMs: row.created_at_ms, ...(mission.coordinator ? { memberId: mission.coordinator } : {}), coordinator: true });
  }
  const runIds = [...runs.keys()];
  const jobs = runIds.length === 0 ? [] : store.control.prepare(`SELECT id, workflow_run_id AS runId FROM jobs WHERE organization_id=? AND workspace_id=? AND workflow_run_id IN (${marks(runIds)}) ORDER BY created_at_ms, rowid`)
    .all(organizationId, workspaceId, ...runIds) as Array<{ id: string; runId: string }>;
  const firstJob = new Map<string, string>();
  const runOfJob = new Map<string, string>();
  for (const job of jobs) { if (!firstJob.has(job.runId)) firstJob.set(job.runId, job.id); runOfJob.set(job.id, job.runId); }
  const runState = new Map((runIds.length === 0 ? [] : db.prepare(`SELECT id, state FROM workflow_runs WHERE id IN (${marks(runIds)})`).all(...runIds) as Array<{ id: string; state: string }>).map((row) => [row.id, row.state]));
  const calls = new Map<string, number>();
  if (runIds.length > 0) for (const row of store.control.prepare(`SELECT run_id AS runId, COUNT(*) AS n FROM tool_calls WHERE organization_id=? AND workspace_id=? AND run_id IN (${marks(runIds)}) GROUP BY run_id`).all(organizationId, workspaceId, ...runIds) as Array<{ runId: string; n: number }>) calls.set(row.runId, row.n);
  const sourceOfRun = (runId: string): MissionTimelineEntry["source"] => ({ kind: "run", id: runId, ...(firstJob.has(runId) ? { jobId: firstJob.get(runId)! } : {}) });
  for (const [runId, run] of runs) {
    add("run", run.startedMs, runId, { event: run.coordinator ? "run.coordinator" : "run.started", ...(run.title ? { subject: clip(run.title) } : {}), ...(runState.has(runId) ? { outcome: runState.get(runId)! } : {}),
      ...(calls.has(runId) ? { toolCalls: calls.get(runId)! } : {}), ...(run.memberId ? { memberId: run.memberId } : {}), source: sourceOfRun(runId) });
  }

  // Independent checks of a task's run, and the mission's own sign-off.
  for (const runId of runIds) {
    for (const row of db.prepare(`SELECT v.id, v.outcome, COALESCE(v.finalized_at_ms, v.created_at_ms) AS at FROM verification_verdicts v JOIN evidence_bundles b ON b.digest=v.bundle_digest
      WHERE json_extract(b.manifest_json,'$.workflowRunId')=?`).all(runId) as Array<{ id: string; outcome: string; at: number }>) {
      const run = runs.get(runId)!;
      add("verdict", row.at, row.id, { event: "verdict.task", ...(run.title ? { subject: clip(run.title) } : {}), outcome: row.outcome, ...(run.memberId ? { memberId: run.memberId } : {}), source: sourceOfRun(runId) });
    }
  }
  const mine = { kind: "mission" as const, id: missionId };
  for (const row of db.prepare("SELECT digest, state, verdict_by, created_at_ms FROM mission_evidence_bundles WHERE mission_id=?").all(missionId) as Array<{ digest: string; state: string; verdict_by: string | null; created_at_ms: number }>) {
    add("verdict", row.created_at_ms, `${row.digest}:0`, { event: "verdict.submitted", source: mine });
    const recorded = db.prepare("SELECT created_at_ms FROM events WHERE event_type='mission.verdictRecorded' AND aggregate_type='mission' AND aggregate_id=? AND json_extract(payload_json,'$.digest')=? ORDER BY cursor DESC LIMIT 1").get(missionId, row.digest) as { created_at_ms: number } | undefined;
    if (recorded && (row.state === "verified" || row.state === "rejected")) add("verdict", recorded.created_at_ms, `${row.digest}:1`, { event: "verdict.mission", outcome: row.state, ...(row.verdict_by ? { actorId: row.verdict_by } : {}), source: mine });
  }

  for (const row of db.prepare(`SELECT v.id, v.state, v.verified, v.created_at_ms, v.work_item_id, o.id AS output_id, o.name, w.assignment_json FROM output_versions v JOIN mission_outputs o ON o.id=v.output_id
    LEFT JOIN work_items w ON w.id=v.work_item_id WHERE o.mission_id=?`).all(missionId) as Array<{ id: string; state: string; verified: number; created_at_ms: number; output_id: string; name: string; assignment_json: string | null }>) {
    const memberId = memberOf(row.assignment_json);
    add("output", row.created_at_ms, row.id, { event: "output.recorded", subject: clip(row.name), outcome: row.verified === 1 ? "verified" : row.state, ...(memberId ? { memberId } : {}), source: { kind: "output", id: row.output_id } });
  }

  // Effects an agent proposed on this mission's runs: the request, each person's decision, and what became of the change.
  const jobIds = jobs.map((job) => job.id);
  const effects = jobIds.length === 0 ? [] : store.control.prepare(`SELECT e.approval_id AS approvalId, e.parent_job_id AS jobId, e.outcome, e.settled_at_ms AS settledAt, a.state, a.created_at_ms AS createdAt, a.expires_at_ms AS expiresAt, a.subject_json AS subject
    FROM effect_calls e JOIN approval_requests a ON a.id=e.approval_id WHERE e.organization_id=? AND e.workspace_id=? AND e.parent_job_id IN (${marks(jobIds)})`)
    .all(organizationId, workspaceId, ...jobIds) as Array<{ approvalId: string; jobId: string; outcome: string | null; settledAt: number | null; state: string; createdAt: number; expiresAt: number; subject: string }>;
  for (const effect of effects) {
    const runId = runOfJob.get(effect.jobId);
    const memberId = runId ? runs.get(runId)?.memberId : undefined;
    const summary = effectSummary(effect.subject);
    const base = { ...(summary ? { subject: clip(summary) } : {}), ...(memberId ? { memberId } : {}), source: { kind: "approval" as const, id: effect.approvalId } };
    add("approval", effect.createdAt, `${effect.approvalId}:0`, { event: "approval.requested", ...base });
    for (const decision of store.control.prepare("SELECT id, decision, actor_id, created_at_ms FROM approval_decisions WHERE approval_id=? ORDER BY created_at_ms, rowid").all(effect.approvalId) as Array<{ id: string; decision: string; actor_id: string; created_at_ms: number }>) {
      add("approval", decision.created_at_ms, `${effect.approvalId}:d:${decision.id}`, { event: "approval.decided", outcome: decision.decision, actorId: decision.actor_id, ...base });
    }
    if (effect.state === "expired") add("approval", effect.expiresAt, `${effect.approvalId}:x`, { event: "approval.expired", ...base });
    if (effect.settledAt !== null && effect.outcome) add("effect", effect.settledAt, `${effect.approvalId}:e`, { event: "effect.settled", outcome: effect.outcome, ...base });
  }

  entries.sort((left, right) => left.atMs - right.atMs || RANK[left.kind] - RANK[right.kind] || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const kept = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  // Everyone a person may filter by: the plan's team, the coordinator and anyone an entry names.
  const members = new Set([...roles.keys(), ...(mission.coordinator ? [mission.coordinator] : []), ...kept.flatMap((entry) => (entry.memberId ? [entry.memberId] : []))]);
  return {
    missionId,
    items: kept.map(({ atMs, key, ...entry }) => ({ entryId: `${entry.kind}:${key}`, at: iso(atMs), ...entry })),
    members: [...members].sort().map((memberId) => ({ memberId, role: roles.get(memberId) ?? memberId })),
    truncated: entries.length > kept.length,
  };
}

/** The sentence an effect approval carries about the change, as the person who decides it reads it. */
function effectSummary(subjectJson: string): string | undefined {
  try {
    const summary = (JSON.parse(subjectJson) as { effectBounds?: { summary?: unknown } }).effectBounds?.summary;
    return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
  } catch { return undefined; }
}
