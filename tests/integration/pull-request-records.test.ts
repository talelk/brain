import type { PullRequest } from "@brain/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { EffectsWorld } from "../support/effects-world";
import { PROPOSAL, TOKEN, missionWithTask, pullRequestWorld } from "../support/pull-request-world";
import { scaled } from "../support/timing";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const records = async (world: EffectsWorld, resourceId: string): Promise<PullRequest[]> =>
  ((await world.w.brain.executeQuery(world.w.owner, { queryType: "pullRequests.list", workspaceId: world.w.workspaceId, resourceId })) as unknown as { snapshot: { items: PullRequest[] } }).snapshot.items;

/** Proposes, approves and runs one pull request for a work item; returns the approval it came from. */
async function openFor(world: EffectsWorld, workItemId: string | undefined, key: string): Promise<{ id: string }> {
  await world.dispatch(key, [PROPOSAL], workItemId ? { workItemId } : {});
  expect(await world.run()).toBe(true);
  const approval = await world.pendingApproval();
  await world.decide(approval, "approve");
  await world.drain();
  return approval;
}

describe("a pull request is a record on its work item (#121, ADR 0044)", () => {
  it("is kept once the approved call opened it: URL, provider, state when opened, the approval it came from; shown by work item and by approval, with no token", async () => {
    const { world, remote, connectionId } = await pullRequestWorld(cleanup);
    const { missionId, workItemId } = await missionWithTask(world);
    expect(await records(world, workItemId)).toEqual([]);

    await world.dispatch("prr-1", [PROPOSAL], { workItemId });
    expect(await world.run()).toBe(true);
    const approval = await world.pendingApproval();
    // Proposed is not opened: nothing is recorded until the approved call has run.
    expect(await records(world, workItemId)).toEqual([]);
    await world.decide(approval, "approve");
    await world.drain();

    const [record] = await records(world, workItemId);
    expect(record).toMatchObject({
      approvalId: approval.id, workItemId, missionId, provider: "github-enterprise", repository: remote.remote, number: 7, url: "https://git.example.test/demo/pull/7",
      title: "Raise the demo-app memory limit", branch: "brain/raise-demo-app-memory", base: "main", state: "open",
    });
    expect(record!.runId).toBeTruthy();
    expect(record!.observations).toHaveLength(1);
    expect(record!.observations[0]).toMatchObject({ state: "open", source: "opened" });
    expect(record!.observations[0]!.observedBy).toBeUndefined();
    // The same record is found from the approval, which is where its history is read.
    expect(await records(world, approval.id)).toEqual([record]);
    expect(world.store.workspaceDb(world.w.workspaceId, world.w.org).prepare("SELECT connection_id FROM pull_requests").get()).toEqual({ connection_id: connectionId });

    // The approval's history says it, in a sentence a person can read.
    const audit = ((await world.w.brain.executeQuery(world.w.owner, { queryType: "audit.list", workspaceId: world.w.workspaceId })) as unknown as { snapshot: { items: Array<{ action: string; resourceId: string; message?: string }> } }).snapshot.items;
    expect(audit.find((entry) => entry.action === "pullRequest.opened")).toMatchObject({ resourceId: approval.id, message: "A pull request was opened: https://git.example.test/demo/pull/7" });

    // No secret reaches the record or its events.
    const ws = world.store.workspaceDb(world.w.workspaceId, world.w.org);
    const dump = JSON.stringify([ws.prepare("SELECT * FROM pull_requests").all(), ws.prepare("SELECT * FROM pull_request_states").all(), world.store.control.prepare("SELECT payload_json FROM events WHERE event_type LIKE 'pullRequest.%'").all()]);
    expect(dump).not.toContain(TOKEN);
  }, scaled(180_000));

  it("is written once per approval and never edited: a repeated write changes nothing and the stored rows refuse edits", async () => {
    const { world } = await pullRequestWorld(cleanup);
    const { workItemId } = await missionWithTask(world);
    const approval = await openFor(world, workItemId, "prr-once");
    const before = await records(world, workItemId);
    expect(before).toHaveLength(1);
    const db = world.store.workspaceDb(world.w.workspaceId, world.w.org);
    const opened = { url: "https://elsewhere.example.test/pull/99", number: 99, branch: "other", base: "main", commit: "0".repeat(40), provider: "gitlab" as const, connectionId: "other", repositoryKey: "https://elsewhere.example.test/o/r" };
    const { recordPullRequest } = await import("../../apps/governor/src/modules/missions/index");
    expect(recordPullRequest(world.store, db, { organizationId: world.w.org, workspaceId: world.w.workspaceId, approvalId: approval.id, invocationId: `inv-${approval.id}`, runId: undefined, opened, title: "Replacement" })).toMatchObject({ created: false });
    expect(await records(world, workItemId)).toEqual(before);
    expect(() => db.prepare("UPDATE pull_requests SET url='https://evil.example.test/' WHERE approval_id=?").run(approval.id)).toThrow(/never edited/u);
    expect(() => db.prepare("DELETE FROM pull_requests").run()).toThrow(/never removed/u);
    expect(() => db.prepare("UPDATE pull_request_states SET state='merged'").run()).toThrow(/never edited/u);
    expect(() => db.prepare("DELETE FROM pull_request_states").run()).toThrow(/never removed/u);
  }, scaled(180_000));

  it("a refresh asks the provider and adds an observation; the state when opened stays, and nothing is added to the history unless the state moved", async () => {
    const { world, provider } = await pullRequestWorld(cleanup);
    const { workItemId } = await missionWithTask(world);
    const approval = await openFor(world, workItemId, "prr-refresh");
    const [opened] = await records(world, workItemId);
    const eventsOf = () => world.store.control.prepare("SELECT payload_json FROM events WHERE event_type='pullRequest.stateObserved' ORDER BY cursor").all().map((row) => JSON.parse((row as { payload_json: string }).payload_json) as { state: string; message: string; actorId: string });

    // Still open at the provider: an observation, but no change worth saying in the history.
    const same = await world.command("pullRequest.refresh", "prr-r1", { pullRequestId: opened!.pullRequestId });
    expect(same.accepted).toBe(true);
    expect((await records(world, workItemId))[0]).toMatchObject({ state: "open" });
    expect(eventsOf()).toEqual([]);

    // Merged at the provider (GitHub says closed + merged).
    provider.state = "closed"; provider.merged = true;
    await world.command("pullRequest.refresh", "prr-r2", { pullRequestId: opened!.pullRequestId });
    const [merged] = await records(world, workItemId);
    expect(merged).toMatchObject({ state: "merged", url: opened!.url, approvalId: approval.id });
    expect(merged!.observations.map((entry) => [entry.state, entry.source])).toEqual([["open", "opened"], ["open", "refresh"], ["merged", "refresh"]]);
    expect(merged!.observations[2]!.observedBy).toBe(world.w.owner.actorId);
    // The first observation is what it was when the request was opened, to the byte.
    expect(merged!.observations[0]).toEqual(opened!.observations[0]);
    expect(eventsOf().map((event) => [event.state, event.actorId])).toEqual([["merged", world.w.owner.actorId]]);
    expect(eventsOf()[0]!.message).toBe(`The pull request is now merged: ${opened!.url}`);
    expect(provider.calls.filter((call) => call.startsWith("GET"))).toHaveLength(2);
    expect(provider.calls.at(-1)).toMatch(/\/api\/v3\/repos\/repo\/pulls\/7$/u);

    // Closed without merging.
    provider.merged = false;
    await world.command("pullRequest.refresh", "prr-r3", { pullRequestId: opened!.pullRequestId });
    expect((await records(world, approval.id))[0]).toMatchObject({ state: "closed" });
  }, scaled(180_000));

  it("a pull request for a run that serves no work item is still kept, and found from its approval", async () => {
    const { world } = await pullRequestWorld(cleanup);
    const approval = await openFor(world, undefined, "prr-standalone");
    const [record] = await records(world, approval.id);
    expect(record).toMatchObject({ approvalId: approval.id, state: "open", url: "https://git.example.test/demo/pull/7" });
    expect(record!.workItemId).toBeUndefined();
    expect(record!.missionId).toBeUndefined();
  }, scaled(180_000));

  it("refuses a refresh it cannot answer, in plain words, and records nothing: an unknown request, a connection that no longer verifies", async () => {
    const { world, remote, provider } = await pullRequestWorld(cleanup);
    const { workItemId } = await missionWithTask(world);
    await openFor(world, workItemId, "prr-refuse");
    const [opened] = await records(world, workItemId);
    const rejection = async (key: string, pullRequestId: string): Promise<string> => { try { await world.command("pullRequest.refresh", key, { pullRequestId }); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); } };
    expect(await rejection("prr-x1", "pr-unknown")).toMatch(/pull request not found/u);

    // The remote goes away and the connection is checked again: it no longer verifies, so Brain does not read from it.
    await remote.cleanup();
    const connection = world.store.control.prepare("SELECT id FROM git_connections").get() as { id: string };
    await world.w.brain.executeCommand(world.w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-prr-verify", commandType: "integration.verify", idempotencyKey: "prr-verify", payload: { connectionId: connection.id } } as never, "prr-verify");
    await world.w.brain.integrations.verifyPending();
    provider.calls.length = 0;
    expect(await rejection("prr-x2", opened!.pullRequestId)).toMatch(/not verified/u);
    expect(provider.calls).toEqual([]);
    expect((await records(world, workItemId))[0]!.observations).toHaveLength(1);
  }, scaled(180_000));
});
