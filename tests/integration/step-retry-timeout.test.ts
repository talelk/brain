import { afterEach, describe, expect, it } from "vitest";
import { attemptsOf, controlledClock, dispatchFixture, failAttempt, jobRow, policyWorld, readRetry, runStateOf, seedRunner, startAttempt, stepStatesOf, type World } from "../support/step-policy";

// A step's declared retry count and timeout (ADR 0046), at the Governor boundary: the fixture workflow is dispatched by command, a runner
// claims and completes its attempts through the runner protocol, and time moves only when the test moves the Governor's clock.
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });
function start(declared: Parameters<typeof policyWorld>[1]) {
  const time = controlledClock();
  const w = policyWorld(time.clock, declared);
  worlds.push(w);
  return { w, time, runner: seedRunner(w, "runner-policy") };
}
const jobOf = (w: World, runId: string) => (w.brain.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=?").get(runId) as { id: string }).id;

describe("a step's declared retry", () => {
  it("offers the step again as a new attempt after the backoff, up to its count, then fails the step and the run", async () => {
    const { w, time, runner } = start({ retry: readRetry(3) });
    const runId = await dispatchFixture(w, "retry-count");
    const jobId = jobOf(w, runId);

    const first = startAttempt(w, runner, "req-1")!;
    failAttempt(w, runner, first, "tool exited with status 2");
    // The run has not heard of a failure: the step is still running and its job waits in the queue for the backoff (1 s).
    expect(jobRow(w, jobId)).toMatchObject({ state: "queued", queue_reason: "RETRYING_STEP", step_failures: 1 });
    expect(stepStatesOf(w.brain, w, runId)).toEqual({ echo: "running" });
    expect(runStateOf(w.brain, w, runId)).toBe("running");
    expect(startAttempt(w, runner, "req-early")).toBeNull();
    time.advance(1000);

    const second = startAttempt(w, runner, "req-2")!;
    expect(second.jobId).toBe(jobId);
    expect(second.attemptId).not.toBe(first.attemptId);
    failAttempt(w, runner, second, "tool exited with status 2");
    // The backoff doubles (2 s).
    expect(jobRow(w, jobId)).toMatchObject({ state: "queued", step_failures: 2 });
    time.advance(1999);
    expect(startAttempt(w, runner, "req-early-2")).toBeNull();
    time.advance(1);

    const third = startAttempt(w, runner, "req-3")!;
    failAttempt(w, runner, third, "tool exited with status 2");
    // Three attempts is the declared count: the step fails and so does the run.
    expect(jobRow(w, jobId)).toMatchObject({ state: "failed", step_failures: 3 });
    expect(stepStatesOf(w.brain, w, runId)).toEqual({ echo: "failed" });
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
    expect(attemptsOf(w.brain, jobId).map((a) => [a.no, a.state])).toEqual([[1, "failed"], [2, "failed"], [3, "failed"]]);
    expect(startAttempt(w, runner, "req-after")).toBeNull();
  });

  it("a retried attempt that succeeds is the step's one result, and the earlier failure never reaches the run", async () => {
    const { w, time, runner } = start({ retry: readRetry(2) });
    const runId = await dispatchFixture(w, "retry-succeeds");
    const jobId = jobOf(w, runId);
    failAttempt(w, runner, startAttempt(w, runner, "req-1")!, "connection reset");
    time.advance(1000);
    const second = startAttempt(w, runner, "req-2")!;
    w.brain.jobProtocol.complete(runner, second.attemptId, { result: "succeeded", output: { message: "ok" }, jobFence: second.jobFence, cleanupConfirmed: true });
    expect(jobRow(w, jobId).state).toBe("verifying");
    expect(runStateOf(w.brain, w, runId)).toBe("running");
    expect(attemptsOf(w.brain, jobId).map((a) => a.state)).toEqual(["failed", "verifying"]);
  });

  it("a step that declares no retry fails at its first failure", async () => {
    const { w, runner } = start({});
    const runId = await dispatchFixture(w, "no-retry");
    failAttempt(w, runner, startAttempt(w, runner, "req-1")!, "tool exited with status 2");
    expect(jobRow(w, jobOf(w, runId)).state).toBe("failed");
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
  });

  it("a provider's quota is waited out by the task, never spent as a retry: the step fails at once with its retries unused", async () => {
    const { w, runner } = start({ retry: readRetry(3) });
    const runId = await dispatchFixture(w, "retry-quota");
    const first = startAttempt(w, runner, "req-1")!;
    failAttempt(w, runner, first, "quota or rate limit (retry after 30s): 429 Too Many Requests");
    expect(jobRow(w, first.jobId)).toMatchObject({ state: "failed", step_failures: 1 });
    expect(attemptsOf(w.brain, first.jobId)).toHaveLength(1);
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
  });

  it("a retry that does not name the class that fits the step's effect is not honoured", async () => {
    const { w, runner } = start({ retry: readRetry(3, ["target-proven-absent"]) });
    const runId = await dispatchFixture(w, "retry-class");
    failAttempt(w, runner, startAttempt(w, runner, "req-1")!, "tool exited with status 2");
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
  });

  it("an attempt that took an effect permit is never retried: the target may have changed", async () => {
    const { w, runner } = start({ retry: readRetry(3) });
    const runId = await dispatchFixture(w, "retry-permit");
    const first = startAttempt(w, runner, "req-1")!;
    // A resource lease is what an attempt holds once it began changing a target.
    w.brain.store.control.prepare("INSERT INTO resource_fences(resource_key, organization_id, counter) VALUES ('target-1', ?, 1)").run(w.org);
    w.brain.store.control.prepare("INSERT INTO resource_leases(resource_key, attempt_id, invocation_id, fence, expires_at_ms, unresolved_effect) VALUES ('target-1', ?, 'inv-1', 1, ?, 0)").run(first.attemptId, w.brain.store.now() + 60_000);
    failAttempt(w, runner, first, "tool exited with status 2");
    expect(jobRow(w, first.jobId).state).toBe("failed");
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
  });
});

describe("a step's declared timeout", () => {
  it("ends the attempt at its deadline, not before, and the runner's late result is refused", async () => {
    const { w, time, runner } = start({ timeoutSeconds: 30 });
    const runId = await dispatchFixture(w, "timeout-fires");
    const attempt = startAttempt(w, runner, "req-1")!;
    time.advance(29_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(0);
    expect(jobRow(w, attempt.jobId).state).toBe("running");
    time.advance(1000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(1);
    expect(jobRow(w, attempt.jobId).state).toBe("failed");
    expect(attemptsOf(w.brain, attempt.jobId)).toEqual([{ no: 1, state: "failed", reason: "The step timed out after 30 seconds." }]);
    expect(stepStatesOf(w.brain, w, runId)).toEqual({ echo: "failed" });
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
    // A second pass finds nothing, and the runner that kept going learns its attempt is gone.
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(0);
    expect(() => w.brain.jobProtocol.complete(runner, attempt.attemptId, { result: "succeeded", output: { message: "late" }, jobFence: attempt.jobFence, cleanupConfirmed: true })).toThrow();
    expect(() => w.brain.jobProtocol.renew(runner, attempt.attemptId, { leaseId: attempt.leaseId, jobFence: attempt.jobFence })).toThrow();
  });

  it("counts from the moment the attempt starts running, not from when the job was queued", async () => {
    const { w, time } = start({ timeoutSeconds: 30 });
    await dispatchFixture(w, "timeout-from-start");
    time.advance(120_000);
    const attempt = startAttempt(w, seedRunner(w, "runner-late"), "req-1")!;
    time.advance(20_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(0);
    expect(jobRow(w, attempt.jobId).state).toBe("running");
  });

  it("is one failed attempt for the step's retry: a timed-out attempt is offered again, and the last one fails the step", async () => {
    const { w, time, runner } = start({ timeoutSeconds: 30, retry: readRetry(2) });
    const runId = await dispatchFixture(w, "timeout-retry");
    const first = startAttempt(w, runner, "req-1")!;
    time.advance(30_000);
    w.brain.jobProtocol.expireDeadlines();
    expect(jobRow(w, first.jobId)).toMatchObject({ state: "queued", queue_reason: "RETRYING_STEP", step_failures: 1 });
    expect(runStateOf(w.brain, w, runId)).toBe("running");
    time.advance(1000);
    const second = startAttempt(w, runner, "req-2")!;
    expect(second.jobId).toBe(first.jobId);
    time.advance(30_000);
    w.brain.jobProtocol.expireDeadlines();
    expect(jobRow(w, first.jobId)).toMatchObject({ state: "failed", step_failures: 2 });
    expect(runStateOf(w.brain, w, runId)).toBe("failed");
    expect(attemptsOf(w.brain, first.jobId).map((a) => a.reason)).toEqual(["The step timed out after 30 seconds.", "The step timed out after 30 seconds."]);
  });

  it("leaves an attempt that may have changed a target outcome-unknown for reconciliation, never retried", async () => {
    const { w, time, runner } = start({ timeoutSeconds: 30, retry: readRetry(3) });
    const runId = await dispatchFixture(w, "timeout-effect");
    const attempt = startAttempt(w, runner, "req-1")!;
    w.brain.store.control.prepare("INSERT INTO resource_fences(resource_key, organization_id, counter) VALUES ('target-2', ?, 1)").run(w.org);
    w.brain.store.control.prepare("INSERT INTO resource_leases(resource_key, attempt_id, invocation_id, fence, expires_at_ms, unresolved_effect) VALUES ('target-2', ?, 'inv-2', 1, ?, 0)").run(attempt.attemptId, w.brain.store.now() + 600_000);
    time.advance(30_000);
    w.brain.jobProtocol.expireDeadlines();
    expect(jobRow(w, attempt.jobId).state).toBe("outcome_unknown");
    expect(attemptsOf(w.brain, attempt.jobId).map((a) => a.state)).toEqual(["outcome_unknown"]);
    expect(runStateOf(w.brain, w, runId)).toBe("running");
  });
});
