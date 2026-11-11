import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, JsonValue, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { ownBundleJob } from "../support/evidence";
import { setupWorld, DIGEST_A } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { scaled } from "../support/timing";

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const db = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
const item = (w: World, missionId: string) => {
  const row = db(w).prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string };
  return w.brain.missions.query(w.owner, "workItems.get", w.workspaceId, row.id) as unknown as WorkItem;
};
const challenges = async (w: World, workItemId: string) =>
  ((await w.brain.executeQuery(w.owner, { queryType: "challenges.list", workspaceId: w.workspaceId, resourceId: workItemId })) as unknown as { snapshot: { items: Array<{ challengeId: string; state: string; claims: Array<{ text: string }>; summary?: string; reason?: string; runId?: string; independence: string }> } }).snapshot.items;

/** The starter release plus the general task workflow without its evaluator step, so a test can finish the work run by itself. */
function world(): World {
  const w = setupWorld();
  const bundle = fixtureStarter();
  const source = bundle.documents.find((doc) => doc.path.endsWith("general-task.yaml"))!;
  const workflow = JSON.parse(source.text);
  workflow.metadata.id = "general-single";
  delete workflow.spec.jobs["validate"];
  workflow.spec.outputs["passed"] = { source: "literal", value: true };
  bundle.documents.push({ path: "config/general-single.yaml", text: JSON.stringify(workflow, null, 2) + "\n" });
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  worlds.push(w);
  return w;
}

const DELIVERABLE = `# Churn findings\n\n## Findings\n\n${"Pricing confusion drove most cancellations, ahead of slow onboarding and missing integrations. ".repeat(3)}\n\n## Assumptions\n\nThe export covers the whole quarter.`;
const report = (criteria: string[]) => ({
  summary: "Pricing confusion drove most churn.", deliverable: DELIVERABLE, assumptions: ["The export covers the whole quarter"],
  criteria: criteria.map((criterion) => ({ criterion, met: true, evidence: "The Findings section covers this point in detail." })),
});

function seedVerified(w: World, digest: string, jobId: string): void {
  const manifest = {
    contractVersion: "brain.evidence/v1", bundleId: `bundle-${digest.slice(7, 12)}`, organizationId: w.org, workspaceId: w.workspaceId,
    workflowRunId: "run-seed", jobId, attemptId: "att-seed", jobFence: 1, sourceRevision: "r", configDigest: DIGEST_A, workflowDigest: DIGEST_A,
    primitiveVersions: {}, toolReleases: [], artifacts: [], checks: ["structure", "safety", "deliverable", "criteria-met"].map((id) => ({ criterionId: id, checkId: id, status: "passed", oracleDigest: DIGEST_A, artifacts: [], detail: "seeded" })),
    approvalIds: [], effects: [], createdAt: new Date().toISOString(),
  };
  db(w).prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)").run(digest, manifest.bundleId, jobId, "att-seed", JSON.stringify(manifest), w.brain.store.now());
  db(w).prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', ?,?)")
    .run(`verdict-${digest.slice(7, 12)}`, digest, "eval-seed", DIGEST_A, JSON.stringify({ checks: [], acceptedBy: "owner-1" }), w.brain.store.now());
}

async function untilTrue(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

/** A mission whose only task is finished and verified, with its written deliverable stored as the run's output. */
async function finishedTask(w: World): Promise<{ missionId: string; workItem: WorkItem }> {
  const task: PlanTask = { id: "a", title: "Analyse churn", criteria: ["causes are named", "assumptions are stated"], dependsOn: [], workflowId: "general-single" };
  const missionId = (await run(w, "mission.create", "m-create", { title: "Churn", intent: "Analyse churn", successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", "m-plan", { missionId, origin: "manual", tasks: [task] })).resourceId ?? "";
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: missionId })) as unknown as { snapshot: Mission }).snapshot.version;
  await run(w, "plan.confirm", "m-confirm", { planVersionId: planId }, version);
  const started = item(w, missionId);
  const runId = (db(w).prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").get(started.workItemId) as { run_id: string }).run_id;
  seedVerified(w, `sha256:${"a".repeat(64)}`, "job-seed-a");
  ownBundleJob(db(w), started.workItemId, "job-seed-a", w.brain.store.now());
  await untilTrue(() => Boolean(w.brain.store.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(runId)));
  w.brain.workflows.completeStep(w.org, w.workspaceId, runId, "respond", report(started.criteria as string[]) as unknown as JsonValue, true);
  await untilTrue(() => item(w, missionId).state === "done");
  return { missionId, workItem: item(w, missionId) };
}

/** Everything a challenge must leave alone, as one comparable value. */
const governance = (w: World, workItemId: string, missionId: string) => JSON.stringify({
  item: db(w).prepare("SELECT state, evidence_digest, version, failed_attempts, parked FROM work_items WHERE id=?").get(workItemId),
  mission: db(w).prepare("SELECT state, version, outcome FROM missions WHERE id=?").get(missionId),
  verdicts: db(w).prepare("SELECT COUNT(*) AS n FROM verification_verdicts").get(),
  bundles: db(w).prepare("SELECT COUNT(*) AS n FROM mission_evidence_bundles").get(),
  links: db(w).prepare("SELECT COUNT(*) AS n FROM execution_links WHERE work_item_id=?").get(workItemId),
});

describe("Challenge this result (#50, ADR 0012)", () => {
  it("runs an independent reviewer through the governed path, stores its findings as claims and leaves verdicts, state and evidence untouched", async () => {
    const w = world();
    const { missionId, workItem } = await finishedTask(w);
    const before = governance(w, workItem.workItemId, missionId);

    const receipt = await run(w, "result.challenge", "challenge-1", { workItemId: workItem.workItemId });
    expect(receipt.accepted).toBe(true);
    await w.brain.challenges.sweep();
    const [started] = await challenges(w, workItem.workItemId);
    expect(started).toMatchObject({ state: "running", independence: "L1" });
    // An ordinary run of the general task workflow, bound to no work item, whose brief quotes the result as data.
    const runInput = db(w).prepare("SELECT input_json, workflow_json FROM run_inputs WHERE run_id=?").get(started!.runId) as { input_json: string; workflow_json: string };
    expect((JSON.parse(runInput.workflow_json) as { metadata: { id: string } }).metadata.id).toBe("general-task");
    const situation = (JSON.parse(runInput.input_json) as { situation: string }).situation;
    expect(situation).toContain('Challenge the result of the task "Analyse churn"');
    expect(situation).toContain("unsupported, wrong, unclear or missing evidence");
    expect(situation).toContain("> ## Findings");
    expect(db(w).prepare("SELECT COUNT(*) AS n FROM execution_links WHERE run_id=?").get(started!.runId)).toEqual({ n: 0 });
    // One challenge in flight per result.
    await expect(run(w, "result.challenge", "challenge-2", { workItemId: workItem.workItemId })).rejects.toThrow("already in progress");

    // The reviewer's run finishes: its written answer becomes claims.
    db(w).prepare("UPDATE workflow_runs SET state='succeeded' WHERE id=?").run(started!.runId);
    db(w).prepare("INSERT INTO step_outputs(run_id, step_id, output_json) VALUES (?,?,?)").run(started!.runId, "respond", JSON.stringify({
      summary: "Two points need evidence.", assumptions: [], criteria: [],
      deliverable: "# Review\n\n- The claim that pricing confusion came first has no figure behind it.\n- The export period is assumed, not shown.\n\nNothing else stood out.",
    }));
    await w.brain.challenges.sweep();
    const [done] = await challenges(w, workItem.workItemId);
    expect(done).toMatchObject({ state: "done", summary: "Two points need evidence." });
    expect(done!.claims.map((claim) => claim.text)).toEqual(["The claim that pricing confusion came first has no figure behind it.", "The export period is assumed, not shown."]);
    expect(governance(w, workItem.workItemId, missionId)).toBe(before);
  }, scaled(60_000));

  it("a failed reviewer run says so and changes nothing; a new challenge may follow", async () => {
    const w = world();
    const { missionId, workItem } = await finishedTask(w);
    const before = governance(w, workItem.workItemId, missionId);
    await run(w, "result.challenge", "challenge-f1", { workItemId: workItem.workItemId });
    await w.brain.challenges.sweep();
    const [running] = await challenges(w, workItem.workItemId);
    db(w).prepare("UPDATE workflow_runs SET state='failed' WHERE id=?").run(running!.runId);
    await w.brain.challenges.sweep();
    const [failed] = await challenges(w, workItem.workItemId);
    expect(failed).toMatchObject({ state: "failed", reason: "the reviewer run failed", claims: [] });
    expect(governance(w, workItem.workItemId, missionId)).toBe(before);
    expect((await run(w, "result.challenge", "challenge-f2", { workItemId: workItem.workItemId })).accepted).toBe(true);
  }, scaled(60_000));

  it("honours the workspace spend cap like every other model run", async () => {
    const w = world();
    const { workItem } = await finishedTask(w);
    await run(w, "workspace.spendCap.set", "cap-1", { dailyMicroUsd: 0 });
    await expect(run(w, "result.challenge", "capped", { workItemId: workItem.workItemId })).rejects.toThrow(/spend cap is reached/u);
    expect(await challenges(w, workItem.workItemId)).toEqual([]);
  }, scaled(60_000));

  it("refuses a task that is not finished and a task without a written result", async () => {
    const w = world();
    const task: PlanTask = { id: "a", title: "Not done yet", criteria: ["x"], dependsOn: [] };
    const missionId = (await run(w, "mission.create", "n-create", { title: "N", intent: "N", successCriteria: ["delivered"] })).resourceId ?? "";
    const planId = (await run(w, "plan.propose", "n-plan", { missionId, origin: "manual", tasks: [task] })).resourceId ?? "";
    const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: missionId })) as unknown as { snapshot: Mission }).snapshot.version;
    await run(w, "plan.confirm", "n-confirm", { planVersionId: planId }, version);
    const open = item(w, missionId);
    await expect(run(w, "result.challenge", "n-challenge", { workItemId: open.workItemId })).rejects.toThrow("only a finished task's result can be challenged");
    expect(await challenges(w, open.workItemId)).toEqual([]);
  }, scaled(60_000));
});

function seedAgentRunner(w: World, runnerId: string) {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'agents', 'k', 'enabled', 'healthy', ?, 1, ?, 16000, 32768, 40960, 4)`).run(runnerId, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-feature:fixture:sessions"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(runnerId, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId, epoch: 1, organizationId: w.org };
}
const missionUsage = async (w: World, missionId: string) => ((await w.brain.executeQuery(w.owner, { queryType: "usage.mission", workspaceId: w.workspaceId, resourceId: missionId } as never)) as unknown as { snapshot: { usage: Record<string, number> } }).snapshot.usage;

describe("a challenge is charged to the mission it reviews (row 39)", () => {
  it("writes the reviewer's attempts to the mission ledger and counts them against the mission's budget", async () => {
    const w = world();
    const { missionId, workItem } = await finishedTask(w);
    const before = await missionUsage(w, missionId);
    await run(w, "result.challenge", "ledger-1", { workItemId: workItem.workItemId });
    await w.brain.challenges.sweep();
    const [started] = await challenges(w, workItem.workItemId);
    // Found by its execution key even before the challenge row learns the run id, and charged to the mission it reviews.
    expect(w.brain.missions.admission(w.org, w.workspaceId, started!.runId!)).toMatchObject({ missionId, admitted: true });
    const runner = seedAgentRunner(w, "runner-challenge");
    const offer = w.brain.jobProtocol.claim(runner, "req-challenge-1") as unknown as { jobId: string; attemptId: string } | null;
    expect(offer, "the reviewer's job is offered to a runner").not.toBeNull();
    const row = db(w).prepare("SELECT mission_id, run_id FROM mission_spend WHERE attempt_id=?").get(offer!.attemptId) as { mission_id: string; run_id: string } | undefined;
    expect(row).toEqual({ mission_id: missionId, run_id: started!.runId });
    // The attempt reports its usage and releases its capacity: the mission's usage grows by exactly that.
    w.brain.store.control.prepare("INSERT INTO attempt_events(attempt_id, seq, event_json) VALUES (?,?,?)").run(offer!.attemptId, 1, JSON.stringify({ kind: "engine", payload: { kind: "usage", payload: { microUsd: 4200, accounting: "final-total", inputTokens: 300, outputTokens: 50 } } }));
    w.brain.jobProtocol.releaseReservation(offer!.attemptId);
    w.brain.missions.admission(w.org, w.workspaceId, started!.runId!);
    const after = await missionUsage(w, missionId);
    expect(Number(after["settledMicroUsd"]) - Number(before["settledMicroUsd"])).toBe(4200);
    expect(Number(after["settledTokens"]) - Number(before["settledTokens"])).toBe(350);
  }, scaled(60_000));

  it("refuses a challenge once the mission's budget is spent, says so plainly, and stops a run that was waiting for budget", async () => {
    const w = world();
    const { missionId, workItem } = await finishedTask(w);
    // The mission has spent everything it was allowed.
    db(w).prepare("UPDATE missions SET budget_micro_usd=1000, final_allowance_micro_usd=0 WHERE id=?").run(missionId);
    db(w).prepare("INSERT INTO mission_spend(attempt_id, mission_id, run_id, reserved_micro_usd, settled_micro_usd, created_at_ms, settled_at_ms) VALUES ('att-spent', ?, 'run-spent', 0, 1000, ?, ?)").run(missionId, w.brain.store.now(), w.brain.store.now());
    await expect(run(w, "result.challenge", "broke-1", { workItemId: workItem.workItemId })).rejects.toThrow(/mission's budget is spent/u);
    expect(await challenges(w, workItem.workItemId)).toEqual([]);

    // A budget that runs out after the request: the run waits, the person is told, and the run is cancelled so it cannot spend later.
    db(w).prepare("UPDATE missions SET budget_micro_usd=10000000 WHERE id=?").run(missionId);
    await run(w, "result.challenge", "broke-2", { workItemId: workItem.workItemId });
    await w.brain.challenges.sweep();
    const [running] = await challenges(w, workItem.workItemId);
    expect(running!.state).toBe("running");
    db(w).prepare("UPDATE missions SET budget_micro_usd=1000 WHERE id=?").run(missionId);
    const runner = seedAgentRunner(w, "runner-broke");
    expect(w.brain.jobProtocol.claim(runner, "req-broke-1")).toBeNull();
    expect(w.brain.store.control.prepare("SELECT queue_reason FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(running!.runId)).toEqual({ queue_reason: "waiting: budget" });
    await w.brain.challenges.sweep();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [failed] = await challenges(w, workItem.workItemId);
    expect(failed).toMatchObject({ state: "failed" });
    expect(failed!.reason).toMatch(/budget/u);
    expect((db(w).prepare("SELECT state FROM workflow_runs WHERE id=?").get(running!.runId) as { state: string }).state).toBe("cancelled");
  }, scaled(60_000));
});
