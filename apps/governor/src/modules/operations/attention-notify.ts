import type { ActorContext, JsonValue, NotificationEntry } from "@brain/contracts";
import type { Store } from "../../application/store";
import { handlersFor, type CommandHandlers } from "../../application/command-funnel";
import { hasWorkspaceMembership, requireWorkspaceRead } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { attentionItems } from "../stream/index";
import { preferencesOf, webhookTarget } from "./channels";

/** One notification per mission per recipient in this window; approvals notify immediately elsewhere (#40). */
const MISSION_WINDOW_MS = 15 * 60_000;

/** One outbound message: the words and the in-app path it links to. The webhook sends only the kind and the link. */
export interface OutboundMessage { title: string; body: string; url: string; kind: string; count?: number }
/** Which outbound channels the person's preferences allow for this message (in-app is always written). */
export interface Channels { push: boolean; webhook: boolean }
export type Sender = (organizationId: string, principalId: string, message: OutboundMessage, channels: Channels) => Promise<number>;

/** The channels a message may use right now: the person's switches, and a webhook only when the server has one. */
export function channelsFor(store: Store, organizationId: string, principalId: string): Channels {
  const prefs = preferencesOf(store, organizationId, principalId);
  return { push: prefs.push, webhook: prefs.webhook && webhookTarget() !== undefined };
}

/** The only non-urgent kind (ADR 0005): the one a daily digest may batch. Everything else is blocking and goes out at once. */
const batchable = (kind: string): boolean => kind === "result-ready";

/**
 * Notifies the people a mission's attention items concern — its starter and
 * its watchers, while they still have workspace access — once per item, at
 * most once per mission every 15 minutes. Every notification lands in the
 * in-app inbox; push and webhook go out only on the channels the person
 * switched on, and a person on the daily digest gets result-ready items in the
 * digest instead of at once. Progress never notifies: only attention items do
 * (blocking ones, and result-ready, ADR 0005).
 */
export function notifyAttention(store: Store, send: Sender | undefined): number {
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
        const allowed = channelsFor(store, ws.organization_id, principalId);
        const held = batchable(item.kind) && preferencesOf(store, ws.organization_id, principalId).digest;
        const channels: Channels = held ? { push: false, webhook: false } : allowed;
        const pushed = Boolean(send) && (channels.push || channels.webhook);
        db.prepare("INSERT INTO attention_notifications(principal_id,item_id,mission_id,title,pushed,sent_at_ms) VALUES (?,?,?,?,?,?)").run(principalId, item.id, item.missionId, item.title, pushed ? 1 : 0, store.now());
        const url = item.kind === "result-ready" ? `/missions/${item.missionId}/outputs?w=${item.workspaceId}${item.resourceId === item.missionId ? "" : `&result=${item.resourceId}`}` : `/missions/${item.missionId}/live?w=${item.workspaceId}`;
        if (send && pushed) void send(ws.organization_id, principalId, { title: item.title, body: item.detail ?? (item.kind === "result-ready" ? "A result is ready." : "A mission needs you."), url, kind: item.kind }, channels).catch(() => undefined);
        sent++;
      }
    }
  }
  return sent;
}

/** One digest is at most this often. */
export const DIGEST_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * The daily digest (ADR 0011): for each person who switched it on, one message when result-ready items arrived since the last digest
 * and a day has passed. It carries a count and a link to Today, never titles. Blocking items are never held back, so none is here.
 */
export function sendDigests(store: Store, send: Sender): number {
  let sent = 0;
  const rows = store.control.prepare("SELECT organization_id, principal_id, digest_last_ms FROM notification_preferences WHERE digest=1").all() as Array<{ organization_id: string; principal_id: string; digest_last_ms: number }>;
  const now = store.now();
  for (const row of rows) {
    if (now - row.digest_last_ms < DIGEST_INTERVAL_MS) continue;
    const channels = channelsFor(store, row.organization_id, row.principal_id);
    if (!channels.push && !channels.webhook) continue;
    let count = 0;
    let firstWorkspace: string | undefined;
    const memberships = store.control.prepare("SELECT workspace_id FROM workspace_memberships WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL ORDER BY workspace_id").all(row.organization_id, row.principal_id) as Array<{ workspace_id: string }>;
    for (const membership of memberships) {
      const active = store.control.prepare("SELECT 1 FROM workspaces WHERE id=? AND organization_id=? AND status='active'").get(membership.workspace_id, row.organization_id);
      if (!active) continue;
      const n = (store.workspaceDb(membership.workspace_id, row.organization_id).prepare("SELECT COUNT(*) AS n FROM attention_notifications WHERE principal_id=? AND item_id LIKE 'result:%' AND sent_at_ms>?").get(row.principal_id, row.digest_last_ms) as { n: number }).n;
      if (n > 0) { count += n; firstWorkspace ??= membership.workspace_id; }
    }
    if (count === 0 || !firstWorkspace) continue;
    store.control.prepare("UPDATE notification_preferences SET digest_last_ms=? WHERE organization_id=? AND principal_id=?").run(now, row.organization_id, row.principal_id);
    void send(row.organization_id, row.principal_id, { title: "Results are ready", body: `${count} ${count === 1 ? "result is" : "results are"} ready.`, url: `/w/${firstWorkspace}/today`, kind: "digest", count }, channels).catch(() => undefined);
    sent++;
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
