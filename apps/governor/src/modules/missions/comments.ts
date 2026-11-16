import type { MissionMessage, WorkItemComment } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { sendMessage } from "./outputs";

type Db = ReturnType<Store["workspaceDb"]>;
type CommentRow = { id: string; work_item_id: string; actor_id: string; body: string; correction_of: string | null; message_id: string | null; created_at_ms: number };

/**
 * A comment on a work item (#100). A person's comment is also a mission message to the member serving the item, or to the mission when
 * nobody on the team serves it; it is delivered by the sessions module like any other message and, like any message, authorizes nothing.
 * A session's own comment is only part of the thread.
 */
export function recordComment(store: Store, db: Db, input: {
  workItemId: string; missionId: string; authorId: string; text: string; correctionOf?: string;
  serving: string | undefined; team: readonly string[]; send: boolean;
}): { commentId: string; messageId?: string } {
  const prior = input.correctionOf ? db.prepare("SELECT * FROM work_item_comments WHERE id=?").get(input.correctionOf) as CommentRow | undefined : undefined;
  if (input.correctionOf) {
    if (!prior || prior.work_item_id !== input.workItemId) throw new BrainDomainError("NOT_FOUND", "the comment to correct is not on this work item");
    if (prior.actor_id !== input.authorId) throw new BrainDomainError("FORBIDDEN", "only the author can correct a comment");
    if (db.prepare("SELECT 1 FROM work_item_comments WHERE correction_of=?").get(prior.id)) throw new BrainDomainError("CONFLICT", "this comment was already corrected; correct the latest one");
  }
  const commentId = store.id("comment");
  return store.inTx(db, () => {
    let messageId: string | undefined;
    if (input.send) {
      const member = input.serving && input.team.includes(input.serving) ? input.serving : undefined;
      // An undelivered message is superseded by its correction; one a session already received is followed by a new message.
      const pending = prior?.message_id ? db.prepare("SELECT 1 FROM mission_messages WHERE id=? AND delivery='pending'").get(prior.message_id) : undefined;
      messageId = sendMessage(store, db, {
        missionId: input.missionId, senderId: input.authorId, recipient: member ? { kind: "member", memberId: member } : { kind: "mission" },
        body: input.text, workItemId: input.workItemId, team: input.team, ...(pending && prior?.message_id ? { correctionOf: prior.message_id } : {}),
      });
    }
    db.prepare("INSERT INTO work_item_comments(id,work_item_id,actor_id,body,correction_of,message_id,created_at_ms) VALUES (?,?,?,?,?,?,?)")
      .run(commentId, input.workItemId, input.authorId, input.text, input.correctionOf ?? null, messageId ?? null, store.now());
    // A session's comment sends nothing to anyone; the event is what puts it on the record under the session's own actor (ADR 0032).
    store.emit(db, { aggregateType: "workItem", aggregateId: input.workItemId, eventType: "workItem.commented", payload: { missionId: input.missionId, workItemId: input.workItemId, commentId } });
    return { commentId, ...(messageId ? { messageId } : {}) };
  });
}

/** The thread of one work item, oldest first: who said what, when, whether it corrects an earlier comment, and where its message to the team stands. */
export function listComments(store: Store, db: Db, organizationId: string, workItemId: string, limit: number): WorkItemComment[] {
  const rows = db.prepare(`SELECT * FROM (SELECT * FROM work_item_comments WHERE work_item_id=? ORDER BY created_at_ms DESC, id DESC LIMIT ?) ORDER BY created_at_ms, id`).all(workItemId, limit) as CommentRow[];
  const messages = db.prepare("SELECT delivery, recipient_kind, recipient_member_id FROM mission_messages WHERE id=?");
  const kinds = new Map<string, "human" | "agent">();
  const kindOf = (authorId: string): "human" | "agent" => {
    if (!kinds.has(authorId)) {
      const principal = store.control.prepare("SELECT kind FROM principals WHERE id=? AND organization_id=?").get(authorId, organizationId) as { kind: string } | undefined;
      kinds.set(authorId, principal?.kind === "agent" ? "agent" : "human");
    }
    return kinds.get(authorId)!;
  };
  return rows.map((row): WorkItemComment => {
    const message = row.message_id ? messages.get(row.message_id) as { delivery: MissionMessage["delivery"]; recipient_kind: "mission" | "member"; recipient_member_id: string | null } | undefined : undefined;
    return {
      commentId: row.id, workItemId: row.work_item_id, authorId: row.actor_id, authorKind: kindOf(row.actor_id), text: row.body,
      ...(row.correction_of ? { correctionOf: row.correction_of } : {}),
      ...(message ? { delivery: message.delivery, recipient: { kind: message.recipient_kind, ...(message.recipient_member_id ? { memberId: message.recipient_member_id } : {}) } } : {}),
      createdAt: iso(row.created_at_ms),
    };
  });
}
