import type { ApprovalPollResponse } from "@brain/contracts";

/** The time an approval wait runs on: the real clock in the runner, a clock a test moves by hand in a test. */
export interface Timer {
  now(): number;
  /** Resolves after `ms`, or as soon as the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const systemTimer: Timer = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  }),
};

/** How long the runner waits for a person before it tells the agent the call is held (docs/architecture.md section 7). */
export const APPROVAL_WAIT_MS = 10 * 60_000;
const POLL_MS = 3000;

export type ApprovalVerdict =
  | { readonly state: "approved" }
  /** A person said no, or the approval ended unanswered on the Governor's side: the call did not happen. */
  | { readonly state: "rejected"; readonly reason: string }
  /** Nobody decided in time: the call waits for a person and the attempt goes on without it. */
  | { readonly state: "held" };

export interface ApprovalWait {
  readonly timer?: Timer;
  readonly waitMs?: number;
  readonly pollMs?: number;
  /** The attempt's abort signal: a stopped attempt stops waiting and leaves the call held. */
  readonly signal?: AbortSignal;
}

/**
 * Waits for a pending approval: polls until a person approves or rejects it, or until the wait is over. A poll that fails is tried again
 * at the next interval; a lost lease is not a poll failure and is thrown by `poll` through `fatal`.
 */
export async function waitForApproval(poll: () => Promise<ApprovalPollResponse>, options: ApprovalWait = {}, fatal: (error: unknown) => boolean = () => false): Promise<ApprovalVerdict> {
  const timer = options.timer ?? systemTimer;
  const deadline = timer.now() + (options.waitMs ?? APPROVAL_WAIT_MS);
  const pollMs = options.pollMs ?? POLL_MS;
  while (timer.now() < deadline && !options.signal?.aborted) {
    await timer.sleep(Math.min(pollMs, Math.max(1, deadline - timer.now())), options.signal);
    if (options.signal?.aborted) break;
    let answer: ApprovalPollResponse;
    try { answer = await poll(); } catch (error) { if (fatal(error)) throw error; continue; }
    if (answer.state === "approved") return { state: "approved" };
    if (answer.state === "rejected") return { state: "rejected", reason: answer.reason ?? "a person rejected the call" };
    if (answer.state === "expired") return { state: "rejected", reason: answer.reason ?? "the approval expired without a decision" };
  }
  return { state: "held" };
}
