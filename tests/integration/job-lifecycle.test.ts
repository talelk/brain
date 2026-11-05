import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// The jobs module is the only writer of jobs and job_attempts. These tests
// drive the lifecycle outside the runner protocol through JobProtocol.
type Offer = { attemptId: string; jobId: string; jobFence: number };

function seedRunner(w: TestWorld, id: string): { runnerId: string; epoch: number; organizationId: string } {
  const s = w.brain.store;
  s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
    VALUES (?, ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 2)`).run(id, w.org, DIGEST_A, s.now());
  for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?, ?, 1, 'test', ?, ?)").run(id, cap, s.now(), s.now() + 3600000);
  }
  return { runnerId: id, epoch: 1, organizationId: w.org };
}

async function dispatch(w: TestWorld, key: string): Promise<{ runId: string; jobId: string }> {
  const digest = w.brain.activeRelease(w.org)!.digest;
  const out = await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "workflow.dispatch",
    workspaceId: w.workspaceId, idempotencyKey: key,
    payload: { workflow: { id: "fixture-workflow", digest }, input: { message: key } },
  }, key);
  const runId = String((out.receipt as { resourceId: string }).resourceId);
  const job = w.brain.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=?").get(runId) as { id: string };
  return { runId, jobId: job.id };
}

function jobRow(w: TestWorld, jobId: string): { state: string; placement_json: string; execution_key: string; workspace_id: string; workflow_run_id: string; step_id: string; config_digest: string } {
  return w.brain.store.control.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as never;
}

describe("job lifecycle (jobs module)", () => {
  it("creating a job twice for the same execution key returns the same job, and a runner pin lands in its placement", async () => {
    const w = setupWorld();
    const { jobId } = await dispatch(w, "life-create");
    const row = jobRow(w, jobId);
    const input = {
      organizationId: w.org, workspaceId: row.workspace_id, runId: row.workflow_run_id, stepId: row.step_id,
      executionKey: row.execution_key, configDigest: row.config_digest, placementJson: "{}",
      executionDigest: DIGEST_A, effectClass: "read", kind: "dispatch", payload: {},
    };
    expect(w.brain.jobProtocol.createForStep(input)).toBe(jobId);
    const pinned = w.brain.jobProtocol.createForStep({ ...input, executionKey: `${row.execution_key}:pinned`, runnerId: "runner-pin" });
    expect(pinned).not.toBe(jobId);
    expect(JSON.parse(jobRow(w, pinned).placement_json)).toMatchObject({ runnerId: "runner-pin" });
  });

  it("cancelling a run cancels its unheld jobs and the workspace job load follows", async () => {
    const w = setupWorld();
    const { runId, jobId } = await dispatch(w, "life-cancel");
    expect(w.brain.jobProtocol.workspaceJobLoad(w.workspaceId)).toEqual({ unresolved: 0, active: 1 });
    w.brain.jobProtocol.cancelForRun(runId);
    expect(jobRow(w, jobId).state).toBe("cancelled");
    expect(w.brain.jobProtocol.workspaceJobLoad(w.workspaceId)).toEqual({ unresolved: 0, active: 0 });
  });

  it("a verdict conclusion commits or rolls back with the caller's transaction and respects the job fence", async () => {
    const w = setupWorld();
    const s = w.brain.store;
    const { jobId } = await dispatch(w, "life-conclude");
    const offer = w.brain.jobProtocol.claim(seedRunner(w, "runner-conclude"), "req-conclude") as Offer;
    s.control.prepare("UPDATE job_attempts SET state='verifying' WHERE id=?").run(offer.attemptId);
    s.control.prepare("UPDATE jobs SET state='verifying' WHERE id=?").run(jobId);

    expect(() => s.inTx(s.control, () => {
      w.brain.jobProtocol.concludeAttempt({ jobId, attemptId: offer.attemptId, state: "succeeded", jobFence: offer.jobFence });
      throw new Error("caller failed after concluding");
    })).toThrow("caller failed");
    expect(jobRow(w, jobId).state).toBe("verifying");

    expect(() => w.brain.jobProtocol.concludeAttempt({ jobId, attemptId: offer.attemptId, state: "succeeded", jobFence: offer.jobFence + 1 })).toThrow("changed concurrently");
    expect(jobRow(w, jobId).state).toBe("verifying");

    w.brain.jobProtocol.concludeAttempt({ jobId, attemptId: offer.attemptId, state: "succeeded", jobFence: offer.jobFence });
    expect(jobRow(w, jobId).state).toBe("succeeded");
    expect((s.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(offer.attemptId) as { state: string }).state).toBe("succeeded");
  });

  it("counts an outcome_unknown job as unresolved until reconciliation proves the effect absent", async () => {
    const w = setupWorld();
    const s = w.brain.store;
    const { jobId } = await dispatch(w, "life-unknown");
    const offer = w.brain.jobProtocol.claim(seedRunner(w, "runner-unknown"), "req-unknown") as Offer;
    s.control.prepare("UPDATE job_attempts SET state='outcome_unknown' WHERE id=?").run(offer.attemptId);
    s.control.prepare("UPDATE jobs SET state='outcome_unknown' WHERE id=?").run(jobId);
    expect(w.brain.jobProtocol.workspaceJobLoad(w.workspaceId)).toEqual({ unresolved: 1, active: 1 });
    w.brain.jobProtocol.resolveReconciliation({ organizationId: w.org, jobId, outcome: "absent", evidenceDigest: DIGEST_A });
    expect(jobRow(w, jobId).state).toBe("queued");
    expect(w.brain.jobProtocol.workspaceJobLoad(w.workspaceId)).toEqual({ unresolved: 0, active: 1 });
  });
});
