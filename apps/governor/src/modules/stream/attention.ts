import type { ActorContext, AttentionItem, JsonValue, SinceLastVisitSummary } from "@brain/contracts";
import type { Store } from "../../application/store";
import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import { requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";

type Db = ReturnType<Store["workspaceDb"]>;

/** Result-ready items (ADR 0005) are derived for this long after the mission closed or the task reached Done. */
export const RESULT_READY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Attention items (#40): what needs a human, derived from current state and
 * never stored. Fixed tiers — approvals (nearest expiry first), stopped
 * missions, plan proposals and parked work, verdicts ready to close, routed
 * findings, then the non-blocking result-ready items (ADR 0005) — then the
 * longest wait first. No model ranks anything.
 */
export function attentionItems(store: Store, organizationId: string, workspaceIds: readonly string[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const workspaceId of new Set(workspaceIds)) {
    for (const row of store.control.prepare("SELECT id, created_at_ms, expires_at_ms FROM approval_requests WHERE organization_id=? AND workspace_id=? AND state='pending'").all(organizationId, workspaceId) as Array<{ id: string; created_at_ms: number; expires_at_ms: number }>) {
      items.push({ id: `approval:${row.id}`, workspaceId, kind: "approval", tier: 1, title: "Approval awaiting review", resourceId: row.id, waitingSince: iso(row.created_at_ms), expiresAt: iso(row.expires_at_ms) });
    }
    const db = store.workspaceDb(workspaceId, organizationId);
    for (const m of db.prepare("SELECT id, title, state, pause_reason, updated_at_ms FROM missions WHERE state!='closed'").all() as Array<{ id: string; title: string; state: string; pause_reason: string | null; updated_at_ms: number }>) {
      if (m.state === "paused" && m.pause_reason === "budget") items.push({ id: `budget:${m.id}`, workspaceId, missionId: m.id, kind: "budget-pause", tier: 2, title: `${m.title} is paused: budget exhausted`, resourceId: m.id, waitingSince: iso(m.updated_at_ms) });
      if (m.state === "active" && needsAttention(db, m.id)) items.push({ id: `stuck:${m.id}`, workspaceId, missionId: m.id, kind: "needs-attention", tier: 2, title: `${m.title} needs attention: all remaining work is parked`, resourceId: m.id, waitingSince: iso(m.updated_at_ms) });
      const latest = db.prepare("SELECT bundle.state, bundle.created_at_ms FROM mission_evidence_bundles bundle WHERE mission_id=? ORDER BY created_at_ms DESC LIMIT 1").get(m.id) as { state: string; created_at_ms: number } | undefined;
      if (m.state === "verifying" && latest?.state === "verified") items.push({ id: `verdict:${m.id}`, workspaceId, missionId: m.id, kind: "verdict-ready", tier: 4, title: `${m.title} is verified and ready to close`, resourceId: m.id, waitingSince: iso(latest.created_at_ms) });
    }
    for (const row of db.prepare(`SELECT p.id, p.mission_id, p.created_at_ms, m.title FROM plan_versions p JOIN missions m ON m.id=p.mission_id
      WHERE p.state='proposed' AND m.state!='closed' AND p.revision=(SELECT MAX(revision) FROM plan_versions q WHERE q.mission_id=p.mission_id)`).all() as Array<{ id: string; mission_id: string; created_at_ms: number; title: string }>) {
      items.push({ id: `proposal:${row.id}`, workspaceId, missionId: row.mission_id, kind: "plan-proposal", tier: 3, title: `Plan proposal for ${row.title}`, resourceId: row.id, waitingSince: iso(row.created_at_ms) });
    }
    for (const row of db.prepare(`SELECT w.id, w.mission_id, w.title, w.updated_at_ms, w.parked_diagnostic,
      (SELECT COUNT(*) FROM work_item_dependencies d JOIN work_items x ON x.id=d.work_item_id WHERE d.depends_on_work_item_id=w.id AND x.state NOT IN ('done','abandoned')) AS waiting
      FROM work_items w JOIN missions m ON m.id=w.mission_id WHERE w.parked=1 AND m.state!='closed'`).all() as Array<{ id: string; mission_id: string; title: string; updated_at_ms: number; parked_diagnostic: string | null; waiting: number }>) {
      items.push({ id: `parked:${row.id}`, workspaceId, missionId: row.mission_id, kind: "parked", tier: 3, title: `${row.title} is parked`, ...(row.parked_diagnostic ? { detail: `${row.parked_diagnostic}${row.waiting ? ` · ${row.waiting} dependent(s) waiting` : ""}`.slice(0, 1024) } : {}), resourceId: row.id, waitingSince: iso(row.updated_at_ms) });
    }
    for (const row of db.prepare(`SELECT msg.id, msg.mission_id, msg.body, msg.created_at_ms FROM mission_messages msg JOIN missions m ON m.id=msg.mission_id
      WHERE msg.sender_id='governor' AND msg.delivery='pending' AND m.state!='closed'`).all() as Array<{ id: string; mission_id: string; body: string; created_at_ms: number }>) {
      items.push({ id: `routed:${row.id}`, workspaceId, missionId: row.mission_id, kind: "routed", tier: 5, title: "Findings routed to the mission", detail: row.body.slice(0, 1024), resourceId: row.id, waitingSince: iso(row.created_at_ms) });
    }
    const since = store.now() - RESULT_READY_WINDOW_MS;
    for (const row of db.prepare("SELECT id, title, updated_at_ms FROM missions WHERE state='closed' AND outcome='achieved' AND updated_at_ms>?").all(since) as Array<{ id: string; title: string; updated_at_ms: number }>) {
      items.push({ id: `result:${row.id}`, workspaceId, missionId: row.id, kind: "result-ready", tier: 6, title: `Result ready: ${row.title}`, resourceId: row.id, waitingSince: iso(row.updated_at_ms) });
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
  "mission.stateChanged": (payload) => `Mission is now ${String(payload["missionState"])}`,
  "output.versionRecorded": () => "Output version recorded",
  "mission.briefChanged": (payload) => `Brief updated to version ${String(payload["briefVersion"])}`,
  "mission.budgetChanged": () => "Budget changed",
  "mission.verdictRecorded": () => "Mission verdict recorded",
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
  if (queryType === "attention.list") return { items: attentionItems(store, actor.organizationId, workspaceIds) } as unknown as JsonValue;
  if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
  requireWorkspaceRead(store, actor, workspaceId);
  return sinceLastVisit(store.workspaceDb(workspaceId, actor.organizationId), actor.actorId, String(resourceId)) as unknown as JsonValue;
}
