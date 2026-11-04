import type { JsonValue } from "@brain/contracts";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";

/** search.global helper: sessions whose id, task, agent or state match. */
export function searchSessions(
  store: Store,
  organizationId: string,
  workspaceId: string,
  matches: (value: unknown) => boolean,
): Array<Record<string, JsonValue>> {
  const ws = store.workspaceDb(workspaceId, organizationId);
  const sessions = ws.prepare("SELECT id, task, agent_id, state, updated_at_ms FROM sessions ORDER BY updated_at_ms DESC, id LIMIT 100").all() as Array<{ id: string; task: string; agent_id: string; state: string; updated_at_ms: number }>;
  const results: Array<Record<string, JsonValue>> = [];
  for (const session of sessions) {
    if (matches(session.id) || matches(session.task) || matches(session.agent_id) || matches(session.state)) {
      results.push({ category: "session", title: session.task ? session.task.slice(0, 80) : `Session ${session.id}`, reason: `${session.state} · ${session.agent_id || "agent"}`, resourceId: session.id, workspaceId, updatedAt: iso(session.updated_at_ms) });
    }
  }
  return results;
}
