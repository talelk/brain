import type { ActorContext, JsonValue } from "@brain/contracts";
import type { Store } from "./store";

/**
 * Read-side currency. Modules own their read models and return snapshots
 * through this shape; the query dispatcher wraps them in the standard
 * envelope. The cursor is only populated by paginated read models.
 */
export interface QuerySnapshot {
  readonly snapshot: JsonValue;
  readonly cursor?: string;
}

/** The actor's unrevoked workspaces in the organization — the cross-workspace read scope. */
export function orgWorkspaces(store: Store, actor: ActorContext): string[] {
  return (store.control.prepare(
    "SELECT workspace_id FROM workspace_memberships WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL",
  ).all(actor.organizationId, actor.actorId) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
}

/** Case-insensitive substring matcher shared by the search helpers. */
export function textMatcher(needle: string): (value: unknown) => boolean {
  const lowered = needle.toLowerCase();
  return (value: unknown) => String(value ?? "").toLowerCase().includes(lowered);
}
