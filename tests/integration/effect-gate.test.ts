import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { readVerified } from "../../apps/governor/src/modules/artifacts/index";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { scaled } from "../support/timing";

/**
 * Phase 3 gate (ADR 0024, ADR 0028): one incident handled end to end. A watch task finds an unhealthy container and proposes a restart;
 * the proposal ends its attempt (nothing waits on a runner) and the restart is held as its own job; the owner approves ONE permit, the
 * held job restarts once through the launcher, and the task resumes to write its report with the receipt in its evidence. A denied or an
 * expired approval does nothing. Everything runs through the Governor, a real runner supervisor and a real launcher; only the sandbox
 * that shapes the tool's output is a local stand-in.
 */
let world: EffectsWorld | undefined;
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

describe("effect tools: an incident from watch to restart with one approval", () => {
  it("proposes, holds, runs the restart once after the owner approved that exact call, and records the evidence", async () => {
    world = await effectsWorld();
    const w = world;
    await w.dispatch("incident-1");
    // The watch proposes the restart and ENDS: its report is written, nothing has been restarted, and the task waits with no runner slot.
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();
    const subject = JSON.parse(approval.subject_json) as { operation: string; effectBounds: { summary: string; arguments: { container: string }; once: boolean; actJobId: string } };
    expect(subject.operation).toBe("effect.host.restart");
    expect(subject.effectBounds.summary).toContain("demo-app");
    expect(subject.effectBounds.arguments).toEqual({ container: "demo-app" });
    expect(w.restarts()).toEqual([]);
    expect(w.permits()).toEqual([]);
    expect(w.liveAttempts()).toEqual([]);
    expect(w.slotsReserved()).toBe(0);
    const [watch, act] = w.jobs();
    expect(watch).toMatchObject({ step_id: "respond", state: "blocked", queue_reason: "AWAITING_APPROVAL", effect_class: "read" });
    // The change is held as its own job, bound by the approval's subject, and nobody can claim it before the decision.
    expect(act).toMatchObject({ id: subject.effectBounds.actJobId, step_id: "act", state: "blocked", queue_reason: "AWAITING_APPROVAL", effect_class: "privileged" });
    expect(await w.run()).toBe(false);
    // The owner decides from the approval's own page (the notification links to it); the request was made by the platform, not by them.
    expect((w.store.control.prepare("SELECT requested_by FROM approval_requests WHERE id=?").get(approval.id) as { requested_by: string }).requested_by).toBe("system:effect-call");
    await w.decide(approval, "approve");
    expect(w.jobs()[1]!.state).toBe("queued");
    expect(await w.drain()).toBe(2); // the held restart, then the resumed task (the evaluator waits for its own runner group)

    expect(w.restarts()).toEqual(["restarted demo-app"]);
    const permits = w.permits();
    expect(permits).toHaveLength(1);
    expect(permits[0]).toMatchObject({ state: "applied", approval_id: approval.id });
    expect(w.jobs().map((job) => [job.step_id, job.state])).toEqual([["respond", "verifying"], ["act", "succeeded"], ["validate", "queued"]]);
    expect(w.calls()).toEqual([expect.objectContaining({ approval_id: approval.id, outcome: "applied", parent_job_id: watch!.id, act_job_id: act!.id })]);
    // Three attempts: the watch (which proposed), the held restart (which owns the permit), and the resumed task (which wrote the report).
    const [first, held, resumed] = w.attempts();
    expect([first, held, resumed].map((attempt) => attempt!.state)).toEqual(["succeeded", "succeeded", "verifying"]);
    expect(permits[0]!.invocation_id).toBe(`inv-${approval.id}`);
    expect((w.store.control.prepare("SELECT job_id FROM job_attempts WHERE id=?").get(held!.id) as { job_id: string }).job_id).toBe(act!.id);
    expect((w.store.control.prepare("SELECT attempt_id FROM effect_permits").get() as { attempt_id: string }).attempt_id).toBe(held!.id);
    // What the proposing attempt saw: the read call's result, then "proposed, waiting", never a result of the change.
    const firstCalls = w.toolEvents(first!.id);
    expect(firstCalls.map((entry) => entry.kind)).toEqual(["tool.proposed", "tool.result", "tool.proposed", "tool.result"]);
    const proposedResult = (firstCalls[3]!.payload as unknown as { receipt: { result: string; stdout: { digest: string } } }).receipt;
    expect(proposedResult.result).toBe("succeeded");
    expect(JSON.parse(new TextDecoder().decode(readVerified(w.store, proposedResult.stdout.digest)))).toMatchObject({ status: "awaiting-approval", approvalId: approval.id });
    // The resumed attempt asked for the same change again (the fixture model repeats its script) and was told it was already made: no second approval.
    expect((w.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() as { n: number }).n).toBe(1);
    const again = (w.toolEvents(resumed!.id).at(-1)!.payload as unknown as { receipt: { stdout: { digest: string } } }).receipt;
    expect(JSON.parse(new TextDecoder().decode(readVerified(w.store, again.stdout.digest)))).toMatchObject({ status: "already-decided", outcome: "applied" });
    // The evidence: the receipt row, the permit's final state, and ONE bundle (the resumed attempt's) that carries the effect and the approval it consumed.
    const receipts = w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("SELECT outcome, operation, target_key, receipt_digest FROM domain_operation_receipts").all();
    expect(receipts).toEqual([{ outcome: "applied", operation: "effect.host.restart", target_key: "tool:host.restart", receipt_digest: permits[0]!.receipt_digest }]);
    const bundles = (w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("SELECT manifest_json, attempt_id FROM evidence_bundles").all() as Array<{ manifest_json: string; attempt_id: string }>).map((row) => ({ attempt: row.attempt_id, manifest: JSON.parse(row.manifest_json) as { effects: Array<{ outcome: string; invocationId: string }>; approvalIds: string[] } }));
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.attempt).toBe(resumed!.id);
    expect(bundles[0]!.manifest.effects).toEqual([expect.objectContaining({ outcome: "applied", invocationId: permits[0]!.invocation_id })]);
    expect(bundles[0]!.manifest.approvalIds).toEqual([approval.id]);
    expect((w.store.control.prepare("SELECT attempt_id FROM approval_consumptions WHERE approval_id=?").get(approval.id) as { attempt_id: string }).attempt_id).toBe(held!.id);
  }, scaled(120_000));

  it("does nothing when the owner declines, tells the resumed task so, and the call fails with a plain reason", async () => {
    const w = world ?? (world = await effectsWorld());
    const before = w.restarts().length;
    const permitsBefore = w.permits().length;
    await w.dispatch("incident-2");
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();
    await w.decide(approval, "reject");
    await w.drain();
    expect(w.restarts()).toHaveLength(before);
    expect(w.permits()).toHaveLength(permitsBefore);
    const call = w.calls().find((entry) => entry.approval_id === approval.id)!;
    expect(call.outcome).toBe("declined");
    expect(w.jobs().find((job) => job.id === call.act_job_id)!.state).toBe("cancelled");
    // The task still finished its report: its job went on to verification with nothing changed.
    expect(w.jobs().find((job) => job.id === call.parent_job_id)!.state).toBe("verifying");
    expect((w.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(approval.id) as { state: string }).state).toBe("rejected");
    const resumed = w.attempts().at(-1)!;
    const result = (w.toolEvents(resumed.id).at(-1)!.payload as unknown as { receipt: { stdout: { digest: string } } }).receipt;
    expect(JSON.parse(new TextDecoder().decode(readVerified(w.store, result.stdout.digest)))).toMatchObject({ status: "already-decided", outcome: "declined" });
  }, scaled(120_000));

  it("does nothing when nobody answers before the approval expires, found by the Governor's own sweep", async () => {
    const w = world ?? (world = await effectsWorld());
    const before = w.restarts().length;
    await w.dispatch("incident-3");
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();
    w.store.control.prepare("UPDATE approval_requests SET expires_at_ms=? WHERE id=?").run(Date.now() - 1000, approval.id);
    // No runner is waiting on it: only the maintenance pass notices, cancels the held change and lets the task resume.
    expect(w.w.brain.jobProtocol.settleEffects()).toBeGreaterThan(0);
    await w.drain();
    expect(w.restarts()).toHaveLength(before);
    expect((w.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(approval.id) as { state: string }).state).toBe("expired");
    expect(w.permits().filter((permit) => permit.approval_id === approval.id)).toEqual([]);
    const call = w.calls().find((entry) => entry.approval_id === approval.id)!;
    expect(call.outcome).toBe("expired");
    expect(w.jobs().find((job) => job.id === call.act_job_id)!.state).toBe("cancelled");
    expect(w.jobs().find((job) => job.id === call.parent_job_id)!.state).toBe("verifying");
  }, scaled(120_000));
});
