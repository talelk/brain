import type { ActorContext, JsonValue, NotificationEntry } from "@brain/contracts";
import type { Store } from "../../application/store";
import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import { hasWorkspaceMembership, requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { attentionItems } from "../stream/index";

/** One notification per mission per recipient in this window; approvals notify immediately elsewhere (#40). */
const MISSION_WINDOW_MS = 15 * 60_000;

export type PushSender = (organizationId: string, principalId: string, payload: { title: string; body: string; url?: string }) => Promise<number>;

/**
 * Notifies the people a mission's attention items concern — its starter and
 * its watchers, while they still have workspace access — once per item, at
 * most once per mission every 15 minutes. Every notification lands in the
 * in-app inbox; push goes out only to subscribed browsers. Progress never
 * notifies: only attention items do (blocking ones, and result-ready, ADR 0005).
 */
export function notifyAttention(store: Store, push: PushSender | undefined): number {
  let sent = 0;
  const workspaces = store.control.prepare("SELECT id, organization_id FROM workspaces WHERE status='active'").all() as Array<{ id: string; organization_id: string }>;
  for (const ws of workspaces) {
    const db = store.workspaceDb(ws.id, ws.organization_id);
    for (const item of attentionItems(store, ws.organization_id, [ws.id])) {
      if (item.kind === "approval" || !item.missionId) continue;
      const owner = db.prepare("SELECT owner_id FROM missions WHERE id=?").get(item.missionId) as { owner_id: string } | undefined;
      const watchers = (db.prepare("SELECT principal_id FROM mission_watchers WHERE mission_id=?").all(item.missionId) as Array<{ principal_id: string }>).map((row) => row.principal_id);
      for (const principalId of new Set([...(owner ? [owner.owner_id] : []), ...watchers])) {
        if (!hasWorkspaceMembership(store, principalId, ws.organization_id, ws.id)) continue;
        if (db.prepare("SELECT 1 FROM attention_notifications WHERE principal_id=? AND item_id=?").get(principalId, item.id)) continue;
        // Good news never delays a decision: only result-ready items count against result-ready.
        const recent = db.prepare(`SELECT 1 FROM attention_notifications WHERE principal_id=? AND mission_id=? AND sent_at_ms>?${item.kind === "result-ready" ? "" : " AND item_id NOT LIKE 'result:%'"}`).get(principalId, item.missionId, store.now() - MISSION_WINDOW_MS);
        if (recent) continue;
        const pushed = Boolean(push);
        db.prepare("INSERT INTO attention_notifications(principal_id,item_id,mission_id,title,pushed,sent_at_ms) VALUES (?,?,?,?,?,?)").run(principalId, item.id, item.missionId, item.title, pushed ? 1 : 0, store.now());
        if (push) void push(ws.organization_id, principalId, { title: item.title, body: item.detail ?? (item.kind === "result-ready" ? "A result is ready." : "A mission needs you."), url: `/missions/${item.missionId}/live?w=${item.workspaceId}` }).catch(() => undefined);
        sent++;
      }
    }
  }
  return sent;
}

/** The user's notification history across the workspaces they can still read. */
export function notificationsFor(store: Store, actor: ActorContext, workspaceIds: readonly string[], limit: number): JsonValue {
  const items: NotificationEntry[] = [];
  for (const workspaceId of new Set(workspaceIds)) {
    const db = store.workspaceDb(workspaceId, actor.organizationId);
    for (const row of db.prepare("SELECT item_id, mission_id, title, pushed, sent_at_ms FROM attention_notifications WHERE principal_id=? ORDER BY sent_at_ms DESC LIMIT ?").all(actor.actorId, limit) as Array<{ item_id: string; mission_id: string | null; title: string; pushed: number; sent_at_ms: number }>) {
      items.push({ itemId: row.item_id, workspaceId, ...(row.mission_id ? { missionId: row.mission_id } : {}), title: row.title, sentAt: iso(row.sent_at_ms), pushed: row.pushed === 1 });
    }
  }
  return { items: items.sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, limit) } as unknown as JsonValue;
}

/** mission.watch: a person chooses to follow (or stop following) a mission's attention items. */
export function watchCommands(store: Store): CommandHandlers {
  return handlersFor(["mission.watch"], {
    kind: "workspace",
    handle: ({ actor, cmd, workspaceId }) => {
      requireWorkspaceRead(store, actor, workspaceId);
      const db = store.workspaceDb(workspaceId, actor.organizationId);
      const missionId = String(cmd.payload["missionId"]);
      if (!db.prepare("SELECT 1 FROM missions WHERE id=?").get(missionId)) throw new BrainDomainError("NOT_FOUND", "mission not found");
      if (cmd.payload["watch"] === true) db.prepare("INSERT OR IGNORE INTO mission_watchers(principal_id,mission_id,created_at_ms) VALUES (?,?,?)").run(actor.actorId, missionId, store.now());
      else db.prepare("DELETE FROM mission_watchers WHERE principal_id=? AND mission_id=?").run(actor.actorId, missionId);
      return { resourceId: missionId };
    },
  });
}
