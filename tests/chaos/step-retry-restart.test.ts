import { afterEach, describe, expect, it } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";
import { attemptsOf, controlledClock, dispatchFixture, failAttempt, jobRow, policyWorld, readRetry, runStateOf, seedRunner, startAttempt, stepStatesOf, type World } from "../support/step-policy";
import { settled } from "../support/parallel-workflow";
import { scaled } from "../support/timing";
import { signCompletions } from "../support/signed-completion";

// A Governor killed while a step is being retried or timed out (ADR 0046): the step still has one job, an attempt that already failed
// is not failed or requeued a second time, the backoff and the deadline are on record, and the step finishes once.
const open: Brain[] = [];
afterEach(() => { for (const brain of open.splice(0)) brain.close(); });

/** A new Governor process on the same data directory and clock: the old one is closed first, as a kill would leave it. */
function restart(w: World, clock: { nowMs: () => number; monotonicMs: () => number }): World {
  w.brain.close();
  open.splice(open.indexOf(w.brain), 1);
  const brain = signCompletions(new Brain({ dataDir: w.dir, allowTestActor: true, clock }));
  open.push(brain);
  return { ...w, brain };
}
const jobsOf = (brain: Brain, runId: string) => brain.store.control.prepare("SELECT id, step_id AS step, state FROM jobs WHERE workflow_run_id=?").all(runId) as Array<{ id: string; step: string; state: string }>;

describe("a Governor killed while a step is retried", () => {
  it("does not requeue a failed attempt again, keeps the backoff, and runs the step to one result", async () => {
    const time = controlledClock();
    let w = policyWorld(time.clock, { retry: readRetry(3) });
    open.push(w.brain);
    const runner = seedRunner(w, "runner-chaos");
    const runId = await dispatchFixture(w, "retry-restart");
    const first = startAttempt(w, runner, "req-1")!;
    failAttempt(w, runner, first, "tool exited with status 2");
    expect(jobRow(w, first.jobId)).toMatchObject({ state: "queued", queue_reason: "RETRYING_STEP", step_failures: 1 });

    // Killed during the backoff.
    await settled(w.brain);
    w = restart(w, time.clock);
    expect(jobRow(w, first.jobId)).toMatchObject({ state: "queued", step_failures: 1 });
    expect(startAttempt(w, runner, "req-early")).toBeNull();
    // The runner repeats the failed receipt it never saw acknowledged: it changes nothing.
    expect(() => failAttempt(w, runner, first, "tool exited with status 2")).not.toThrow();
    expect(jobRow(w, first.jobId)).toMatchObject({ state: "queued", step_failures: 1 });
    expect(attemptsOf(w.brain, first.jobId)).toHaveLength(1);

    time.advance(1000);
    const second = startAttempt(w, runner, "req-2")!;
    expect(second.jobId).toBe(first.jobId);
    // Killed while the second attempt runs; its lease outlives the restart.
    w = restart(w, time.clock);
    w.brain.jobProtocol.complete(runner, second.attemptId, { result: "succeeded", output: { message: "ok" }, jobFence: second.jobFence, cleanupConfirmed: true });
    w.brain.jobProtocol.concludeAttempt({ jobId: second.jobId, attemptId: second.attemptId, state: "succeeded" });
    w.brain.workflows.completeStep(w.org, w.workspaceId, runId, "echo", { message: "ok" }, true);
    await settled(w.brain);

    expect(runStateOf(w.brain, w, runId)).toBe("succeeded");
    expect(stepStatesOf(w.brain, w, runId)).toEqual({ echo: "succeeded" });
    expect(jobsOf(w.brain, runId)).toEqual([{ id: first.jobId, step: "echo", state: "succeeded" }]);
    expect(attemptsOf(w.brain, first.jobId).map((a) => [a.no, a.state])).toEqual([[1, "failed"], [2, "succeeded"]]);
    expect(startAttempt(w, runner, "req-after")).toBeNull();
  }, scaled(120_000));

  it("keeps an attempt's deadline across the restart and fires it once", async () => {
    const time = controlledClock();
    let w = policyWorld(time.clock, { timeoutSeconds: 30, retry: readRetry(2) });
    open.push(w.brain);
    const runner = seedRunner(w, "runner-deadline");
    const runId = await dispatchFixture(w, "deadline-restart");
    const first = startAttempt(w, runner, "req-1")!;
    time.advance(20_000);
    w = restart(w, time.clock);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(0);
    time.advance(10_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(1);
    // A second Governor pass, or a repeat of the sweep, ends nothing twice.
    w = restart(w, time.clock);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(0);
    expect(jobRow(w, first.jobId)).toMatchObject({ state: "queued", queue_reason: "RETRYING_STEP", step_failures: 1 });
    expect(attemptsOf(w.brain, first.jobId).map((a) => a.state)).toEqual(["failed"]);
    expect(runStateOf(w.brain, w, runId)).toBe("running");
    expect(jobsOf(w.brain, runId)).toHaveLength(1);
  }, scaled(120_000));
});
