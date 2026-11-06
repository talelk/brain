import type { JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";

/**
 * The session control queue. Controls are keyed by session id; a runner
 * receives them for the attempt the session is bound to. Delivery is
 * at-most-once: a row is deleted when it is handed out, so a lost heartbeat
 * response loses the control. That is acceptable because stop remains
 * reachable through lease expiry and steer is advisory.
 */

export type SessionControlKind = "session.steer" | "session.stop";

/** A control handed to the runner that holds the session's attempt. */
export interface SessionControlDelivery {
  commandId: string;
  type: "stop-attempt" | "steer";
  attemptId?: string;
  text?: string;
}

/** A live attempt of the polling runner, with the workspace it runs in. */
export interface LiveAttempt {
  attemptId: string;
  workspaceId: string;
  organizationId: string;
}

/** Queues a control for an existing session in the workspace; NOT_FOUND otherwise. */
export function enqueueSessionControl(store: Store, input: { organizationId: string; workspaceId: string; sessionId: string; kind: SessionControlKind; payload: JsonValue }): string {
  const db = store.workspaceDb(input.workspaceId, input.organizationId);
  if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(input.sessionId)) {
    throw new BrainDomainError("NOT_FOUND", `session ${input.sessionId} not found in this workspace`);
  }
  const id = store.id("ctl");
  db.prepare("INSERT INTO session_controls(id, session_id, kind, payload, created_at_ms) VALUES (?,?,?,?,?)")
    .run(id, input.sessionId, input.kind, JSON.stringify(input.payload), store.now());
  return id;
}

/**
 * Hands out and deletes the queued controls of the sessions bound to the
 * given attempts, at most `limit` in total, one short transaction per
 * workspace database.
 */
export function drainSessionControls(store: Store, attempts: readonly LiveAttempt[], limit: number): SessionControlDelivery[] {
  const commands: SessionControlDelivery[] = [];
  for (const attempt of attempts) {
    if (commands.length >= limit) break;
    const db = store.workspaceDb(attempt.workspaceId, attempt.organizationId);
    const session = db.prepare("SELECT id FROM sessions WHERE attempt_id=? LIMIT 1").get(attempt.attemptId) as { id: string } | undefined;
    if (!session) continue;
    store.inTx(db, () => {
      const rows = db.prepare("SELECT id, kind, payload FROM session_controls WHERE session_id=? ORDER BY created_at_ms LIMIT ?")
        .all(session.id, limit - commands.length) as Array<{ id: string; kind: string; payload: string }>;
      for (const row of rows) {
        if (row.kind === "session.stop") {
          commands.push({ commandId: row.id, type: "stop-attempt", attemptId: attempt.attemptId });
        } else if (row.kind === "session.steer") {
          let payload: Record<string, unknown> = {};
          try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { payload = {}; }
          commands.push({ commandId: row.id, type: "steer", attemptId: attempt.attemptId, text: String(payload["message"] ?? "") });
        }
        db.prepare("DELETE FROM session_controls WHERE id=?").run(row.id);
      }
    });
  }
  return commands;
}
