import { rmSync } from "node:fs";
import type { ApprovalRequest } from "@brain/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { editedStarter } from "../support/starter";
import { missionWithTask } from "../support/pull-request-world";
import { DIGEST_A, seedHuman, setupWorld, stepUp, type TestWorld } from "../helpers";
import { approvalCurrentlyUsable } from "../../apps/governor/src/modules/governance/approval-authority";
import { scaled } from "../support/timing";

// A risk tier is computed per effect request from facts the Governor holds, shown with its reasons, and bound into the approval (#149,
// ADR 0075). Higher tiers ask MORE of the approval (a TOTP step-up, a second different approver); none ever skips a per-effect approval.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const refusal = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); } };

const subjectOf = (w: TestWorld, over: Record<string, unknown>, nonce: string) => ({
  organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish", tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
  target: { targetId: "target-risk", environmentId: "local", preconditionDigest: DIGEST_A }, artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
  effectBounds: {}, expiresAt: new Date(Date.now() + 3600_000).toISOString(), nonce, ...over,
});
/** Asks for an approval as the workspace owner through the command funnel and reads it back as a person would. */
async function request(w: TestWorld, over: Record<string, unknown>, nonce: string): Promise<ApprovalRequest> {
  const receipt = (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandType: "approval.request", commandId: `cmd-${nonce}`, idempotencyKey: nonce, workspaceId: w.workspaceId, payload: { subject: subjectOf(w, over, nonce) } } as never, nonce)).receipt;
  return view(w, receipt.resourceId!);
}
const view = async (w: TestWorld, approvalId: string): Promise<ApprovalRequest> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "approval.get", workspaceId: w.workspaceId, resourceId: approvalId })) as unknown as { snapshot: ApprovalRequest }).snapshot;
const decision = (approval: ApprovalRequest, key: string, evidenceId?: string) => ({
  contractVersion: "brain.approval-decision/v1" as const, idempotencyKey: key, decision: "approve" as const, subjectDigest: approval.subjectDigest,
  expectedVersion: approval.version, note: "reviewed", ...(evidenceId ? { stepUpEvidenceId: evidenceId } : {}),
});
/** A person who may approve but has not enrolled an authenticator. */
async function plainApprover(w: TestWorld, id: string) {
  const { token } = seedHuman(w.brain, w.org, id);
  w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,?,'approver',1,?,?)").run(w.workspaceId, w.org, id, w.owner.actorId, Date.now());
  const headers = new Headers({ authorization: `Bearer ${token}` });
  return { headers, identity: await w.brain.resolveActor(headers, w.workspaceId) };
}
/** The repository change that reaches outside what a change should touch: CI configuration. */
const OUTSIDE = { arguments: { files: [{ path: ".github/workflows/deploy.yml", content: "on: push\n" }] }, summary: "Open a pull request" };
const critical = (nonce: string, extra: Record<string, unknown> = {}) => ({ tool: { id: "git.open-pr", digest: DIGEST_A }, target: { targetId: "repo", environmentId: "production", preconditionDigest: DIGEST_A }, effectBounds: OUTSIDE, nonce, ...extra });

describe("the risk tier is computed from facts and shown with its reasons", () => {
  it("a low-risk change says so, asks for nothing more, and is decided with the ordinary session step-up", async () => {
    const w = setupWorld();
    const approval = await request(w, {}, "risk-low");
    expect(approval.subject.risk).toMatchObject({ tier: "low", requires: { stepUp: false, secondApprover: false } });
    expect(approval.subject.risk?.reasons.map((reason) => reason.code)).toEqual(["class-write", "no-rollback"]);
    const approver = await plainApprover(w, "low-approver");
    const challenge = w.brain.stepUp.createChallenge(approver.identity, approval.approvalId, approval.subjectDigest);
    expect(challenge.method).toBe("session");
    const { evidenceId } = await w.brain.stepUp.verify(approver.identity, challenge.challengeId, "", approver.headers);
    expect((await w.brain.decideApproval(approver.identity, approval.approvalId, decision(approval, "risk-low-dec", evidenceId))).state).toBe("approved");
    w.brain.close();
  });

  it("the same facts give the same tier and reasons, and a proposal cannot name a lower tier", async () => {
    const w = setupWorld();
    const first = await request(w, critical("risk-det-1"), "risk-det-1");
    const lying = await request(w, { ...critical("risk-det-2"), risk: { tier: "low", reasons: [], requires: { stepUp: false, secondApprover: false } } }, "risk-det-2");
    expect(lying.subject.risk).toEqual(first.subject.risk);
    expect(first.subject.risk).toMatchObject({ tier: "critical", requires: { stepUp: true, secondApprover: true } });
    expect(first.subject.risk?.reasons.map((reason) => reason.code)).toEqual(["class-write", "production-environment", "repository", "files-outside-target", "no-rollback"]);
    expect(first.subject.risk?.reasons.find((reason) => reason.code === "files-outside-target")?.fact).toContain(".github/workflows/deploy.yml");
    w.brain.close();
  });

  it("the release policy may only raise the tier: a production write is at least high, with the policy named", async () => {
    const w = setupWorld();
    const prod = await request(w, { target: { targetId: "t", environmentId: "production", preconditionDigest: DIGEST_A } }, "risk-policy");
    expect(prod.subject.risk?.tier).toBe("high");
    expect(prod.subject.risk?.reasons.map((reason) => reason.code)).toContain("policy-floor");
    expect(prod.subject.risk?.reasons.find((reason) => reason.code === "policy-floor")?.fact).toContain("productionHumanApproval");
    // Nothing the policy says lowers a tier the facts raised.
    const worse = await request(w, critical("risk-policy-2"), "risk-policy-2");
    expect(worse.subject.risk?.tier).toBe("critical");
    w.brain.close();
  });
});

describe("an elevated tier needs a TOTP step-up", () => {
  it("a person without an authenticator cannot decide it; with one they can, and the evidence is a TOTP one", async () => {
    const w = setupWorld();
    const approval = await request(w, { tool: { id: "git.open-pr", digest: DIGEST_A }, effectBounds: OUTSIDE }, "risk-elevated");
    expect(approval.subject.risk).toMatchObject({ tier: "elevated", requires: { stepUp: true, secondApprover: false } });
    const plain = await plainApprover(w, "plain-approver");
    expect(() => w.brain.stepUp.createChallenge(plain.identity, approval.approvalId, approval.subjectDigest)).toThrow(/TOTP/);
    // Session-only evidence cannot be forged either: the decision itself refuses it.
    expect(await refusal(() => w.brain.decideApproval(plain.identity, approval.approvalId, decision(approval, "risk-no-evidence")))).toMatch(/step-up/);
    const enrolled = await w.grantApprover("enrolled-approver");
    const challenge = w.brain.stepUp.createChallenge(enrolled.identity, approval.approvalId, approval.subjectDigest);
    expect(challenge.method).toBe("totp");
    const evidenceId = await stepUp(w, enrolled, approval.approvalId, approval.subjectDigest);
    expect((await w.brain.decideApproval(enrolled.identity, approval.approvalId, decision(approval, "risk-elevated-dec", evidenceId))).state).toBe("approved");
    w.brain.close();
  });
});

describe("a critical tier needs two different people", () => {
  it("stays pending after one approver, refuses the same person twice and a tampered tier, and only the second approver makes it usable", async () => {
    const w = setupWorld();
    const approval = await request(w, critical("risk-crit"), "risk-crit");
    const other = await request(w, critical("risk-crit-other"), "risk-crit-other");
    const a = await w.grantApprover("crit-a");
    const b = await w.grantApprover("crit-b");
    const bound = (id: string, digest: string) => ({ approvalId: id, organizationId: w.org, workspaceId: w.workspaceId, subjectDigest: digest });

    const firstEvidence = await stepUp(w, a, approval.approvalId, approval.subjectDigest);
    const first = await w.brain.decideApproval(a.identity, approval.approvalId, decision(approval, "crit-a-1", firstEvidence));
    expect(first.state).toBe("pending");
    const afterFirst = await view(w, approval.approvalId);
    expect(afterFirst).toMatchObject({ state: "pending", version: approval.version + 1, approvedBy: ["crit-a"] });
    expect(approvalCurrentlyUsable(w.brain.store, w.brain.auth, bound(approval.approvalId, approval.subjectDigest))).toBe(false);

    // The same person again, with fresh evidence, is refused; so is the requester.
    const again = await stepUp(w, a, approval.approvalId, approval.subjectDigest);
    expect(await refusal(() => w.brain.decideApproval(a.identity, approval.approvalId, decision(afterFirst, "crit-a-2", again)))).toMatch(/already approved/);
    expect(await refusal(() => w.brain.decideApproval((w.owner as never), approval.approvalId, decision(afterFirst, "crit-owner")))).not.toBe("");
    expect((await view(w, approval.approvalId)).state).toBe("pending");

    // A tampered tier does not match the digest the approval was requested with.
    const row = w.brain.store.control.prepare("SELECT subject_json FROM approval_requests WHERE id=?").get(other.approvalId) as { subject_json: string };
    const lowered = { ...JSON.parse(row.subject_json), risk: { tier: "low", reasons: [], requires: { stepUp: false, secondApprover: false } } };
    w.brain.store.control.prepare("UPDATE approval_requests SET subject_json=? WHERE id=?").run(JSON.stringify(lowered), other.approvalId);
    const tamperEvidence = await stepUp(w, b, other.approvalId, other.subjectDigest);
    expect(await refusal(() => w.brain.decideApproval(b.identity, other.approvalId, decision(other, "crit-tamper", tamperEvidence)))).toMatch(/altered/);

    // A second, different person decides it; every approval is its own: the other request is untouched.
    const secondEvidence = await stepUp(w, b, approval.approvalId, approval.subjectDigest);
    const second = await w.brain.decideApproval(b.identity, approval.approvalId, decision(afterFirst, "crit-b-1", secondEvidence));
    expect(second.state).toBe("approved");
    expect(approvalCurrentlyUsable(w.brain.store, w.brain.auth, bound(approval.approvalId, approval.subjectDigest))).toBe(true);
    expect((await view(w, other.approvalId)).state).toBe("pending");
    expect(approvalCurrentlyUsable(w.brain.store, w.brain.auth, bound(other.approvalId, other.subjectDigest))).toBe(false);
    w.brain.close();
  });
});

describe("a critical effect of a mission is decided by two people other than its owner, and runs once", () => {
  const production = () => editedStarter({
    "host.restart.yaml": (value) => { (value["spec"] as Record<string, unknown>)["allowedEnvironments"] = ["production"]; },
    "operations-policy.yaml": (value) => { (value["spec"] as Record<string, unknown>)["separationOfDuties"] = false; },
  });
  const open = async (): Promise<EffectsWorld> => {
    const world = await effectsWorld({ bundle: production() });
    cleanup.push(() => rmSync(world.root, { recursive: true, force: true }));
    return world;
  };

  it("holds the held change until the second person approves, refuses the mission owner and the first approver again, then makes the change once", async () => {
    const world = await open();
    const { workItemId } = await missionWithTask(world);
    await world.dispatch("risk-mission", undefined, { workItemId });
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    const approval = ((await world.w.brain.executeQuery(world.w.owner, { queryType: "approval.get", workspaceId: world.w.workspaceId, resourceId: pending.id })) as unknown as { snapshot: ApprovalRequest }).snapshot;
    expect(approval.subject.risk).toMatchObject({ tier: "critical", requires: { stepUp: true, secondApprover: true } });
    expect(approval.subject.risk?.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["class-privileged", "production-environment", "host", "no-rollback"]));

    // The owner of the mission is not one of the two, even as an approver.
    world.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'owner-1', 'approver', 1, 'owner-1', ?)").run(world.w.workspaceId, world.w.org, world.store.now());
    const owner = await world.w.brain.resolveActor(new Headers({ authorization: `Bearer ${world.w.ownerToken}` }), world.w.workspaceId);
    expect(await refusal(() => world.w.brain.decideApproval(owner, pending.id, decision(approval, "risk-owner", "ev-any")))).toMatch(/owner of the mission/);

    const a = await world.w.grantApprover("mission-a");
    const evidenceA = await stepUp(world.w, a, pending.id, pending.subject_digest);
    expect((await world.w.brain.decideApproval(a.identity, pending.id, decision(approval, "risk-a", evidenceA))).state).toBe("pending");
    // One approver is not enough: the held change does not run and no permit exists.
    await world.drain();
    expect(world.restarts()).toEqual([]);
    expect(world.permits()).toEqual([]);

    const afterFirst = ((await world.w.brain.executeQuery(world.w.owner, { queryType: "approval.get", workspaceId: world.w.workspaceId, resourceId: pending.id })) as unknown as { snapshot: ApprovalRequest }).snapshot;
    const evidenceAgain = await stepUp(world.w, a, pending.id, pending.subject_digest);
    expect(await refusal(() => world.w.brain.decideApproval(a.identity, pending.id, decision(afterFirst, "risk-a-again", evidenceAgain)))).toMatch(/already approved/);

    const b = await world.w.grantApprover("mission-b");
    const evidenceB = await stepUp(world.w, b, pending.id, pending.subject_digest);
    expect((await world.w.brain.decideApproval(b.identity, pending.id, decision(afterFirst, "risk-b", evidenceB))).state).toBe("approved");
    await world.drain();
    expect(world.restarts()).toEqual(["restarted demo-app"]);
    // One approval, one permit: the tier asked for more people, never for a shared or skipped approval.
    expect(world.permits()).toHaveLength(1);
  }, scaled(240_000));
});
