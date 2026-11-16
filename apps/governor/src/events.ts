import { AUDIT_GENESIS, auditChainDigest, payloadDigest, type Actor, type AuditEvent, type JsonValue } from "@brain/contracts";
import type { Db } from "./db";

/** The one actor of work the Governor does on its own (startup, timers). */
export const SYSTEM: Actor = { kind: "system", id: "governor" };

export interface EventInput {
  readonly type: string;
  readonly workspaceId?: string | null;
  /** What the event is about, as `<kind>:<id>`. */
  readonly subject: string;
  readonly payload: JsonValue;
  readonly actor: Actor;
}

/**
 * Records one event at the end of the audit chain. Every state change calls this inside the transaction that makes the change, so the
 * head is read and extended atomically: two events never share a position and a rolled-back change leaves no event.
 */
export function append(tx: Db, input: EventInput): number {
  if (!tx.inTransaction) throw new Error(`event ${input.type} appended outside a transaction`);
  const head = tx.prepare("SELECT seq, chain_digest AS digest FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; digest: string } | undefined;
  const prevDigest = head?.digest ?? AUDIT_GENESIS;
  const event: Omit<AuditEvent, "chainDigest"> = {
    seq: (head?.seq ?? 0) + 1, type: input.type, workspaceId: input.workspaceId ?? null, subject: input.subject,
    payloadJson: JSON.stringify(input.payload), payloadDigest: payloadDigest(input.payload),
    actorKind: input.actor.kind, actorId: input.actor.id, actorAttemptId: input.actor.attemptId ?? null, createdAtMs: Date.now(), prevDigest,
  };
  tx.prepare("INSERT INTO events(seq, type, workspace_id, subject, payload_json, payload_digest, actor_kind, actor_id, actor_attempt_id, created_at_ms, prev_digest, chain_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(event.seq, event.type, event.workspaceId, event.subject, event.payloadJson, event.payloadDigest, event.actorKind, event.actorId, event.actorAttemptId, event.createdAtMs, prevDigest, auditChainDigest(prevDigest, event));
  if (event.workspaceId) markChanged(tx, event.workspaceId);
  return event.seq;
}

/** Events in chain order, a page at a time. */
export function* readEvents(db: Db, afterSeq = 0): Generator<AuditEvent> {
  for (let after = afterSeq; ;) {
    const page = db.prepare(`SELECT seq, type, workspace_id AS workspaceId, subject, payload_json AS payloadJson, payload_digest AS payloadDigest, actor_kind AS actorKind, actor_id AS actorId,
      actor_attempt_id AS actorAttemptId, created_at_ms AS createdAtMs, prev_digest AS prevDigest, chain_digest AS chainDigest FROM events WHERE seq > ? ORDER BY seq LIMIT 2000`).all(after) as AuditEvent[];
    yield* page;
    const last = page.at(-1);
    if (page.length < 2000 || !last) return;
    after = last.seq;
  }
}

// --- "something changed in this workspace": what `GET /v1/events` tells its clients ---

type Listener = (workspaceIds: ReadonlySet<string>) => void;
const watchers = new WeakMap<Db, { listeners: Set<Listener>; pending: Set<string> }>();
const watcher = (db: Db) => {
  let entry = watchers.get(db);
  if (!entry) watchers.set(db, (entry = { listeners: new Set(), pending: new Set() }));
  return entry;
};

/**
 * Says that a workspace has something new to show. `append` calls it; call it directly for changes that are not audit events (attempt
 * events). Listeners hear about it on a later turn of the event loop, after the transaction that made the change has ended.
 */
export function markChanged(db: Db, workspaceId: string): void {
  const entry = watcher(db);
  if (entry.listeners.size === 0) return;
  if (entry.pending.size === 0) {
    setTimeout(() => {
      const changed = new Set(entry.pending);
      entry.pending.clear();
      for (const listener of entry.listeners) listener(changed);
    }, 20);
  }
  entry.pending.add(workspaceId);
}

/** Hears every change until the returned function is called. */
export function onChanged(db: Db, listener: Listener): () => void {
  const entry = watcher(db);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}
