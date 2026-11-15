import { afterEach, describe, expect, it } from "vitest";
import type { BrainSession, Delegation } from "@brain/contracts";
import { delegatingStarter } from "../support/starter";
import { closeWorlds, run, running, startedMission, type World } from "../support/machine-session";

// Bounded delegation (T53, E106, ADR 0051). The parent is a person's view of a real running session (the first attempt of the mission's task);
// a delegation of it is asked by a person naming that session, so scope, budget, worktree and depth are the Governor's, not the caller's.

afterEach(closeWorlds);

async function parent() {
  const world = await startedMission({ starter: delegatingStarter() });
  running(world.w, world.runner, "parent");
  const sessions = ((await world.w.brain.executeQuery(world.w.owner, { queryType: "sessions.list", workspaceId: world.w.workspaceId })) as unknown as { snapshot: { items: BrainSession[] } }).snapshot.items;
  return { ...world, parentId: sessions[0]!.sessionId, parentSession: sessions[0]! };
}

const delegations = async (w: World): Promise<Delegation[]> => ((await w.brain.executeQuery(w.owner, { queryType: "delegations.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Delegation[] } }).snapshot.items;
const sessionOf = async (w: World, id: string): Promise<BrainSession> => ((await w.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: BrainSession }).snapshot;
const childOf = async (w: World, delegationId: string): Promise<BrainSession> => sessionOf(w, (await delegations(w)).find((entry) => entry.delegationId === delegationId)!.childSessionId);

describe("bounded delegation (T53, E106)", () => {
  it("narrows scope to the parent's, reserves aggregate budget and prevents active writers sharing a worktree", async () => {
    const { w, parentId, parentSession } = await parent();
    const [tool] = parentSession.scope.allowedTools;
    expect(tool, "the session's scope is its agent's tools").toBeTruthy();
    // The parent's scope is its agent's tools and no paths: a child cannot be given a path or a tool the parent has not.
    await expect(run(w, "session.delegate", "path-escape", { parentSessionId: parentId, task: "Write to src", scope: { allowedPaths: ["src"], prohibitedPaths: [], allowedTools: [] } })).rejects.toThrow(/exceed the parent/i);
    await expect(run(w, "session.delegate", "tool-escape", { parentSessionId: parentId, task: "Use a tool", scope: { allowedPaths: [], prohibitedPaths: ["secrets"], allowedTools: ["fixture.unapproved"] } })).rejects.toThrow(/exceed the parent/i);

    const first = (await run(w, "session.delegate", "child-first", { parentSessionId: parentId, task: "First", budget: { maxTokens: 60_000, maxMicroUsd: 0, maxTurns: 4 }, scope: { allowedPaths: [], prohibitedPaths: ["dist"], allowedTools: [tool!] } })).resourceId!;
    expect(await childOf(w, first)).toEqual(expect.objectContaining({
      parentSessionId: parentId, rootSessionId: parentId, delegationDepth: 1,
      scope: { allowedPaths: [], prohibitedPaths: ["dist"], allowedTools: [tool] },
    }));
    // The parent declared 100000 tokens: 60000 are reserved for the first child, so 50000 more do not fit.
    await expect(run(w, "session.delegate", "child-budget", { parentSessionId: parentId, task: "Too big", budget: { maxTokens: 50_000, maxMicroUsd: 0, maxTurns: 2 } })).rejects.toThrow(/unreserved budget/i);
    // The parent's own worktree belongs to an active writer, so no child may take it.
    await expect(run(w, "session.delegate", "shared-worktree", { parentSessionId: parentId, task: "Share it", worktreeId: parentSession.worktreeId, budget: { maxTokens: 1000, maxMicroUsd: 0, maxTurns: 1 } })).rejects.toThrow(/cannot share a worktree/i);
    expect(await delegations(w)).toHaveLength(1);
  });

  it("goes three levels deep and no further, and every level is a child of the one above", async () => {
    const { w, parentId } = await parent();
    let above = parentId;
    for (const level of [1, 2, 3]) {
      const id = (await run(w, "session.delegate", `level-${level}`, { parentSessionId: above, task: `Level ${level} slice` })).resourceId!;
      const session = await childOf(w, id);
      expect(session).toEqual(expect.objectContaining({ parentSessionId: above, rootSessionId: parentId, delegationDepth: level }));
      above = session.sessionId;
    }
    await expect(run(w, "session.delegate", "level-4", { parentSessionId: above, task: "Level 4 slice" })).rejects.toThrow(/maximum delegation depth is 3.*itself/is);
    expect(await delegations(w)).toHaveLength(3);
  });

  it("keeps cross-tenant session and WorkItem identifiers invisible", async () => {
    const { w, parentId } = await parent();
    const outsider = { ...w.owner, actorId: "outsider", organizationId: "org-other" };
    await expect(w.brain.executeCommand(outsider, { contractVersion: "brain.command/v1", commandId: "cmd-cross", commandType: "session.delegate", workspaceId: w.workspaceId, idempotencyKey: "cross", payload: { parentSessionId: parentId, task: "Not mine" } } as never, "cross")).rejects.toThrow(/workspace not found/i);
    await expect(Promise.resolve().then(() => w.brain.executeQuery(outsider, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: parentId }))).rejects.toThrow(/workspace not found/i);
  });
});
