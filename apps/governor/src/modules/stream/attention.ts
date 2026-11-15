import type { ActorContext, AttentionItem, JsonValue, SinceLastVisitSummary } from "@brain/contracts";
import type { Store } from "../../application/store";
import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import { requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { reachedLimits, PARKED_INTERRUPTED_REASON } from "../missions/index";
import { runContext, unknownJobsForWorkspace } from "../jobs/index";
import { openAttestations } from "../evidence/index";

type Db = ReturnType<Store["workspaceDb"]>;

/** Result-ready items (ADR 0005) are derived for this long after the mission closed or the task reached Done. */
/** A failed scheduled run stays in Needs you for this long unless a later run starts. */
export const SCHEDULE_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const RESULT_READY_WINDOW_MS = 24 * 60 * 60_000;

/** The pending approvals of one workspace, as attention items: what the queue shows and what an approver is notified about. */
export function pendingApprovalItems(store: Store, organizationId: string, workspaceId: string): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of store.control.prepare("SELECT id, created_at_ms, expires_at_ms, subject_json FROM approval_requests WHERE organization_id=? AND workspace_id=? AND state='pending'").all(organizationId, workspaceId) as Array<{ id: string; created_at_ms: number; expires_at_ms: number; subject_json: string }>) {
    // A call an agent proposed (ADR 0024) says in plain words what will happen, so it can be decided from a phone without opening it.
    let summary = "";
    try { const said = (JSON.parse(row.subject_json) as { effectBounds?: { summary?: unknown } }).effectBounds?.summary; if (typeof said === "string") summary = said.slice(0, 160); } catch { /* an unreadable subject keeps the generic title */ }
    items.push({ id: `approval:${row.id}`, workspaceId, kind: "approval", tier: 1, title: summary ? `Approve or decline: ${summary}` : "Approval awaiting review", resourceId: row.id, waitingSince: iso(row.created_at_ms), expiresAt: iso(row.expires_at_ms) });
  }
  return items;
}

/**
 * Attention items (#40): what needs a human, derived from current state and
 * never stored. Fixed tiers — approvals (nearest expiry first), stopped
 * missions, plan proposals, parked work, agents' questions and evaluations waiting for a person (tier 3), verdicts
 * ready to close, routed findings, then the non-blocking result-ready items (ADR 0005) — then the
 * longest wait first. No model ranks anything.
 */
export function attentionItems(store: Store, organizationId: string, workspaceIds: readonly string[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const workspaceId of new Set(workspaceIds)) {
    items.push(...pendingApprovalItems(store, organizationId, workspaceId));
    const db = store.workspaceDb(workspaceId, organizationId);
    // A step left "outcome unknown" that Brain will not settle by itself: a person treats it as failed, or tries again when that is harmless.
    for (const job of unknownJobsForWorkspace(store, organizationId, workspaceId)) {
      const context = runContext(db, job.runId);
      if (context?.resolution) continue; // settled by a later attempt or a closed mission: history, same rule as the Runs view
      const link = context ? { mission_id: context.missionId, title: context.workItemTitle } : undefined;
      items.push({ id: `unknown:${job.jobId}`, workspaceId, ...(link ? { missionId: link.mission_id } : {}), kind: "outcome-unknown", tier: 2,
        title: link ? `${link.title} may not have finished: check before going on` : "A step may not have finished: check before going on",
        detail: job.reason, resourceId: job.jobId, waitingSince: iso(job.since), safeToRetry: job.idempotent, version: job.version });
    }
    // Only missions with parked open work can be stuck, and only verifying ones have a verdict to close: a workspace keeps every mission
    // it ever ran, so the per-mission lookups below must not run for the common mission (steady benchmark, growth across trials).
    const withParked = new Set((db.prepare("SELECT DISTINCT mission_id FROM work_items WHERE parked=1 AND state NOT IN ('done','abandoned')").all() as Array<{ mission_id: string }>).map((row) => row.mission_id));
    for (const m of db.prepare("SELECT id, title, state, pause_reason, stop_note, updated_at_ms FROM missions WHERE state!='closed'").all() as Array<{ id: string; title: string; state: string; pause_reason: string | null; stop_note: string | null; updated_at_ms: number }>) {
      // An administrator stopped every session (ADR 0047): the mission waits for a person to resume it, and says why.
      if (m.state === "paused" && m.stop_note) items.push({ id: `stopped:${m.id}`, workspaceId, missionId: m.id, kind: "needs-attention", tier: 2, title: `${m.title} was paused: all sessions were stopped`, detail: m.stop_note.slice(0, 1024), resourceId: m.id, waitingSince: iso(m.updated_at_ms) });
      if (m.state === "paused" && m.pause_reason === "budget") {
        const limits = reachedLimits(store, db, m.id);
        const wording = limits.length === 0 ? "a limit was reached" : `${limits.join(" and ")} ${limits.length === 1 && limits[0] !== "workspace cap" ? "limit" : "limits"} reached`;
        items.push({ id: `budget:${m.id}`, workspaceId, missionId: m.id, kind: "budget-pause", tier: 2, title: `${m.title} is paused: ${wording}`, ...(limits.length ? { limits } : {}), resourceId: m.id, waitingSince: iso(m.updated_at_ms) });
      }
      if (m.state === "active" && withParked.has(m.id) && needsAttention(db, m.id)) items.push({ id: `stuck:${m.id}`, workspaceId, missionId: m.id, kind: "needs-attention", tier: 2, title: `${m.title} needs attention: all remaining work is parked`, resourceId: m.id, waitingSince: iso(m.updated_at_ms) });
      const latest = m.state !== "verifying" ? undefined : db.prepare("SELECT digest, state, created_at_ms FROM mission_evidence_bundles WHERE mission_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(m.id) as { digest: string; state: string; created_at_ms: number } | undefined;
      // A submitted bundle waits for a person's verdict; the id carries the bundle, so a rejected and resubmitted mission notifies again.
      if (latest?.state === "submitted") items.push({ id: `signoff:${latest.digest}`, workspaceId, missionId: m.id, kind: "sign-off", tier: 4, title: `${m.title} is ready for sign-off`, resourceId: m.id, waitingSince: iso(latest.created_at_ms) });
      if (latest?.state === "verified") items.push({ id: `verdict:${m.id}`, workspaceId, missionId: m.id, kind: "verdict-ready", tier: 4, title: `${m.title} is verified and ready to close`, resourceId: m.id, waitingSince: iso(latest.created_at_ms) });
    }
    for (const row of db.prepare(`SELECT p.id, p.mission_id, p.created_at_ms, m.title FROM plan_versions p JOIN missions m ON m.id=p.mission_id
      WHERE p.state='proposed' AND m.state!='closed' AND p.revision=(SELECT MAX(revision) FROM plan_versions q WHERE q.mission_id=p.mission_id)`).all() as Array<{ id: string; mission_id: string; created_at_ms: number; title: string }>) {
      // A plan a schedule did not confirm by itself says why (ADR 0017); the reason is the plan's own event, so nothing extra is stored.
      const held = db.prepare("SELECT payload_json FROM events WHERE event_type='plan.heldBySchedule' AND aggregate_id=? ORDER BY cursor DESC LIMIT 1").get(row.id) as { payload_json: string } | undefined;
      const reason = held ? (JSON.parse(held.payload_json) as { reason?: string }).reason : undefined;
      items.push({ id: `proposal:${row.id}`, workspaceId, missionId: row.mission_id, kind: "plan-proposal", tier: 3,
        title: reason ? `${row.title} needs your OK: ${reason}` : `Plan proposal for ${row.title}`,
        ...(reason ? { detail: "The schedule starts this run only after you confirm the plan." } : {}), resourceId: row.id, waitingSince: iso(row.created_at_ms) });
    }
    // A schedule whose latest run failed, or whose mission ended without reaching its goal, until a later run starts or succeeds (self-clearing).
    for (const row of db.prepare(`SELECT a.id, a.title, o.state, o.detail, o.dispatch_ref, COALESCE(o.fired_at_ms, o.planned_at_ms) AS at_ms FROM automations a
      JOIN automation_occurrences o ON o.id=(SELECT x.id FROM automation_occurrences x WHERE x.automation_id=a.id AND x.state IN ('dispatched','failed') ORDER BY x.planned_at_ms DESC, x.id DESC LIMIT 1)
      WHERE a.state='active' AND COALESCE(o.fired_at_ms, o.planned_at_ms)>?`).all(store.now() - SCHEDULE_FAILURE_WINDOW_MS) as Array<{ id: string; title: string; state: string; detail: string | null; dispatch_ref: string | null; at_ms: number }>) {
      if (row.state === "failed") {
        items.push({ id: `schedule:${row.id}`, workspaceId, kind: "schedule-failed", tier: 2, title: `${row.title} could not start its latest run`, ...(row.detail ? { detail: row.detail.slice(0, 1024) } : {}), resourceId: row.id, waitingSince: iso(row.at_ms) });
        continue;
      }
      const ended = row.dispatch_ref ? db.prepare("SELECT id, title FROM missions WHERE id=? AND state='closed' AND outcome='ended'").get(row.dispatch_ref) as { id: string; title: string } | undefined : undefined;
      if (ended) items.push({ id: `schedule:${row.id}`, workspaceId, missionId: ended.id, kind: "schedule-failed", tier: 2, title: `${ended.title} ended without reaching its goal`, detail: "Its schedule keeps running; open the mission to see why.", resourceId: row.id, waitingSince: iso(row.at_ms) });
    }
    // A question a session asked a person stays blocking until an answer exists (ADR 0050); nothing about it is stored but the question and its answer.
    for (const row of db.prepare(`SELECT q.id, q.mission_id, q.member_id, q.body, q.created_at_ms, m.title, m.active_plan_version_id FROM mission_questions q JOIN missions m ON m.id=q.mission_id
      WHERE m.state!='closed' AND NOT EXISTS (SELECT 1 FROM mission_messages a WHERE a.answers_question_id=q.id)`).all() as Array<{ id: string; mission_id: string; member_id: string; body: string; created_at_ms: number; title: string; active_plan_version_id: string | null }>) {
      const team = row.active_plan_version_id ? (db.prepare("SELECT team_json FROM plan_versions WHERE id=?").get(row.active_plan_version_id) as { team_json: string } | undefined) : undefined;
      const role = (team ? (JSON.parse(team.team_json) as Array<{ memberId: string; role: string }>) : []).find((member) => member.memberId === row.member_id)?.role ?? row.member_id;
      items.push({ id: `question:${row.id}`, workspaceId, missionId: row.mission_id, memberId: row.member_id, kind: "question", tier: 3, title: `${role} asks a question on ${row.title}`, detail: row.body.slice(0, 1024), resourceId: row.id, waitingSince: iso(row.created_at_ms) });
    }
    // An evaluation that needs a person to be its independent evaluator (ADR 0069) blocks its run until one records a verdict.
    for (const open of openAttestations(store, db, organizationId, workspaceId)) {
      items.push({ id: `attestation:${open.id}`, workspaceId, ...(open.missionId ? { missionId: open.missionId } : {}), kind: "attestation", tier: 3, title: `Attest the evidence for ${open.title}`.slice(0, 256),
        detail: "Someone who did not start this work must review its evidence and record a verdict.", resourceId: open.id, waitingSince: iso(open.createdAtMs) });
    }
    for (const row of db.prepare(`SELECT w.id, w.mission_id, w.title, w.updated_at_ms, w.parked_diagnostic, w.blocked_reason,
      (SELECT COUNT(*) FROM work_item_dependencies d JOIN work_items x ON x.id=d.work_item_id WHERE d.depends_on_work_item_id=w.id AND x.state NOT IN ('done','abandoned')) AS waiting
      FROM work_items w JOIN missions m ON m.id=w.mission_id WHERE w.parked=1 AND w.state NOT IN ('done','abandoned') AND m.state!='closed'`).all() as Array<{ id: string; mission_id: string; title: string; updated_at_ms: number; parked_diagnostic: string | null; blocked_reason: string | null; waiting: number }>) {
      const stopped = row.blocked_reason === PARKED_INTERRUPTED_REASON;
      items.push({ id: `parked:${row.id}`, workspaceId, missionId: row.mission_id, kind: "parked", tier: 3, title: stopped ? `${row.title} stopped: waiting for you to try again` : `${row.title} is parked`, ...(row.parked_diagnostic ? { detail: `${row.parked_diagnostic}${row.waiting ? ` · ${row.waiting} dependent(s) waiting` : ""}`.slice(0, 1024) } : {}), resourceId: row.id, waitingSince: iso(row.updated_at_ms) });
    }
    for (const row of db.prepare(`SELECT msg.id, msg.mission_id, msg.body, msg.created_at_ms FROM mission_messages msg JOIN missions m ON m.id=msg.mission_id
      WHERE msg.sender_id='governor' AND msg.delivery='pending' AND m.state!='closed'`).all() as Array<{ id: string; mission_id: string; body: string; created_at_ms: number }>) {
      items.push({ id: `routed:${row.id}`, workspaceId, missionId: row.mission_id, kind: "routed", tier: 5, title: "Findings routed to the mission", detail: row.body.slice(0, 1024), resourceId: row.id, waitingSince: iso(row.created_at_ms) });
    }
    const since = store.now() - RESULT_READY_WINDOW_MS;
    for (const row of db.prepare("SELECT id, title, updated_at_ms FROM missions WHERE state='closed' AND outcome='achieved' AND updated_at_ms>?").all(since) as Array<{ id: string; title: string; updated_at_ms: number }>) {
      // Once the mission's write-up is in the Library (or waiting in the Review inbox) the announcement links to that item.
      const writeup = db.prepare("SELECT id, state FROM knowledge_assets WHERE mission_id=? AND operation_id='mission-knowledge' AND superseded_by IS NULL AND rejection_reason IS NULL AND state IN ('extracted','published') ORDER BY created_at_ms DESC LIMIT 1").get(row.id) as { id: string; state: string } | undefined;
      items.push({ id: `result:${row.id}`, workspaceId, missionId: row.id, kind: "result-ready", tier: 6, title: `Result ready: ${row.title}`,
        ...(writeup ? { detail: writeup.state === "published" ? "Its write-up is saved to the Library." : "Its write-up is waiting in the Review inbox.", knowledgeAssetId: writeup.id } : {}), resourceId: row.id, waitingSince: iso(row.updated_at_ms) });
    }
    for (const row of db.prepare(`SELECT w.id, w.mission_id, w.title, w.updated_at_ms FROM work_items w JOIN missions m ON m.id=w.mission_id
      WHERE w.state='done' AND m.state!='closed' AND w.updated_at_ms>?`).all(since) as Array<{ id: string; mission_id: string; title: string; updated_at_ms: number }>) {
      items.push({ id: `result:${row.id}`, workspaceId, missionId: row.mission_id, kind: "result-ready", tier: 6, title: `Result ready: ${row.title} is verified and done`, resourceId: row.id, waitingSince: iso(row.updated_at_ms) });
    }
  }
  return items.sort((a, b) => a.tier - b.tier
    || (a.tier === 1 ? (a.expiresAt ?? "").localeCompare(b.expiresAt ?? "") : 0)
    || a.waitingSince.localeCompare(b.waitingSince) || a.id.localeCompare(b.id));
}

/** Every remaining item is parked or waits on parked work: nothing can move without a human. */
function needsAttention(db: Db, missionId: string): boolean {
  const open = db.prepare("SELECT state, parked FROM work_items WHERE mission_id=? AND state NOT IN ('done','abandoned')").all(missionId) as Array<{ state: string; parked: number }>;
  return open.length > 0 && open.some((item) => item.parked === 1) && !open.some((item) => item.parked === 0 && ["ready", "in-progress", "review"].includes(item.state));
}

const NOTABLE: Readonly<Record<string, (payload: Record<string, unknown>, title: (workItemId: string) => string) => string | undefined>> = {
  "workItem.transitioned": (payload, title) => payload["state"] === "done" ? `${title(String(payload["workItemId"]))} verified and done` : undefined,
  "workItem.parked": (payload, title) => `${title(String(payload["workItemId"]))} parked`,
  "plan.proposed": () => "Plan proposal awaiting review",
  "plan.confirmed": () => "Plan version confirmed",
  "plan.autoConfirmed": () => "Coordinator plan version confirmed within the autonomy policy",
  "plan.confirmedBySchedule": (payload) => typeof payload["note"] === "string" ? `Plan ${payload["note"]}` : "Plan confirmed by its schedule",
  "plan.heldBySchedule": (payload) => `Plan held for your OK: ${String(payload["reason"] ?? "the schedule could not confirm it")}`,
  "mission.stateChanged": (payload) => `Mission is now ${String(payload["missionState"])}`,
  "output.versionRecorded": () => "Output version recorded",
  "mission.briefChanged": (payload) => `Brief updated to version ${String(payload["briefVersion"])}`,
  "mission.budgetChanged": (payload) => typeof payload["note"] === "string" ? payload["note"] : "Budget changed",
  "mission.ownerChanged": () => "Mission handed to a new owner",
  "mission.verdictRecorded": () => "Mission verdict recorded",
  "mission.questionAsked": () => "A team member asked you a question",
};

/**
 * The since-last-visit summary (#40): a deterministic digest of one mission's
 * notable events after the user's seen cursor, with everything else counted.
 */
export function sinceLastVisit(db: Db, principalId: string, missionId: string): SinceLastVisitSummary {
  const seen = db.prepare("SELECT cursor FROM mission_seen WHERE principal_id=? AND mission_id=?").get(principalId, missionId) as { cursor: number } | undefined;
  const from = seen?.cursor ?? 0;
  const workItems = new Map((db.prepare("SELECT id, title FROM work_items WHERE mission_id=?").all(missionId) as Array<{ id: string; title: string }>).map((row) => [row.id, row.title]));
  const events = db.prepare(`SELECT cursor, event_type, aggregate_type, aggregate_id, payload_json, created_at_ms FROM events WHERE cursor>? AND (
      json_extract(payload_json,'$.missionId')=? OR (aggregate_type='mission' AND aggregate_id=?)
      OR (aggregate_type='workItem' AND aggregate_id IN (SELECT id FROM work_items WHERE mission_id=?))) ORDER BY cursor LIMIT 2000`)
    .all(from, missionId, missionId, missionId) as Array<{ cursor: number; event_type: string; aggregate_type: string; aggregate_id: string; payload_json: string; created_at_ms: number }>;
  const notable: SinceLastVisitSummary["notable"][number][] = [];
  const otherCounts: Record<string, number> = {};
  let to = from;
  for (const event of events) {
    to = Math.max(to, event.cursor);
    const describe = NOTABLE[event.event_type];
    const summary = describe?.(JSON.parse(event.payload_json) as Record<string, unknown>, (id) => workItems.get(id) ?? id);
    if (summary && notable.length < 200) notable.push({ cursor: event.cursor, eventType: event.event_type, at: iso(event.created_at_ms), summary: summary.slice(0, 512), resourceId: event.aggregate_id });
    else otherCounts[event.event_type] = (otherCounts[event.event_type] ?? 0) + 1;
  }
  return { missionId, fromCursor: from, toCursor: to, notable, otherCounts };
}

/** mission.seen: advances the user's cursor, shared across devices, never backwards. */
export function attentionCommands(store: Store): CommandHandlers {
  return handlersFor(["mission.seen"], {
    kind: "workspace",
    handle: ({ actor, cmd, workspaceId }) => {
      requireWorkspaceRead(store, actor, workspaceId);
      const db = store.workspaceDb(workspaceId, actor.organizationId);
      const missionId = String(cmd.payload["missionId"]);
      if (!db.prepare("SELECT 1 FROM missions WHERE id=?").get(missionId)) throw new BrainDomainError("NOT_FOUND", "mission not found");
      const head = (db.prepare("SELECT COALESCE(MAX(cursor),0) AS c FROM events").get() as { c: number }).c;
      const cursor = Math.min(Number(cmd.payload["cursor"]), head);
      db.prepare(`INSERT INTO mission_seen(principal_id,mission_id,cursor,seen_at_ms) VALUES (?,?,?,?)
        ON CONFLICT(principal_id,mission_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor), seen_at_ms=excluded.seen_at_ms`).run(actor.actorId, missionId, cursor, store.now());
      return { resourceId: missionId };
    },
  });
}

export function attentionQuery(store: Store, actor: ActorContext, queryType: string, workspaceIds: readonly string[], workspaceId: string | undefined, resourceId: string | undefined): JsonValue {
  if (queryType === "attention.list") {
    // A request for one workspace answers for that workspace only; without one it is the organization-wide list.
    if (workspaceId) requireWorkspaceRead(store, actor, workspaceId);
    return { items: attentionItems(store, actor.organizationId, workspaceId ? [workspaceId] : workspaceIds) } as unknown as JsonValue;
  }
  if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
  requireWorkspaceRead(store, actor, workspaceId);
  return sinceLastVisit(store.workspaceDb(workspaceId, actor.organizationId), actor.actorId, String(resourceId)) as unknown as JsonValue;
}
