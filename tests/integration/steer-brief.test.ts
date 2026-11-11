import { describe, expect, it } from "vitest";
import type { CommandReceipt, MissionBrief } from "@brain/contracts";
import { drainSessionControls, recordAttemptSession } from "../../apps/governor/src/modules/sessions/index";
import { ensureContextPack } from "../../apps/governor/src/modules/jobs/attempts";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// Issue #62: a steer is first recorded as a constraint of the mission brief (through the ordinary brief
// edit command, with actor and time), then delivered as the session's advisory steer. Delivery is
// at-most-once and can be lost; the record must survive. Constraints reach agents through the context
// pack, never an evaluator's input.
const STEER = "Steering (2026-11-11 10:03 UTC): Focus on European competitors only";

async function command(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key,
    ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const brief = (w: TestWorld, missionId: string) => w.brain.missions.query(w.owner, "missions.brief", w.workspaceId, missionId) as unknown as MissionBrief;

describe("steering is recorded in the mission brief (issue #62)", () => {
  it("a lost delivery leaves the constraint in the brief, with actor and time, and both commands are on the funnel", async () => {
    const w = setupWorld();
    const missionId = (await command(w, "mission.create", "m", { title: "Market scan", intent: "Scan the market", successCriteria: ["a scan exists"] })).resourceId!;
    recordAttemptSession(w.brain.store, { organizationId: w.org, workspaceId: w.workspaceId, jobId: "job-steer", attemptId: "att-steer", engineId: "fixture", adapterDigest: DIGEST_A });
    const sessionId = "ses-job-steer";

    // Record first (brief edit), then deliver (session steer): the order the console follows.
    const before = brief(w, missionId);
    const edited = await command(w, "mission.brief.edit", "steer-brief", { missionId, baseVersion: before.version, constraints: [...before.constraints, STEER] });
    expect(edited.accepted).toBe(true);
    const delivered = await command(w, "session.steer", "steer-deliver", { sessionId, message: "Focus on European competitors only" });
    expect(delivered.accepted).toBe(true);

    // The delivery is lost: the runner's control is handed out once and never applied.
    const live = [{ attemptId: "att-steer", workspaceId: w.workspaceId, organizationId: w.org }];
    expect(drainSessionControls(w.brain.store, live, 10)).toHaveLength(1);
    expect(drainSessionControls(w.brain.store, live, 10)).toHaveLength(0);

    // The instruction is still there, written by the person at a known time.
    const after = brief(w, missionId);
    expect(after.constraints).toEqual([STEER]);
    expect(after.version).toBe(before.version + 1);
    expect(after.updatedBy).toBe("owner-1");
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(0);
    expect(after.history?.[0]).toMatchObject({ change: "edited", createdBy: "owner-1", constraints: [STEER] });

    // Both went through the command funnel (an intent is recorded for each) and neither wrote a hidden prompt edit.
    const intents = w.brain.store.control.prepare("SELECT command_id, state FROM command_intents WHERE command_id IN ('cmd-steer-brief','cmd-steer-deliver')").all() as Array<{ command_id: string; state: string }>;
    expect(intents.map((row) => row.command_id).sort()).toEqual(["cmd-steer-brief", "cmd-steer-deliver"]);
  });

  it("an agent step's context pack carries the constraint; an evaluator step gets no pack at all", async () => {
    const w = setupWorld();
    const missionId = (await command(w, "mission.create", "m2", { title: "Market scan", intent: "Scan the market", successCriteria: ["a scan exists"] })).resourceId!;
    const edited = await command(w, "mission.brief.edit", "steer-brief-2", { missionId, baseVersion: brief(w, missionId).version, constraints: [STEER] });
    expect(edited.accepted).toBe(true);
    const planId = (await command(w, "plan.propose", "p2", { missionId, origin: "manual", tasks: [{ id: "a", title: "Research", criteria: ["done"], dependsOn: [] }] })).resourceId!;
    await command(w, "plan.confirm", "c2", { planVersionId: planId }, (w.brain.missions.query(w.owner, "missions.get", w.workspaceId, missionId) as unknown as { version: number }).version);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const item = db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string };
    const runId = "run-steer";
    db.prepare("INSERT OR IGNORE INTO execution_links(mission_id, work_item_id, run_id, job_id, attempt_id, session_id, created_at_ms) VALUES (?,?,?,?,?,?,?)").run(missionId, item.id, runId, null, null, null, w.brain.store.now());

    const control = w.brain.store.control;
    const addJob = (jobId: string, uses: unknown) => {
      control.prepare("PRAGMA foreign_keys=OFF").run();
      control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(jobId, "dispatch", JSON.stringify({ step: { uses } }));
      return { id: jobId, workspace_id: w.workspaceId, workflow_run_id: runId, config_digest: DIGEST_A };
    };
    const pack = (jobId: string) => (JSON.parse((control.prepare("SELECT payload_json FROM job_payloads WHERE job_id=?").get(jobId) as { payload_json: string }).payload_json) as { contextPack?: { text: string } }).contextPack;
    const build = (organizationId: string, workspaceId: string, input: Parameters<typeof w.brain.sessions.contextPackForRun>[2]) => w.brain.sessions.contextPackForRun(organizationId, workspaceId, input);

    ensureContextPack(w.brain.store, build, w.org, addJob("job-agent", { type: "agent", release: { id: "task-worker" } }));
    expect(pack("job-agent")?.text).toContain(STEER);

    ensureContextPack(w.brain.store, build, w.org, addJob("job-evaluator", { type: "evaluator", release: { id: "task-validator" } }));
    expect(pack("job-evaluator")).toBeUndefined();
  });
});
