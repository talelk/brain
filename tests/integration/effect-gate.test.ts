import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { scaled } from "../support/timing";

/**
 * Phase 3 gate (ADR 0024): one incident handled end to end. A watch task finds an unhealthy container, proposes a restart, the owner
 * approves ONE permit, the restart runs once through the launcher and the evidence is recorded. A denied or an expired approval does
 * nothing. Everything runs through the Governor, a real runner supervisor and a real launcher; only the sandbox that shapes the tool's
 * output is a local stand-in.
 */
let world: EffectsWorld | undefined;
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

describe("effect tools: an incident from watch to restart with one approval", () => {
  it("runs the restart once, after the owner approved that exact call, and records the evidence", async () => {
    world = await effectsWorld();
    const w = world;
    await w.dispatch("incident-1");
    const running = w.run();
    // The call stops at the approval: nothing has been restarted while the owner has not answered.
    const approval = await w.pendingApproval();
    const subject = JSON.parse(approval.subject_json) as { operation: string; requestedBy?: string; effectBounds: { summary: string; arguments: { container: string }; once: boolean } };
    expect(subject.operation).toBe("effect.host.restart");
    expect(subject.effectBounds.summary).toContain("demo-app");
    expect(subject.effectBounds.arguments).toEqual({ container: "demo-app" });
    expect(w.restarts()).toEqual([]);
    expect(w.permits()).toEqual([]);
    // The owner decides from the approval's own page (the notification links to it); the request was made by the platform, not by them.
    expect((w.store.control.prepare("SELECT requested_by FROM approval_requests WHERE id=?").get(approval.id) as { requested_by: string }).requested_by).toBe("system:effect-call");
    await w.decide(approval, "approve");
    expect(await running).toBe(true);

    expect(w.restarts()).toEqual(["restarted demo-app"]);
    const permits = w.permits();
    expect(permits).toHaveLength(1);
    expect(permits[0]).toMatchObject({ state: "applied", approval_id: approval.id });
    const [attempt] = w.attempts();
    const calls = w.toolEvents(attempt!.id);
    expect(calls.map((entry) => entry.kind)).toEqual(["tool.proposed", "tool.result", "tool.proposed", "tool.result"]);
    expect((calls[3]!.payload as unknown as { receipt: { result: string } }).receipt.result).toBe("succeeded");
    // The evidence: the receipt row, the permit's final state, and a bundle that carries the effect and the approval it consumed.
    const receipts = w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("SELECT outcome, operation, target_key, receipt_digest FROM domain_operation_receipts").all();
    expect(receipts).toEqual([{ outcome: "applied", operation: "effect.host.restart", target_key: "tool:host.restart", receipt_digest: permits[0]!.receipt_digest }]);
    const bundles = (w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("SELECT manifest_json FROM evidence_bundles").all() as Array<{ manifest_json: string }>).map((row) => JSON.parse(row.manifest_json) as { effects: Array<{ outcome: string; invocationId: string }>; approvalIds: string[] });
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.effects).toEqual([expect.objectContaining({ outcome: "applied", invocationId: permits[0]!.invocation_id })]);
    expect(bundles[0]!.approvalIds).toEqual([approval.id]);
    expect((w.store.control.prepare("SELECT 1 FROM approval_consumptions WHERE approval_id=?").get(approval.id))).toBeTruthy();
  }, scaled(120_000));

  it("does nothing when the owner declines, and the call fails with a plain reason", async () => {
    const w = world ?? (world = await effectsWorld());
    const before = w.restarts().length;
    const permitsBefore = w.permits().length;
    await w.dispatch("incident-2");
    const running = w.run();
    const approval = await w.pendingApproval();
    await w.decide(approval, "reject");
    expect(await running).toBe(true);
    expect(w.restarts()).toHaveLength(before);
    expect(w.permits()).toHaveLength(permitsBefore);
    const attempt = w.attempts().at(-1)!;
    const result = w.toolEvents(attempt.id).at(-1)!.payload as unknown as { receipt: { result: string; stdout: { digest: string } } };
    expect(result.receipt.result).toBe("failed");
    expect((w.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(approval.id) as { state: string }).state).toBe("rejected");
  }, scaled(120_000));

  it("does nothing when nobody answers before the approval expires", async () => {
    const w = world ?? (world = await effectsWorld());
    const before = w.restarts().length;
    await w.dispatch("incident-3");
    const running = w.run();
    const approval = await w.pendingApproval();
    w.store.control.prepare("UPDATE approval_requests SET expires_at_ms=? WHERE id=?").run(Date.now() - 1000, approval.id);
    expect(await running).toBe(true);
    expect(w.restarts()).toHaveLength(before);
    expect((w.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(approval.id) as { state: string }).state).toBe("expired");
    expect(w.permits().filter((permit) => permit.approval_id === approval.id)).toEqual([]);
  }, scaled(120_000));
});
