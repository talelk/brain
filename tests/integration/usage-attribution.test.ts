import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamMember, UsageBreakdown, UsageSummary, UsageView } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, newRunnerControls, runOnce, type RunnerConfig } from "../../apps/runner/src/supervisor";
import { setupWorld, DIGEST_A } from "../helpers";
import { closeWorlds, running, stageStarter, startedMission, task, type Offer, type Runner, type World } from "../support/machine-session";
import { scaled } from "../support/timing";

// Usage is attributed (#111, ADR 0051): every settled ledger row names the team member and agent definition the Governor chose for the
// attempt, and the engine and model the runner reported it ran on. Totals and de-duplication by usage id are unchanged, and each grouping
// of a mission's usage sums to the mission total. State is reached through commands and the runner protocol, never through table writes.
const team: TeamMember[] = [
  { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  { memberId: "reviewer", role: "Reviewer", agentId: "operations-assistant", engine: "fixture" },
];
// The agent a task runs is the one its workflow's step pins: the writer's task uses the default task workflow (task-worker), the reviewer's the triage workflow.
const assigned = (id: string, memberId: string) => task(id, { assignment: { kind: "agent", id: memberId, role: "specialist" }, ...(memberId === "reviewer" ? { workflowId: "operations-triage" } : {}) });
const query = async <T>(w: World, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: T }).snapshot;

const FIELDS: ReadonlyArray<Exclude<keyof UsageSummary, "estimated">> = ["settledMicroUsd", "reservedMicroUsd", "settledTokens", "reservedTokens", "inputTokens", "outputTokens", "cachedInputTokens", "attempts", "openAttempts"];
/** Every grouping covers every ledger row exactly once, so its groups add up to the total on every figure. */
function expectGroupsSumTo(breakdown: UsageBreakdown, total: UsageSummary): void {
  for (const dimension of ["member", "agent", "engine", "model"] as const) {
    const groups = breakdown[dimension] ?? [];
    expect(groups.length, `${dimension} groups`).toBeGreaterThan(0);
    for (const field of FIELDS) expect(groups.reduce((sum, group) => sum + group.usage[field], 0), `${dimension}.${field}`).toBe(total[field]);
    expect(groups.some((group) => group.usage.estimated), `${dimension}.estimated`).toBe(total.estimated);
  }
}

describe("usage attribution at the protocol seam", () => {
  afterEach(closeWorlds);

  /** Reports one attempt's engine, model and usage the way the runner does, then ends the attempt. */
  function report(w: World, runner: Runner, offer: Offer, input: { engine?: { id: string; model?: string }; usage: Array<Record<string, unknown>> }): void {
    const events = input.usage.map((payload, index) => ({ sequence: index + 1, kind: "engine", payload: { contractVersion: "brain.engine-event/v1", eventId: `e${index}`, sessionId: "s", attemptId: offer.attemptId, sequence: index + 1, occurredAt: new Date().toISOString(), kind: "usage", payload } }));
    w.brain.jobProtocol.events(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, ...(input.engine ? { engine: { ...input.engine, adapterDigest: DIGEST_A, features: ["sessions"] } } : {}), events });
    w.brain.jobProtocol.releaseReservation(offer.attemptId);
  }
  const memberOf = (w: World, runner: Runner, offer: Offer): string | undefined => w.brain.jobProtocol.sessionCredential(runner, offer.attemptId).memberId;

  it("stamps each settled row with its member, agent, engine and model; groups sum to the mission total; a replayed usage id counts once", async () => {
    const { w, missionId, runner } = await startedMission({ tasks: [assigned("a", "writer"), assigned("b", "reviewer")], team });
    const first = running(w, runner, "one");
    const second = running(w, runner, "two");
    const byMember = new Map([first, second].map((offer) => [memberOf(w, runner, offer), offer] as const));
    const writer = byMember.get("writer")!, reviewer = byMember.get("reviewer")!;

    // The writer ran on a local model; its incremental report is replayed, so the usage id is counted once.
    report(w, runner, writer, { engine: { id: "pi", model: "qwen-local" }, usage: [
      { usageId: "w1", inputTokens: 1000, outputTokens: 100, microUsd: 0, accounting: "incremental" },
      { usageId: "w1", inputTokens: 1000, outputTokens: 100, microUsd: 0, accounting: "incremental" },
      { usageId: "w2", inputTokens: 500, outputTokens: 50, cachedInputTokens: 25, microUsd: 0, accounting: "incremental" },
    ] });
    // The reviewer's retry ran on the hosted model, and a reviewer's own text claiming another model changes nothing: only the report counts.
    report(w, runner, reviewer, { engine: { id: "claude", model: "acme-hosted" }, usage: [{ usageId: "r1", inputTokens: 2000, outputTokens: 400, microUsd: 3000, accounting: "final-total" }] });

    const view = await query<UsageView>(w, "usage.mission", missionId);
    // Totals are what they were before attribution: the replayed id is counted once.
    expect(view.usage).toMatchObject({ settledMicroUsd: 3000, inputTokens: 3500, outputTokens: 550, cachedInputTokens: 25, attempts: 2, openAttempts: 0 });
    expect(view.breakdown).toBeDefined();
    expectGroupsSumTo(view.breakdown!, view.usage);

    expect(view.breakdown!.member).toEqual([
      { source: "attempt", id: "reviewer", usage: expect.objectContaining({ settledMicroUsd: 3000, inputTokens: 2000 }) },
      { source: "attempt", id: "writer", usage: expect.objectContaining({ settledMicroUsd: 0, inputTokens: 1500, outputTokens: 150, cachedInputTokens: 25 }) },
    ]);
    expect(view.breakdown!.agent!.map((group) => group.id).sort()).toEqual(["operations-assistant", "task-worker"]);
    expect(view.breakdown!.engine!.map((group) => group.id).sort()).toEqual(["claude", "pi"]);
    expect(view.breakdown!.model!.map((group) => group.id).sort()).toEqual(["acme-hosted", "qwen-local"]);

    // The run view carries the same attribution on each attempt, from the same ledger rows.
    const runId = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT run_id FROM mission_spend WHERE attempt_id=?").get(writer.attemptId) as { run_id: string }).run_id;
    expect((await query<UsageView>(w, "usage.run", runId)).attemptRows).toEqual([expect.objectContaining({ attemptId: writer.attemptId, source: "attempt", memberId: "writer", agentId: "task-worker", engine: "pi", model: "qwen-local", settled: true })]);

    // The agent and member scopes read the same ledger: one agent across the workspace, one member of one mission.
    const agent = await query<UsageView>(w, "usage.agent", "task-worker");
    expect(agent).toMatchObject({ scope: "agent", id: "task-worker", usage: { inputTokens: 1500, attempts: 1 } });
    expect(agent.breakdown!.model).toEqual([{ source: "attempt", id: "qwen-local", usage: expect.objectContaining({ inputTokens: 1500 }) }]);
    const member = await query<UsageView>(w, "usage.member", `${missionId}:reviewer`);
    expect(member).toMatchObject({ scope: "member", id: `${missionId}:reviewer`, usage: { settledMicroUsd: 3000, attempts: 1 } });
    expect(member.breakdown!.agent).toEqual([{ source: "attempt", id: "operations-assistant", usage: expect.objectContaining({ settledMicroUsd: 3000 }) }]);
    // Workspace totals are unchanged by any of this.
    expect((await query<UsageView>(w, "usage.workspace")).usage).toMatchObject({ settledMicroUsd: 3000, inputTokens: 3500, attempts: 2 });
  });

  it("leaves engine and model unattributed when the runner reported none, and an attempt that is still running shows what it has reported", async () => {
    const { w, missionId, runner } = await startedMission({ tasks: [assigned("a", "writer"), assigned("b", "reviewer")], team });
    const silent = running(w, runner, "silent");
    const live = running(w, runner, "live");
    report(w, runner, silent, { usage: [{ usageId: "s1", inputTokens: 40, outputTokens: 10, microUsd: 0, accounting: "final-total" }] });

    // The second attempt has reported its engine and model but has not finished: its row is not settled, yet the run view already names them.
    w.brain.jobProtocol.events(runner, live.attemptId, { leaseId: live.leaseId, jobFence: live.jobFence, engine: { id: "pi", model: "qwen-local", adapterDigest: DIGEST_A, features: [] }, events: [] });
    const runId = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT run_id FROM mission_spend WHERE attempt_id=?").get(live.attemptId) as { run_id: string }).run_id;
    expect((await query<UsageView>(w, "usage.run", runId)).attemptRows).toEqual([expect.objectContaining({ attemptId: live.attemptId, settled: false, engine: "pi", model: "qwen-local" })]);

    const view = await query<UsageView>(w, "usage.mission", missionId);
    // Nothing is filled in for the silent attempt: its group has no id, and no placeholder name appears anywhere.
    expect(view.breakdown!.engine).toEqual(expect.arrayContaining([{ source: "attempt", usage: expect.objectContaining({ attempts: 2, openAttempts: 1, inputTokens: 40 }) }]));
    expect(JSON.stringify(view)).not.toMatch(/unknown|"fixture"/u);
    expectGroupsSumTo(view.breakdown!, view.usage);
    // The first row to report keeps what it reported: a later, different claim does not rewrite the attempt's attribution.
    w.brain.jobProtocol.events(runner, live.attemptId, { leaseId: live.leaseId, jobFence: live.jobFence, engine: { id: "claude", model: "another", adapterDigest: DIGEST_A, features: [] }, events: [] });
    w.brain.jobProtocol.releaseReservation(live.attemptId);
    const settled = await query<UsageView>(w, "usage.mission", missionId);
    expect(settled.breakdown!.model!.map((group) => group.id)).toEqual(expect.arrayContaining(["qwen-local"]));
    expect(settled.breakdown!.model!.map((group) => group.id)).not.toContain("another");
  });
});

describe("usage attribution from a real runner", () => {
  const savedModel = process.env["BRAIN_LOCAL_MODEL_ID"];
  let root: string; let app: Awaited<ReturnType<typeof createApp>>;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "brain-attribution-")); });
  afterEach(async () => {
    if (savedModel === undefined) delete process.env["BRAIN_LOCAL_MODEL_ID"]; else process.env["BRAIN_LOCAL_MODEL_ID"] = savedModel;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("takes the engine and model from what the runner reports for the attempt, and the agent and member from the pinned job", async () => {
    process.env["BRAIN_LOCAL_MODEL_ID"] = "qwen-local-test";
    app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    const w = setupWorld(app.brain);
    stageStarter(w);
    const command = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) => (await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
    } as never, key)).receipt;
    const missionId = (await command("mission.create", "create", { title: "Attribution", intent: "Check who spent", successCriteria: ["done"] })).resourceId ?? "";
    const planId = (await command("plan.propose", "plan", { missionId, origin: "manual", tasks: [assigned("a", "writer"), assigned("b", "reviewer")], team })).resourceId ?? "";
    const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: missionId })) as unknown as { snapshot: { version: number } }).snapshot.version;
    await command("plan.confirm", "confirm", { planVersionId: planId }, version);

    const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    const cfg: RunnerConfig = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-attribution", stateDir: join(root, "runner"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
    const session = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, "agents").token);
    const controls = newRunnerControls();
    expect(await runOnce(cfg, () => session.sessionToken, session.epoch, controls)).toBe(true);
    expect(await runOnce(cfg, () => session.sessionToken, session.epoch, controls)).toBe(true);
    // The runner's attempts end and release their capacity as the supervisor finishes them.
    const deadline = Date.now() + 20_000;
    let view = await query<UsageView>(w, "usage.mission", missionId);
    while (view.usage.openAttempts > 0 && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 50)); view = await query<UsageView>(w, "usage.mission", missionId); }

    expect(view.usage).toMatchObject({ attempts: 2, openAttempts: 0 });
    expect(view.breakdown!.member!.map((group) => group.id).sort()).toEqual(["reviewer", "writer"]);
    expect(view.breakdown!.agent!.map((group) => group.id).sort()).toEqual(["operations-assistant", "task-worker"]);
    expect(view.breakdown!.engine).toEqual([{ source: "attempt", id: "fixture", usage: expect.objectContaining({ attempts: 2 }) }]);
    expect(view.breakdown!.model).toEqual([{ source: "attempt", id: "qwen-local-test", usage: expect.objectContaining({ attempts: 2 }) }]);
    expectGroupsSumTo(view.breakdown!, view.usage);
  }, scaled(60_000));
});
