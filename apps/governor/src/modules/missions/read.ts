import type { ActorContext, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { workspaceSummary } from "../operations/read";

/**
 * today: what needs a human across the actor's workspaces — approvals awaiting
 * review and outcomes that must be reconciled before any retry.
 */
export function today(store: Store, actor: ActorContext, workspaceIds: readonly string[], limit: number): JsonValue {
  const items: JsonValue[] = [];
  for (const wsId of workspaceIds.slice(0, 25)) {
    const pending = store.control.prepare("SELECT id FROM approval_requests WHERE organization_id=? AND workspace_id=? AND state='pending' ORDER BY expires_at_ms LIMIT 5").all(actor.organizationId, wsId) as Array<{ id: string }>;
    for (const a of pending) {
      items.push({ id: a.id, workspaceId: wsId, type: "approval", priority: 1, title: "Approval awaiting review", detail: a.id, resourceId: a.id, updatedAt: store.nowIso(), stale: false, nextAction: "review" } as unknown as JsonValue);
    }
    const unknownJobs = store.control.prepare("SELECT id FROM jobs WHERE organization_id=? AND workspace_id=? AND state='outcome_unknown' LIMIT 5").all(actor.organizationId, wsId) as Array<{ id: string }>;
    for (const j of unknownJobs) {
      items.push({ id: j.id, workspaceId: wsId, type: "job", priority: 1, title: "Outcome unknown — reconcile before retry", detail: j.id, resourceId: j.id, updatedAt: store.nowIso(), stale: false, nextAction: "reconcile" } as unknown as JsonValue);
    }
  }
  return { items: items.slice(0, limit) } as unknown as JsonValue;
}

/**
 * bridge: the contract's WorkspaceSummary list — per-workspace counts rendered
 * by the Bridge screen, derived from the same read model workspace.context uses.
 */
export function bridge(store: Store, actor: ActorContext, workspaceIds: readonly string[]): JsonValue {
  const items = workspaceIds.slice(0, 25).map((id) => workspaceSummary(store, actor.organizationId, id) as unknown as JsonValue);
  return { items } as unknown as JsonValue;
}
