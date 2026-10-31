import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, BrainSession, CommandReceipt, Delegation, WorkBoardView } from "@brain/contracts";
import { recordAttemptSession } from "../../apps/governor/src/modules/sessions/index";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function world(): TestWorld {
  const w = setupWorld();
  cleanup.push(() => w.brain.close());
  return w;
}

function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, actor: ActorContext = w.owner, expectedVersion?: number): CommandReceipt {
  return w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload,
  } as never, key).receipt;
}

function workItem(w: TestWorld): string {
  const objectiveId = run(w, "objective.create", "delegation-objective", { title: "Bounded collaboration", intent: "Delegate independent work", successCriteria: ["Reviewed"] }).resourceId!;
  const planId = run(w, "plan.propose", "delegation-plan", { objectiveId, origin: "manual", tasks: [{ id: "task", title: "Implement", criteria: ["verified"], dependsOn: [] }] }).resourceId!;
  run(w, "plan.confirm", "delegation-confirm", { planVersionId: planId }, w.owner, 1);
  const board = (w.brain.executeQuery(w.owner, { queryType: "workBoard.get", workspaceId: w.workspaceId }) as { snapshot: WorkBoardView }).snapshot;
  return board.items[0]!.workItemId;
}

function parent(w: TestWorld, item: string): string {
  return run(w, "session.create", "delegation-parent", {
    workItemId: item, agentId: "parent-agent", engineId: "pi", task: "Coordinate implementation",
    budget: { maxTokens: 1000, maxMicroUsd: 500, maxTurns: 4 },
    scope: { allowedPaths: ["src", "tests"], prohibitedPaths: ["secrets"], allowedTools: ["fixture.echo"] }, worktreeId: "wt-parent",
  }).resourceId!;
}

function childInput(parentSessionId: string, key = "child"): Record<string, unknown> {
  return {
    parentSessionId, agentId: `${key}-agent`, engineId: "claude", task: "Implement the assigned slice",
    budget: { maxTokens: 600, maxMicroUsd: 200, maxTurns: 2 },
    scope: { allowedPaths: ["src"], prohibitedPaths: ["secrets", "dist"], allowedTools: ["fixture.echo"] }, worktreeId: `wt-${key}`,
  };
}

function delegation(w: TestWorld, id: string): Delegation {
  const result = (w.brain.executeQuery(w.owner, { queryType: "delegations.list", workspaceId: w.workspaceId }) as { snapshot: { items: Delegation[] } }).snapshot;
  return result.items.find((item) => item.delegationId === id)!;
}

function child(w: TestWorld, delegationId: string): BrainSession {
  const id = delegation(w, delegationId).childSessionId;
  return (w.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: id }) as { snapshot: BrainSession }).snapshot;
}

describe("bounded cross-agent delegation and independent review (T53, E106)", () => {
  it("narrows scope, reserves aggregate budget and prevents active writers sharing a worktree", () => {
    const w = world();
    const parentId = parent(w, workItem(w));
    expect(() => run(w, "session.delegate", "scope-escape", { ...childInput(parentId, "escape"), scope: { allowedPaths: ["src", "secrets"], prohibitedPaths: [], allowedTools: ["fixture.echo"] } })).toThrow(/exceed the parent/i);
    expect(() => run(w, "session.delegate", "tool-escape", { ...childInput(parentId, "tool"), scope: { allowedPaths: ["src"], prohibitedPaths: [], allowedTools: ["fixture.unapproved"] } })).toThrow(/exceed the parent/i);
    expect(() => run(w, "session.delegate", "same-agent", { ...childInput(parentId), agentId: "parent-agent" })).toThrow(/different child agent/i);

    const first = run(w, "session.delegate", "child-first", childInput(parentId, "first")).resourceId!;
    expect(child(w, first)).toEqual(expect.objectContaining({
      parentSessionId: parentId, rootSessionId: parentId, delegationDepth: 1,
      scope: { allowedPaths: ["src"], prohibitedPaths: ["secrets", "dist"], allowedTools: ["fixture.echo"] },
    }));
    expect(() => run(w, "session.delegate", "child-budget", { ...childInput(parentId, "budget"), budget: { maxTokens: 500, maxMicroUsd: 200, maxTurns: 2 } })).toThrow(/unreserved budget/i);

    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    db.prepare("UPDATE sessions SET state='running' WHERE id=?").run(parentId);
    expect(() => run(w, "session.delegate", "shared-worktree", { ...childInput(parentId, "shared"), worktreeId: "wt-parent", budget: { maxTokens: 100, maxMicroUsd: 100, maxTurns: 1 } })).toThrow(/cannot share a worktree/i);
    db.prepare("UPDATE sessions SET delegation_depth=3 WHERE id=?").run(parentId);
    expect(() => run(w, "session.delegate", "too-deep", { ...childInput(parentId, "deep"), budget: { maxTokens: 100, maxMicroUsd: 100, maxTurns: 1 } })).toThrow(/maximum delegation depth/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM delegations").get()).toEqual({ n: 1 });
  });

  it("requires an independent reviewer and a verdict from a different attempt", async () => {
    const w = world();
    const parentId = parent(w, workItem(w));
    const delegationId = run(w, "session.delegate", "review-child", childInput(parentId, "review")).resourceId!;
    const childId = delegation(w, delegationId).childSessionId;
    recordAttemptSession(w.brain.store, { organizationId: w.org, workspaceId: w.workspaceId, jobId: "child-job", attemptId: "child-attempt", engineId: "claude", adapterDigest: DIGEST_A, sessionId: childId });
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    db.prepare("INSERT INTO evidence_bundles(digest,bundle_id,job_id,attempt_id,state,manifest_json,created_at_ms) VALUES (?,'child-bundle','child-job','child-attempt','verified','{}',?)").run(DIGEST_A, w.brain.store.now());
    db.prepare("INSERT INTO verification_verdicts(id,bundle_digest,evaluator_attempt_id,evaluator_digest,outcome,manifest_json,created_at_ms) VALUES ('child-verdict',?,'evaluator-attempt',?,'verified','{}',?)").run(DIGEST_A, DIGEST_A, w.brain.store.now());

    expect(() => run(w, "delegation.review", "delegator-review", { delegationId, decision: "accepted", evidenceDigest: DIGEST_A })).toThrow(/independent reviewer/i);
    const reviewer = (await w.grantApprover("reviewer-1")).actor;
    const agentReviewer = { ...reviewer, kind: "agent" as const, actorId: "review-agent" };
    expect(() => run(w, "delegation.review", "agent-review", { delegationId, decision: "accepted", evidenceDigest: DIGEST_A }, agentReviewer)).toThrow(/actor kind/i);
    db.prepare("UPDATE verification_verdicts SET evaluator_attempt_id='child-attempt' WHERE bundle_digest=?").run(DIGEST_A);
    expect(() => run(w, "delegation.review", "self-evaluation", { delegationId, decision: "accepted", evidenceDigest: DIGEST_A }, reviewer)).toThrow(/independent evaluator/i);
    db.prepare("UPDATE verification_verdicts SET evaluator_attempt_id='evaluator-attempt' WHERE bundle_digest=?").run(DIGEST_A);
    run(w, "delegation.review", "independent-review", { delegationId, decision: "accepted", evidenceDigest: DIGEST_A }, reviewer);
    expect(delegation(w, delegationId)).toEqual(expect.objectContaining({ state: "accepted", reviewerId: "reviewer-1", evidenceDigest: DIGEST_A, parentSessionId: parentId, childSessionId: childId }));
    expect(child(w, delegationId).state).toBe("stopped");
  });

  it("keeps cross-tenant session and WorkItem identifiers invisible", () => {
    const w = world();
    const parentId = parent(w, workItem(w));
    const outsider = { ...w.owner, actorId: "outsider", organizationId: "org-other" };
    expect(() => run(w, "session.delegate", "cross-tenant", childInput(parentId), outsider)).toThrow(/workspace not found/i);
    expect(() => w.brain.executeQuery(outsider, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: parentId })).toThrow(/workspace not found/i);
  });
});
