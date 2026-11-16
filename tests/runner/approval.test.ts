import type { ApprovalPollResponse } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { APPROVAL_WAIT_MS, type Timer, waitForApproval } from "../../apps/runner/src/tools/approval";

/** A clock the test moves: every sleep advances it by exactly what was asked, at once. */
function fakeTimer(): Timer & { slept: number[] } {
  let now = 1_000_000;
  const slept: number[] = [];
  return { slept, now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } };
}

/** A poll that answers from a script, then keeps giving its last answer. */
function scripted(...answers: Array<ApprovalPollResponse | Error>) {
  let calls = 0;
  const poll = async (): Promise<ApprovalPollResponse> => {
    const answer = answers[Math.min(calls++, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { poll, calls: () => calls };
}

describe("waiting for an approval", () => {
  it("runs the call as soon as a person approves", async () => {
    const timer = fakeTimer();
    const { poll, calls } = scripted({ state: "pending" }, { state: "pending" }, { state: "approved" });
    expect(await waitForApproval(poll, { timer })).toEqual({ state: "approved" });
    expect(calls()).toBe(3);
    expect(timer.slept).toEqual([3000, 3000, 3000]);
  });

  it("tells the reason when a person rejects", async () => {
    const { poll } = scripted({ state: "pending" }, { state: "rejected", reason: "not on a Friday" });
    expect(await waitForApproval(poll, { timer: fakeTimer() })).toEqual({ state: "rejected", reason: "not on a Friday" });
  });

  it("treats an approval that expired on the Governor's side as not given", async () => {
    const { poll } = scripted({ state: "expired" });
    expect(await waitForApproval(poll, { timer: fakeTimer() })).toEqual({ state: "rejected", reason: "the approval expired without a decision" });
  });

  it("holds the call when nobody decides within ten minutes", async () => {
    const timer = fakeTimer();
    const started = timer.now();
    const { poll, calls } = scripted({ state: "pending" });
    expect(await waitForApproval(poll, { timer })).toEqual({ state: "held" });
    expect(timer.now() - started).toBe(APPROVAL_WAIT_MS);
    expect(calls()).toBe(APPROVAL_WAIT_MS / 3000);
  });

  it("keeps waiting through a poll that fails, and gives up at once on a lost lease", async () => {
    const lost = new Error("lease lost");
    const flaky = scripted(new Error("network"), { state: "approved" });
    expect(await waitForApproval(flaky.poll, { timer: fakeTimer() }, (error) => error === lost)).toEqual({ state: "approved" });
    await expect(waitForApproval(scripted(lost).poll, { timer: fakeTimer() }, (error) => error === lost)).rejects.toBe(lost);
  });

  it("stops waiting when the attempt is stopped, leaving the call held", async () => {
    const abort = new AbortController();
    const timer = fakeTimer();
    const poll = async (): Promise<ApprovalPollResponse> => { abort.abort(); return { state: "pending" }; };
    expect(await waitForApproval(poll, { timer, signal: abort.signal })).toEqual({ state: "held" });
    expect(timer.slept).toEqual([3000]);
  });
});
