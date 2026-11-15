import { rmSync } from "node:fs";
import { approvalSubjectDigest } from "@brain/contracts";
import type { ApprovalRequest, JsonValue } from "@brain/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { PROPOSAL, missionWithTask, pullRequestWorld } from "../support/pull-request-world";
import { scaled } from "../support/timing";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const view = async (world: EffectsWorld, approvalId: string): Promise<ApprovalRequest> =>
  ((await world.w.brain.executeQuery(world.w.owner, { queryType: "approval.get", workspaceId: world.w.workspaceId, resourceId: approvalId })) as unknown as { snapshot: ApprovalRequest }).snapshot;

const listed = async (world: EffectsWorld, approvalId: string): Promise<ApprovalRequest | undefined> =>
  ((await world.w.brain.executeQuery(world.w.owner, { queryType: "approvals.list", workspaceId: world.w.workspaceId })) as unknown as { snapshot: { items: ApprovalRequest[] } }).snapshot.items.find((item) => item.approvalId === approvalId);

/** Why a command was refused, in the funnel's own words. */
const refusal = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); } };

describe("an approval says which mission, task and run it belongs to, shows the change as a diff and names its rollback (#120, ADR 0048)", () => {
  it("binds the run, task and mission of the proposing task, and reads their titles, the diff and the declared rollback beside the subject", async () => {
    const { world } = await pullRequestWorld(cleanup);
    const { missionId, workItemId } = await missionWithTask(world);
    await world.dispatch("ctx-1", [PROPOSAL], { workItemId });
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();

    const approval = await view(world, pending.id);
    // The run of the task that proposed the call (a task may have been started more than once; the call belongs to the run that made it).
    const runId = (world.store.control.prepare("SELECT workflow_run_id FROM jobs WHERE id=?").get(world.calls()[0]!.parent_job_id) as { workflow_run_id: string }).workflow_run_id;
    // The subject carries the references (what the approver is bound to); the titles are only looked up.
    expect(approval.subject.origin).toEqual({ runId, workItemId, missionId });
    expect(approval.context).toMatchObject({ runId, mission: { missionId, title: "Raise the memory limit" }, workItem: { workItemId, title: "Open the pull request" } });
    expect(JSON.stringify(approval.subject)).not.toContain("Raise the memory limit");
    expect(JSON.stringify(approval.subject)).not.toContain("Open the pull request");
    // The digest is the digest of the subject alone: reading context beside it, or listing, does not move it.
    expect(approval.subjectDigest).toBe(pending.subject_digest);
    expect(approvalSubjectDigest(approval.subject as unknown as JsonValue)).toBe(approval.subjectDigest);
    expect((await listed(world, pending.id))?.context).toEqual(approval.context);

    // The change is the files that would be committed, as a unified diff, not JSON.
    expect(approval.context?.change).toEqual({
      files: [{ path: "docs/demo-app/limits.md", lines: 1, bytes: 13 }],
      diff: "+++ b/docs/demo-app/limits.md\n@@ whole file, 1 line @@\n+memory: 768m",
    });
    // The Tool document declares what undoes it.
    expect(approval.context?.rollback).toEqual({ declared: true, action: expect.stringContaining("Close the pull request") });
  }, scaled(180_000));

  it("keeps the approval single-use and bound to its digest after context is read: one permit, one run, and a second decision is refused", async () => {
    const { world } = await pullRequestWorld(cleanup);
    const { workItemId } = await missionWithTask(world);
    await world.dispatch("ctx-2", [PROPOSAL], { workItemId });
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    const before = await view(world, pending.id);
    await world.decide(pending, "approve");
    await world.drain();

    const after = await view(world, pending.id);
    expect(after.state).toBe("approved");
    expect(after.subjectDigest).toBe(before.subjectDigest);
    expect(after.context).toEqual(before.context);
    expect(world.permits().filter((permit) => permit.approval_id === pending.id)).toHaveLength(1);
    expect(world.permits().at(-1)!.state).toBe("applied");
    // Deciding again spends nothing: the approval is not pending any more.
    expect(await refusal(() => world.decide({ ...pending, version: after.version }, "approve"))).not.toBe("");
    expect(world.permits().filter((permit) => permit.approval_id === pending.id)).toHaveLength(1);
  }, scaled(180_000));

  it("names only the run when the task serves no work item, and says plainly when no rollback is declared and no files are committed", async () => {
    const world = await effectsWorld();
    cleanup.push(() => rmSync(world.root, { recursive: true, force: true }));
    await world.dispatch("ctx-3");
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    const approval = await view(world, pending.id);
    expect(approval.subject.operation).toBe("effect.host.restart");
    expect(approval.subject.origin).toEqual({ runId: expect.stringMatching(/^run/u) });
    expect(approval.context?.mission).toBeUndefined();
    expect(approval.context?.workItem).toBeUndefined();
    expect(approval.context?.change).toBeUndefined();
    expect(approval.context?.rollback).toEqual({ declared: false });
  }, scaled(120_000));

  it("refuses a caller-built subject whose origin the Governor's own links do not support", async () => {
    const { world } = await pullRequestWorld(cleanup);
    const { missionId, workItemId } = await missionWithTask(world);
    await world.dispatch("ctx-4", [PROPOSAL], { workItemId });
    expect(await world.run()).toBe(true);
    const pending = await world.pendingApproval();
    const subject = (await view(world, pending.id)).subject;
    const real = subject.origin!;
    const ask = (key: string, origin: Record<string, string>) => () => world.command("approval.request", key, { subject: { ...subject, nonce: key, origin } });
    expect(await refusal(ask("forged-mission", { runId: real.runId, workItemId: real.workItemId!, missionId: "mis_someone_else" }))).toContain("does not serve");
    expect(await refusal(ask("forged-run", { runId: "run_nothing" }))).toContain("run this workspace does not have");
    expect(await refusal(ask("dropped-task", { runId: real.runId }))).toContain("does not serve");
    // The origin the links support is accepted, and reads back with its titles.
    const accepted = await world.command("approval.request", "true-origin", { subject: { ...subject, nonce: "true-origin", origin: { runId: real.runId, workItemId: real.workItemId!, missionId } } });
    expect((await view(world, accepted.resourceId!)).context?.mission?.missionId).toBe(missionId);
  }, scaled(180_000));
});
