import type { ActorContext, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { workspaceSummary } from "../operations/read";

/**
 * bridge: the contract's WorkspaceSummary list — per-workspace counts rendered
 * by the Bridge screen, derived from the same read model workspace.context uses.
 */
export function bridge(store: Store, actor: ActorContext, workspaceIds: readonly string[]): JsonValue {
  const items = workspaceIds.slice(0, 25).map((id) => workspaceSummary(store, actor.organizationId, id) as unknown as JsonValue);
  return { items } as unknown as JsonValue;
}
