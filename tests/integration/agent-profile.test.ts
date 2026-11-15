import { afterEach, describe, expect, it } from "vitest";
import type { ActivityProfile, TeamMember, UsageView } from "@brain/contracts";
import { DIGEST_A } from "../helpers";
import { closeWorlds, running, startedMission, task, type Offer, type Runner, type World } from "../support/machine-session";

// Agent page and team-member panel (#113): an agent definition's and a mission member's status, recent runs, verified rate and top failure
// classes are worked out from the session, verdict and failure records every time they are read. State is reached through the runner
// protocol and commands; the only seeded rows are the evidence bundles and verdicts a real evaluator run would produce (as finishTask does).
const team: TeamMember[] = [
  { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  { memberId: "reviewer", role: "Reviewer", agentId: "operations-assistant", engine: "fixture" },
];
const assigned = (id: string, memberId: string) => task(id, { assignment: { kind: "agent", id: memberId, role: "specialist" }, ...(memberId === "reviewer" ? { workflowId: "operations-triage" } : {}) });
const read = async <T>(w: World, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: T }).snapshot;
const agentOf = (w: World, id: string) => read<ActivityProfile>(w, "agents.profile", id);
const memberOf = (w: World, missionId: string, id: string) => read<ActivityProfile>(w, "members.profile", `${missionId}:${id}`);
const memberIdOf = (w: World, runner: Runner, offer: Offer): string | undefined => w.brain.jobProtocol.sessionCredential(runner, offer.attemptId).memberId;

function usage(w: World, runner: Runner, offer: Offer, usageEvent: Record<string, unknown>): void {
  const event = { sequence: 1, kind: "engine", payload: { contractVersion: "brain.engine-event/v1", eventId: "e1", sessionId: "s", attemptId: offer.attemptId, sequence: 1, occurredAt: new Date().toISOString(), kind: "usage", payload: usageEvent } };
  w.brain.jobProtocol.events(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", model: "m", adapterDigest: DIGEST_A, features: ["sessions"] }, events: [event] });
}
const end = (w: World, runner: Runner, offer: Offer, result: "succeeded" | "failed", error?: string): void => {
  w.brain.jobProtocol.complete(runner, offer.attemptId, { result, jobFence: offer.jobFence, cleanupConfirmed: true, output: error ? { error } : {} });
  w.brain.jobProtocol.releaseReservation(offer.attemptId);
};
/** What a real evaluator run leaves for an attempt's result: a bundle and its verdict. */
function judged(w: World, attemptId: string, key: string, outcome: "verified" | "rejected" | "incomplete"): void {
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const digest = `sha256:${key.padEnd(64, "0")}`;
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', '{}', ?)").run(digest, `bundle-${key}`, `job-${key}`, attemptId, w.brain.store.now());
  ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms, finalized_at_ms) VALUES (?,?,?,?,?, '{}', ?, ?)").run(`verdict-${key}`, digest, `eval-${key}`, DIGEST_A, outcome, w.brain.store.now(), w.brain.store.now());
}
const rate = (profile: ActivityProfile) => profile.metrics.find((metric) => metric.id === "verified-rate")!;

describe("agent profile and member panel at the Governor seam", () => {
  afterEach(closeWorlds);

  it("works status out from session records, never storing it", async () => {
    const { w, missionId, runner } = await startedMission({ tasks: [assigned("a", "writer"), assigned("b", "reviewer")], team });
    // Nothing has run: idle, and the definition is stated.
    expect(await agentOf(w, "task-worker")).toMatchObject({ scope: "agent", id: "task-worker", status: { state: "idle" }, sessions: { live: 0, total: 0 }, recentRuns: [] });
    expect((await agentOf(w, "task-worker")).status.definition).toMatch(/never stored/u);

    const first = running(w, runner, "one");
    const second = running(w, runner, "two");
    const byMember = new Map([first, second].map((offer) => [memberIdOf(w, runner, offer), offer] as const));
    const writer = byMember.get("writer")!, reviewer = byMember.get("reviewer")!;

    // A running session makes its agent and its member working; the other pair is unaffected.
    const working = await agentOf(w, "task-worker");
    expect(working.status).toMatchObject({ state: "working" });
    expect(working.sessions).toEqual({ live: 1, total: 1 });
    expect(working.recentRuns).toEqual([expect.objectContaining({ state: "running", memberId: "writer", missionId, jobId: writer.jobId })]);
    expect(await memberOf(w, missionId, "writer")).toMatchObject({ scope: "member", memberId: "writer", missionId, status: { state: "working" }, sessions: { live: 1, total: 1 } });
    expect((await agentOf(w, "operations-assistant")).recentRuns[0]).toMatchObject({ memberId: "reviewer" });

    // A failed attempt ends its session: the agent is failing, not working, and nothing was written to say so.
    end(w, runner, writer, "failed", "model is unreachable");
    expect((await agentOf(w, "task-worker")).status).toMatchObject({ state: "failing" });
    expect((await memberOf(w, missionId, "writer")).status.state).toBe("failing");
    // A clean ending makes it idle again, whatever happened before it (the latest ended session decides).
    end(w, runner, reviewer, "succeeded");
    const reviewing = await agentOf(w, "operations-assistant");
    expect(reviewing.status.state).toBe("idle");
    expect(reviewing.sessions).toEqual({ live: 0, total: 1 });
    expect(JSON.stringify(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT name FROM sqlite_master WHERE type='table'").all())).not.toMatch(/agent_status|member_status/u);
  });

  it("counts the verified rate on verdicts, failure classes per run, and takes cost from the ledger", async () => {
    const { w, missionId, runner } = await startedMission({ tasks: [assigned("a", "writer"), assigned("b", "reviewer")], team });
    const first = running(w, runner, "one");
    const second = running(w, runner, "two");
    const byMember = new Map([first, second].map((offer) => [memberIdOf(w, runner, offer), offer] as const));
    const writer = byMember.get("writer")!, reviewer = byMember.get("reviewer")!;
    usage(w, runner, writer, { usageId: "w1", inputTokens: 1000, outputTokens: 100, microUsd: 2500, accounting: "final-total" });
    usage(w, runner, reviewer, { usageId: "r1", inputTokens: 400, outputTokens: 40, microUsd: 700, accounting: "final-total" });
    end(w, runner, writer, "failed", "tool is unavailable");
    end(w, runner, reviewer, "succeeded");

    // No verdict yet: no rate, and the figure says what it counted.
    expect(rate(await agentOf(w, "task-worker"))).toMatchObject({ numerator: 0, denominator: 0, unit: "ratio" });
    expect(rate(await agentOf(w, "task-worker")).value).toBeUndefined();
    expect(rate(await agentOf(w, "task-worker")).definition).toMatch(/independent check/u);

    judged(w, writer.attemptId, "w-rejected", "rejected");
    judged(w, writer.attemptId, "w-verified", "verified");
    judged(w, reviewer.attemptId, "r-verified", "verified");
    expect(rate(await agentOf(w, "task-worker"))).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(rate(await memberOf(w, missionId, "writer"))).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(rate(await memberOf(w, missionId, "reviewer"))).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    // A later verdict on the same result replaces the earlier one: the rate counts the latest verdict per result.
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms, finalized_at_ms) VALUES ('verdict-again', ?, 'eval-again', ?, 'verified', '{}', ?, ?)")
      .run(`sha256:${"w-rejected".padEnd(64, "0")}`, DIGEST_A, w.brain.store.now() + 5, w.brain.store.now() + 5);
    expect(rate(await agentOf(w, "task-worker"))).toMatchObject({ numerator: 2, denominator: 2, value: 1 });

    // A failed run is counted once under the class the Governor stored, in the member and in the agent it belongs to.
    const runId = (ws.prepare("SELECT run_id FROM mission_spend WHERE attempt_id=?").get(writer.attemptId) as { run_id: string }).run_id;
    w.brain.missions.recordRunFailure(w.org, w.workspaceId, runId, "tool is unavailable");
    const classes = (await agentOf(w, "task-worker")).failureClasses;
    expect(classes.definition).toMatch(/failure class/u);
    expect(classes.items).toHaveLength(1);
    expect(classes.items[0]).toMatchObject({ count: 1 });
    expect((await memberOf(w, missionId, "writer")).failureClasses.items).toEqual(classes.items);
    expect((await agentOf(w, "operations-assistant")).failureClasses.items).toEqual([]);
    expect((await memberOf(w, missionId, "reviewer")).failureClasses.items).toEqual([]);

    // The member's tasks come from the plan's assignment; cost is the ledger's own figure through usage.agent and usage.member.
    expect((await memberOf(w, missionId, "writer")).tasks).toEqual([expect.objectContaining({ title: "Task a", parked: expect.any(Boolean) })]);
    expect((await read<UsageView>(w, "usage.agent", "task-worker")).usage).toMatchObject({ settledMicroUsd: 2500, attempts: 1 });
    expect((await read<UsageView>(w, "usage.member", `${missionId}:reviewer`)).usage).toMatchObject({ settledMicroUsd: 700, attempts: 1 });
  });

  it("lists every agent the workspace has seen at work, and refuses a member of nothing", async () => {
    const { w, runner } = await startedMission({ tasks: [assigned("a", "writer"), assigned("b", "reviewer")], team });
    running(w, runner, "one");
    running(w, runner, "two");
    const all = await read<{ items: ActivityProfile[] }>(w, "agents.profile");
    expect(all.items.map((item) => item.id).sort()).toEqual(["operations-assistant", "task-worker"]);
    await expect(w.brain.executeQuery(w.owner, { queryType: "members.profile", workspaceId: w.workspaceId, resourceId: "no-colon" } as never)).rejects.toThrow(/missionId/u);
  });
});
