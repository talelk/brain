import { afterEach, describe, expect, it } from "vitest";
import type { AttentionItem, AuditEntry } from "@brain/contracts";
import { DIGEST_A } from "../helpers";
import { totpCode } from "../support/totp";
import { bearer, closeWorlds, command, missionOf, run, running, startedMission as started, task, type Offer, type Runner, type World } from "../support/machine-session";

// ADR 0045: one administrator command stops every session of a workspace. It reuses the fence a lost lease already moves, the permit and
// credential revocation a quarantine already does, and the pause a mission already has; nothing here is a second path. State is reached only
// through commands and the runner protocol.

afterEach(closeWorlds);

const REASON = "Runaway agent is rewriting the wrong repository";

/** A fresh step-up for exactly this command and payload, the way the Administration page obtains it. */
async function stepUp(w: World, commandType: string, payload: Record<string, unknown>, workspaceId = w.workspaceId): Promise<string> {
  const headers = bearer(w.ownerToken);
  const identity = await w.brain.resolveActor(headers, workspaceId);
  const challenge = w.brain.stepUp.createCommandChallenge(identity, { commandType, workspaceId, payload: { workspaceId, ...payload } as never });
  return (await w.brain.stepUp.verifyCommand(identity, challenge.challengeId, "", headers)).evidenceId;
}

async function stopAll(w: World, key: string, reason = REASON, workspaceId = w.workspaceId, evidence?: string) {
  const stepUpEvidenceId = evidence ?? await stepUp(w, "workspace.sessions.stopAll", { reason }, workspaceId);
  return (await w.brain.executeCommand(w.owner, command(w, "workspace.sessions.stopAll", key, { workspaceId, reason, stepUpEvidenceId }, workspaceId), key, bearer(w.ownerToken))).receipt;
}

const settings = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "engineSettings.get", workspaceId: w.workspaceId })) as unknown as { snapshot: {
  autonomyCeiling: { preset: string; isDefault: boolean };
  liveWork: { sessions: number; standalone: number; waiting: number; missions: Array<{ missionId: string; title: string; sessions: number }>; moreMissions: number };
} }).snapshot;
const attention = async (w: World): Promise<AttentionItem[]> => ((await w.brain.executeQuery(w.owner, { queryType: "attention.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: AttentionItem[] } }).snapshot.items;
const audit = async (w: World): Promise<AuditEntry[]> => ((await w.brain.executeQuery(w.owner, { queryType: "audit.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: AuditEntry[] } }).snapshot.items;
const jobStates = (w: World): string[] => (w.brain.store.control.prepare("SELECT state FROM jobs WHERE workspace_id=? ORDER BY created_at_ms, id").all(w.workspaceId) as Array<{ state: string }>).map((row) => row.state);
const attemptStates = (w: World): string[] => (w.brain.store.control.prepare("SELECT a.state FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.workspace_id=? ORDER BY a.attempt_no, a.id").all(w.workspaceId) as Array<{ state: string }>).map((row) => row.state);

/** Every call a runner makes about an attempt it holds answers "your lease is lost" once the attempt is fenced. */
function expectFenced(w: World, runner: Runner, offer: Offer): void {
  const { jobProtocol: protocol } = w.brain;
  const lease = { leaseId: offer.leaseId, jobFence: offer.jobFence };
  expect(() => protocol.renew(runner, offer.attemptId, lease)).toThrow(/fenced/u);
  expect(() => protocol.events(runner, offer.attemptId, { ...lease, events: [] })).toThrow(/fenced/u);
  expect(() => protocol.complete(runner, offer.attemptId, { result: "succeeded", output: {}, jobFence: offer.jobFence, cleanupConfirmed: true })).toThrow(/fenced/u);
  expect(() => protocol.sessionCredential(runner, offer.attemptId)).toThrow(/fenced/u);
  expect(() => protocol.executionArtifact(runner, offer.attemptId)).toThrow(/fenced/u);
}

describe("stop all sessions (ADR 0045)", () => {
  it("fences every running attempt, revokes its session credential, pauses the missions with the reason and leaves the work waiting for a person", async () => {
    const { w, missionId, runner, workItemId } = await started({ tasks: [task("a"), task("b")] });
    const first = running(w, runner, "one");
    const second = running(w, runner, "two");
    const credential = w.brain.jobProtocol.sessionCredential(runner, first.attemptId).credential;
    await expect(w.brain.resolveActor(bearer(credential), w.workspaceId)).resolves.toBeTruthy();
    expect(await settings(w)).toMatchObject({ liveWork: { sessions: 2, standalone: 0, missions: [{ missionId, title: "Principals", sessions: 2 }] } });

    const receipt = await stopAll(w, "stop-1");
    expect(receipt).toMatchObject({ accepted: true, outcome: "applied" });

    // The fenced attempts can no longer report, renew, fetch their artifact or mint a credential; the credential they held no longer acts.
    expectFenced(w, runner, first);
    expectFenced(w, runner, second);
    await expect(w.brain.resolveActor(bearer(credential), w.workspaceId)).rejects.toThrow(/ended|revoked/u);
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM machine_sessions WHERE revoked_at_ms IS NULL").get()).toEqual({ n: 0 });
    expect(attemptStates(w)).toEqual(["cancelled", "cancelled"]);
    expect(jobStates(w)).toEqual(["cancelled", "cancelled"]);
    expect(w.brain.store.control.prepare("SELECT COALESCE(SUM(slots_reserved),0) AS n FROM runners").get()).toEqual({ n: 0 });

    // The mission is paused, says why, and is in Needs you; its task is ready again with the reason, neither failed nor dropped.
    expect(await missionOf(w, missionId)).toMatchObject({ state: "paused", pauseReason: "stopped", pauseNote: REASON });
    expect(await attention(w)).toContainEqual(expect.objectContaining({ kind: "needs-attention", missionId, title: expect.stringContaining("all sessions were stopped"), detail: REASON }));
    const items = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id, state, failed_attempts, parked, next_action FROM work_items WHERE mission_id=? ORDER BY rowid").all(missionId) as Array<{ id: string; state: string; failed_attempts: number; parked: number; next_action: string }>;
    expect(items).toHaveLength(2);
    for (const item of items) expect(item).toMatchObject({ state: "ready", failed_attempts: 0, parked: 0, next_action: expect.stringContaining("Stopped by an administrator") });
    expect(items.map((item) => item.id)).toContain(workItemId);
    // Nothing starts again by itself: the paused mission admits no attempt.
    expect(w.brain.jobProtocol.claim(runner, "claim-after-stop")).toBeNull();
    w.brain.jobProtocol.heartbeat(runner, { sequence: 1, health: "healthy" });
    expect(await settings(w)).toMatchObject({ liveWork: { sessions: 0, missions: [] } });

    // The audit trail says who stopped what, and why.
    expect(await audit(w)).toContainEqual(expect.objectContaining({ action: "workspace.sessionsStopped", actorId: w.owner.actorId, message: expect.stringContaining(REASON) }));

    // Stopping again finds nothing to stop and changes nothing.
    expect((await stopAll(w, "stop-2")).accepted).toBe(true);
    expect(attemptStates(w)).toEqual(["cancelled", "cancelled"]);

    // A person resumes the mission: its tasks start again as new attempts, while the fenced ones stay fenced.
    expect((await run(w, "mission.resume", "resume", { missionId }, (await missionOf(w, missionId)).version)).accepted).toBe(true);
    expect(await missionOf(w, missionId)).not.toHaveProperty("pauseReason");
    const again = running(w, runner, "again");
    expect(again.attemptId).not.toBe(first.attemptId);
    expectFenced(w, runner, first);
    expectFenced(w, runner, second);
  });

  it("is bound to its own workspace: another workspace keeps its running attempts", async () => {
    const { w, runner } = await started();
    const offer = running(w, runner, "other");
    w.brain.createWorkspace(w.owner, { workspaceId: "ws-second", slug: "second" });
    expect((await stopAll(w, "stop-other", REASON, "ws-second")).accepted).toBe(true);
    expect(() => w.brain.jobProtocol.renew(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence })).not.toThrow();
    expect(attemptStates(w)).toEqual(["running"]);
  });

  it("needs a fresh step-up for exactly this command, this workspace and this reason, spent once", async () => {
    const { w, runner } = await started();
    const offer = running(w, runner, "stepup");
    const refuse = (key: string, reason: string, evidence: string | undefined, matcher: RegExp) => expect(w.brain.executeCommand(w.owner,
      command(w, "workspace.sessions.stopAll", key, { workspaceId: w.workspaceId, reason, ...(evidence ? { stepUpEvidenceId: evidence } : {}) }), key, bearer(w.ownerToken))).rejects.toThrow(matcher);
    // The envelope itself names the evidence: a command without it is not a command.
    await refuse("no-evidence", REASON, undefined, /invalid/u);
    await refuse("made-up", REASON, "cmdstep-nothing", /step-up evidence invalid/u);
    // Evidence for another reason, another command or another workspace spends nothing here.
    const evidence = await stepUp(w, "workspace.sessions.stopAll", { reason: REASON });
    await refuse("other-reason", "Something else", evidence, /step-up evidence invalid/u);
    const ceiling = await stepUp(w, "workspace.autonomyCeiling.set", { preset: "supervised" });
    await refuse("other-command", REASON, ceiling, /step-up evidence invalid/u);
    // An unverified challenge is not evidence, and without the person's own session there is nothing to bind to.
    const headers = bearer(w.ownerToken);
    const challenge = w.brain.stepUp.createCommandChallenge(await w.brain.resolveActor(headers, w.workspaceId), { commandType: "workspace.sessions.stopAll", workspaceId: w.workspaceId, payload: { workspaceId: w.workspaceId, reason: "Unverified" } });
    await refuse("unverified", "Unverified", challenge.challengeId, /step-up evidence invalid/u);
    await expect(w.brain.executeCommand(w.owner, command(w, "workspace.sessions.stopAll", "no-session", { workspaceId: w.workspaceId, reason: REASON, stepUpEvidenceId: evidence }), "no-session")).rejects.toThrow(/session/u);
    expect(attemptStates(w)).toEqual(["running"]);
    // The right evidence works once; a different command with the same evidence is refused as spent.
    expect((await stopAll(w, "stop-ok", REASON, w.workspaceId, evidence)).accepted).toBe(true);
    await refuse("replayed", REASON, evidence, /step-up evidence invalid/u);
    expectFenced(w, runner, offer);
  });

  it("is a workspace administrator's command: a viewer cannot ask for the step-up, let alone stop anything", async () => {
    const { w, runner } = await started();
    const offer = running(w, runner, "viewer");
    const viewer = await w.grantApprover("approver-1");
    expect(() => w.brain.stepUp.createCommandChallenge(viewer.identity, { commandType: "workspace.sessions.stopAll", workspaceId: w.workspaceId, payload: { workspaceId: w.workspaceId, reason: REASON } })).toThrow(/missing scope workspace:admin/u);
    await expect(w.brain.executeCommand(viewer.actor, command(w, "workspace.sessions.stopAll", "viewer-stop", { workspaceId: w.workspaceId, reason: REASON, stepUpEvidenceId: "cmdstep-x" }), "k", new Headers({ authorization: `Bearer ${viewer.token}` }))).rejects.toThrow(/missing scope/u);
    expect(() => w.brain.jobProtocol.renew(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence })).not.toThrow();
  });

  it("a session credential cannot stop anything", async () => {
    const { w, runner } = await started();
    const offer = running(w, runner, "agent");
    const { credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    const identity = await w.brain.resolveActor(bearer(credential), w.workspaceId);
    await expect(w.brain.executeCommand(identity.actor, command(w, "workspace.sessions.stopAll", "agent-stop", { workspaceId: w.workspaceId, reason: REASON, stepUpEvidenceId: DIGEST_A }), "k", bearer(credential))).rejects.toThrow(/cannot run|missing scope/u);
    expect(() => w.brain.jobProtocol.renew(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence })).not.toThrow();
  });

  it("with two-factor, the step-up is a current authenticator code: a wrong code is refused, the right one makes evidence the command spends once", async () => {
    const { w, runner } = await started();
    const offer = running(w, runner, "totp");
    const lead = await w.grantApprover("lead-totp");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,'workspace-lead',1,'owner-1',?)").run(w.workspaceId, w.org, "lead-totp", w.brain.store.now());
    const headers = new Headers({ authorization: `Bearer ${lead.token}` });
    const identity = await w.brain.resolveActor(headers, w.workspaceId);
    const challenge = w.brain.stepUp.createCommandChallenge(identity, { commandType: "workspace.sessions.stopAll", workspaceId: w.workspaceId, payload: { workspaceId: w.workspaceId, reason: REASON } });
    await expect(w.brain.stepUp.verifyCommand(identity, challenge.challengeId, "000000", headers)).rejects.toThrow(/TOTP verification failed/u);
    const evidence = await w.brain.stepUp.verifyCommand(identity, challenge.challengeId, totpCode(lead.totp, Date.now()), headers);
    expect(evidence).toMatchObject({ evidenceId: challenge.challengeId, method: "totp" });
    const send = (key: string) => w.brain.executeCommand(identity.actor, command(w, "workspace.sessions.stopAll", key, { workspaceId: w.workspaceId, reason: REASON, stepUpEvidenceId: evidence.evidenceId }), key, headers);
    expect((await send("totp-stop")).receipt.accepted).toBe(true);
    expectFenced(w, runner, offer);
    await expect(send("totp-replay")).rejects.toThrow(/step-up evidence invalid/u);
  });
});

describe("the autonomy ceiling (workspace.autonomyCeiling.set)", () => {
  const setCeiling = async (w: World, key: string, preset: string, evidence?: string) => (await w.brain.executeCommand(w.owner,
    command(w, "workspace.autonomyCeiling.set", key, { workspaceId: w.workspaceId, preset, stepUpEvidenceId: evidence ?? await stepUp(w, "workspace.autonomyCeiling.set", { preset }) }), key, bearer(w.ownerToken))).receipt;

  it("is a preset an administrator sets with a fresh step-up, and it bounds the autonomy of missions created afterwards", async () => {
    const { w } = await started();
    expect((await settings(w)).autonomyCeiling).toEqual({ preset: "autonomous", isDefault: true });
    expect((await setCeiling(w, "ceiling-1", "supervised")).accepted).toBe(true);
    expect((await settings(w)).autonomyCeiling).toEqual({ preset: "supervised", isDefault: false });
    const created = (await run(w, "mission.create", "ceiling-mission", { title: "Bounded", intent: "Check the ceiling", successCriteria: ["done"], autonomy: "autonomous" })).resourceId ?? "";
    expect((await missionOf(w, created)).autonomyPolicy.operations).toEqual(["conflictTask.create"]);
    // Raising it again is the same command; the audit trail names the change and who made it.
    expect((await setCeiling(w, "ceiling-2", "standard")).accepted).toBe(true);
    expect((await settings(w)).autonomyCeiling.preset).toBe("standard");
    expect(await audit(w)).toContainEqual(expect.objectContaining({ action: "workspace.autonomyCeilingSet", actorId: w.owner.actorId, message: "Set the autonomy ceiling to standard" }));
  });

  it("refuses a change without step-up evidence for exactly that preset", async () => {
    const { w } = await started();
    const forSupervised = await stepUp(w, "workspace.autonomyCeiling.set", { preset: "supervised" });
    await expect(setCeiling(w, "wrong-preset", "autonomous", forSupervised)).rejects.toThrow(/step-up evidence invalid/u);
    await expect(setCeiling(w, "made-up", "supervised", "cmdstep-nothing")).rejects.toThrow(/step-up evidence invalid/u);
    expect((await settings(w)).autonomyCeiling.isDefault).toBe(true);
    expect((await setCeiling(w, "right", "supervised", forSupervised)).accepted).toBe(true);
    await expect(setCeiling(w, "again", "supervised", forSupervised)).rejects.toThrow(/step-up evidence invalid/u);
  });

  it("is an organization administrator's change, not a workspace member's", async () => {
    const { w } = await started();
    const approver = await w.grantApprover("approver-2");
    await expect(w.brain.executeCommand(approver.actor, command(w, "workspace.autonomyCeiling.set", "member-ceiling", { workspaceId: w.workspaceId, preset: "supervised", stepUpEvidenceId: "cmdstep-x" }), "k", new Headers({ authorization: `Bearer ${approver.token}` }))).rejects.toThrow(/missing scope|administration/u);
  });
});
