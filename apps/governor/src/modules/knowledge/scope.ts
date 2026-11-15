import type { ActorContext, MemoryScope } from "@brain/contracts";
import type { Store } from "../../application/store";

/**
 * Memory scope (#135, ADR 0061). Who is reading decides what memory they see, on every read.
 *
 * A viewer is the set of mission teams it belongs to plus, for a person, the one private scope it owns. A machine principal (a session)
 * belongs to exactly the team of its own mission and owns no private scope, even though it acts for the mission owner: private memory
 * is the author's, never a session's. The planner of a new mission is a viewer with no team at all.
 */
export interface MemoryViewer {
  readonly teamIds: readonly string[];
  readonly ownerId: string | null;
}

export type ScopeKind = "private" | "team" | "workspace";
/** Wider is higher. Moving up needs a review; moving down never does. */
export const SCOPE_RANK: Readonly<Record<ScopeKind, number>> = { private: 0, team: 1, workspace: 2 };

export const NO_VIEWER: MemoryViewer = { teamIds: [], ownerId: null };

/** The team of one mission and nothing else: what a session or a mission-bound read may see. */
export const missionViewer = (missionId: string | undefined): MemoryViewer => ({ teamIds: missionId ? [missionId] : [], ownerId: null });

/**
 * A person: the mission teams they belong to in this workspace (the missions they own now, which follows an owner transfer, and the ones
 * they chose to watch) and their own private scope.
 */
export function personViewer(store: Store, organizationId: string, workspaceId: string, principalId: string): MemoryViewer {
  const db = store.workspaceDb(workspaceId, organizationId);
  const rows = db.prepare(`SELECT id FROM missions WHERE owner_id=? UNION SELECT mission_id FROM mission_watchers WHERE principal_id=?`).all(principalId, principalId) as Array<{ id: string }>;
  return { teamIds: rows.map((row) => row.id), ownerId: principalId };
}

/** The viewer an actor is when it reads memory of one workspace: a person sees their teams and private memory, a session its own mission's team only. */
export function viewerFor(store: Store, actor: ActorContext, workspaceId: string): MemoryViewer {
  if (actor.kind === "human") return personViewer(store, actor.organizationId, workspaceId, actor.actorId);
  const row = store.control.prepare("SELECT mission_id FROM agent_principals WHERE principal_id=? AND organization_id=? AND workspace_id=?").get(actor.actorId, actor.organizationId, workspaceId) as { mission_id: string } | undefined;
  return missionViewer(row?.mission_id);
}

/** The single predicate every read applies, to local and remote results alike. */
export function visibleTo(viewer: MemoryViewer, scope: MemoryScope, workspaceId: string): boolean {
  switch (scope.visibility) {
    case "global-approved": return true;
    case "workspace": return scope.workspaceId === workspaceId;
    case "team": return viewer.teamIds.includes(scope.teamId);
    case "private": return scope.workspaceId === workspaceId && viewer.ownerId !== null && viewer.ownerId === scope.ownerId;
  }
}
