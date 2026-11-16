import type { AuditEventRecord } from "@brain/contracts";
import type { Db } from "../../infrastructure/persistence/open";

interface Row {
  cursor: number; event_id: string; organization_id: string | null; workspace_id: string | null; aggregate_type: string; aggregate_id: string; aggregate_seq: number;
  event_type: string; payload_json: string; payload_digest: string; created_at_ms: number; actor_id: string; actor_kind: string; actor_attempt_id: string | null; acting_for: string | null;
  chain_seq: number | null; prev_digest: string | null; chain_digest: string | null;
}

const WORKSPACE_COLUMNS = "cursor, event_id, NULL AS organization_id, NULL AS workspace_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms, actor_id, actor_kind, actor_attempt_id, acting_for, chain_seq, prev_digest, chain_digest";
const CONTROL_COLUMNS = "cursor, event_id, organization_id, workspace_id, aggregate_type, aggregate_id, aggregate_seq, event_type, payload_json, payload_digest, created_at_ms, actor_id, actor_kind, actor_attempt_id, acting_for, chain_seq, prev_digest, chain_digest";

const toRecord = (r: Row): AuditEventRecord => ({
  chainSeq: r.chain_seq, cursor: r.cursor, eventId: r.event_id, organizationId: r.organization_id, workspaceId: r.workspace_id, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
  aggregateSeq: r.aggregate_seq, eventType: r.event_type, payloadJson: r.payload_json, payloadDigest: r.payload_digest as AuditEventRecord["payloadDigest"], createdAtMs: r.created_at_ms,
  actorId: r.actor_id, actorKind: r.actor_kind, actorAttemptId: r.actor_attempt_id, actingFor: r.acting_for,
  prevDigest: r.prev_digest as AuditEventRecord["prevDigest"], chainDigest: r.chain_digest as AuditEventRecord["chainDigest"],
});

/** Events in the order they were written (the control chain of one organization when `organizationId` is given, else one workspace database). Never reordered: a reordering is what the verifier looks for. */
export function readEvents(db: Db, organizationId: string | null, afterCursor: number, limit: number): AuditEventRecord[] {
  const rows = organizationId
    ? db.prepare(`SELECT ${CONTROL_COLUMNS} FROM events WHERE organization_id=? AND cursor>? ORDER BY cursor ASC LIMIT ?`).all(organizationId, afterCursor, limit)
    : db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM events WHERE cursor>? ORDER BY cursor ASC LIMIT ?`).all(afterCursor, limit);
  return (rows as Row[]).map(toRecord);
}

/** The newest chained event: its position, digest and cursor. */
export function chainHead(db: Db, organizationId: string | null): { seq: number; digest: string; cursor: number } | undefined {
  const row = (organizationId
    ? db.prepare("SELECT chain_seq AS seq, chain_digest AS digest, cursor FROM events WHERE organization_id=? AND chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1").get(organizationId)
    : db.prepare("SELECT chain_seq AS seq, chain_digest AS digest, cursor FROM events WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1").get()) as { seq: number; digest: string; cursor: number } | undefined;
  return row;
}
