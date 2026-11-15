import { afterEach, describe, expect, it } from "vitest";
import type { BrainSession } from "@brain/contracts";
import { drainSessionControls, endAttemptSession } from "../../apps/governor/src/modules/sessions/index";
import { DIGEST_A } from "../helpers";
import { advance, closeWorlds, missionOf, run, startedMission, task, type Offer, type Runner, type World } from "../support/machine-session";

// ADR 0055: a person holds ONE session at its next turn boundary and continues it later. The attempt keeps its fence, lease and slot; the mission
// and the other members' sessions are untouched; the time it is held is neither working time (ADR 0016) nor step timeout (ADR 0046); a session
// held longer than the hold limit is stopped. State is reached only through commands and the runner protocol, never through table writes.

afterEach(closeWorlds);

/** The runner claims the next job and starts its attempt on an engine with these features. */
function start(w: World, runner: Runner, key: string, features: string[]): Offer {
  const offer = w.brain.jobProtocol.claim(runner, `claim-${key}`) as unknown as Offer;
  expect(offer, "the runner was offered the task").toBeTruthy();
  w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "pi", adapterDigest: DIGEST_A, features } });
  return offer;
}

let beat = 0;
const heartbeat = (w: World, runner: Runner) => w.brain.jobProtocol.heartbeat(runner, { sequence: ++beat, health: "healthy" }).commands;
const forAttempt = (commands: ReadonlyArray<{ type: string; attemptId?: string }>, offer: Offer) => commands.filter((command) => command.attemptId === offer.attemptId).map((command) => command.type);
const sessionOf = async (w: World, offer: Offer): Promise<BrainSession> => {
  const items = ((await w.brain.executeQuery(w.owner, { queryType: "sessions.list", workspaceId: w.workspaceId } as never)) as unknown as { snapshot: { items: BrainSession[] } }).snapshot.items;
  return items.find((item) => item.attemptId === offer.attemptId)!;
};
const report = (w: World, runner: Runner, offer: Offer, sequence: number, phase: string) =>
  w.brain.jobProtocol.events(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, events: [{ sequence, kind: "progress", payload: { phase } }] });
const renew = (w: World, runner: Runner, offer: Offer) => w.brain.jobProtocol.renew(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
/** Time passes while the runner keeps renewing the lease, as it does every 15 seconds. */
function elapse(w: World, runner: Runner, offers: Offer[], ms: number): void {
  for (let left = ms; left > 0; left -= 30_000) { advance(Math.min(30_000, left)); for (const offer of offers) renew(w, runner, offer); }
}
const control = (w: World, commandType: "session.pause" | "session.continue", key: string, sessionId: string) => run(w, commandType, key, { sessionId });
const activeMs = async (w: World, missionId: string) => (await missionOf(w, missionId)).usage.activeMs;
const deadlineOf = (w: World, offer: Offer) => (w.brain.store.control.prepare("SELECT deadline_ms AS d FROM job_attempts WHERE id=?").get(offer.attemptId) as { d: number | null }).d;

describe("pausing one session (ADR 0055)", () => {
  it("holds one session at its boundary and continues the same session, leaving the mission and the other member alone", async () => {
    const { w, missionId, runner } = await startedMission({ tasks: [task("a"), task("b")] });
    const first = start(w, runner, "one", ["sessions", "steer", "pause"]);
    const second = start(w, runner, "two", ["sessions", "steer", "pause"]);
    const before = await sessionOf(w, first);
    expect(before.pause).toMatchObject({ supported: true, state: "running" });

    const asked = await control(w, "session.pause", "pause-1", before.sessionId);
    expect(asked.accepted).toBe(true);
    // Asked, not yet taken: the engine reaches its boundary on its own time. The runner is told on every heartbeat until it reports.
    expect((await sessionOf(w, first)).pause).toMatchObject({ state: "pausing" });
    expect(forAttempt(heartbeat(w, runner), first)).toEqual(["pause-attempt"]);
    expect(forAttempt(heartbeat(w, runner), first)).toEqual(["pause-attempt"]);
    expect(forAttempt(heartbeat(w, runner), second)).toEqual([]);
    // Asking again while it is pending changes nothing.
    expect((await control(w, "session.pause", "pause-again", before.sessionId)).accepted).toBe(true);

    report(w, runner, first, 1, "session-paused");
    const held = await sessionOf(w, first);
    expect(held.pause).toMatchObject({ supported: true, state: "paused", holdLimitMs: 30 * 60_000 });
    expect(Date.parse(held.pause!.stopsAt!) - Date.parse(held.pause!.since!)).toBe(30 * 60_000);
    expect(forAttempt(heartbeat(w, runner), first)).toEqual([]);

    // Held: the same session, attempt, fence and lease, still running and still holding its slot; the mission and the other session do not change.
    expect(held).toMatchObject({ sessionId: before.sessionId, attemptId: first.attemptId, state: "running" });
    expect(() => renew(w, runner, first)).not.toThrow();
    expect(w.brain.store.control.prepare("SELECT state, job_fence FROM job_attempts WHERE id=?").get(first.attemptId)).toEqual({ state: "running", job_fence: first.jobFence });
    expect(w.brain.store.control.prepare("SELECT released_at_ms FROM capacity_reservations WHERE attempt_id=?").get(first.attemptId)).toEqual({ released_at_ms: null });
    expect(await missionOf(w, missionId)).toMatchObject({ state: "active" });
    expect(await sessionOf(w, second)).toMatchObject({ state: "running", pause: { state: "running" } });

    // Steer still works while held: it is delivered to the runner, which hands it to the engine for its first request after the continue.
    expect((await run(w, "session.steer", "steer-held", { sessionId: before.sessionId, message: "Focus on the second source" })).accepted).toBe(true);
    expect(heartbeat(w, runner).filter((command) => command.attemptId === first.attemptId)).toEqual([expect.objectContaining({ type: "steer", text: "Focus on the second source" })]);

    // Continue: the runner is told until it reports; the session then runs again as the very same session.
    expect((await control(w, "session.continue", "continue-1", before.sessionId)).accepted).toBe(true);
    expect((await sessionOf(w, first)).pause).toMatchObject({ state: "resuming" });
    expect(forAttempt(heartbeat(w, runner), first)).toEqual(["continue-attempt"]);
    expect(forAttempt(heartbeat(w, runner), first)).toEqual(["continue-attempt"]);
    report(w, runner, first, 2, "session-continued");
    expect(forAttempt(heartbeat(w, runner), first)).toEqual([]);
    expect(await sessionOf(w, first)).toMatchObject({ sessionId: before.sessionId, attemptId: first.attemptId, state: "running", pause: { supported: true, state: "running" } });
    expect(await missionOf(w, missionId)).toMatchObject({ state: "active" });

    // It can be paused again: each pause is its own.
    await control(w, "session.pause", "pause-2", before.sessionId);
    expect(forAttempt(heartbeat(w, runner), first)).toEqual(["pause-attempt"]);
  });

  it("a continue asked before the engine reached its boundary cancels the pause, and a pause cannot be asked while a continue is on its way", async () => {
    const { w, runner } = await startedMission();
    const offer = start(w, runner, "cancel", ["sessions", "pause"]);
    const { sessionId } = await sessionOf(w, offer);
    await control(w, "session.pause", "pause-c", sessionId);
    expect((await control(w, "session.continue", "continue-c", sessionId)).accepted).toBe(true);
    expect(forAttempt(heartbeat(w, runner), offer)).toEqual(["continue-attempt"]);
    await expect(control(w, "session.pause", "pause-c2", sessionId)).rejects.toThrow(/being continued/u);
    // The runner never reached a boundary; it reports it is running and the pause closes without any held time.
    report(w, runner, offer, 1, "session-continued");
    expect(await sessionOf(w, offer)).toMatchObject({ pause: { state: "running" } });
    expect(w.brain.store.control.prepare("SELECT paused_at_ms FROM attempt_pauses WHERE attempt_id=?").get(offer.attemptId)).toEqual({ paused_at_ms: null });
    // Continuing a session that is not held is a no-op.
    expect((await control(w, "session.continue", "continue-none", sessionId)).accepted).toBe(true);
    expect(forAttempt(heartbeat(w, runner), offer)).toEqual([]);
  });

  it("is refused, with the reason in plain words, for an engine that cannot stop at a turn boundary, and for a session that is not running", async () => {
    const { w, runner } = await startedMission();
    const offer = start(w, runner, "plain", ["sessions", "steer"]);
    const session = await sessionOf(w, offer);
    expect(session.pause).toMatchObject({ supported: false, state: "running", reason: expect.stringContaining("cannot stop at a turn boundary") });
    await expect(control(w, "session.pause", "pause-plain", session.sessionId)).rejects.toThrow(/cannot stop at a turn boundary/u);
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM attempt_pauses").get()).toEqual({ n: 0 });

    endAttemptSession(w.brain.store, { organizationId: w.org, workspaceId: w.workspaceId, attemptId: offer.attemptId, failed: false });
    expect((await sessionOf(w, offer)).pause).toMatchObject({ supported: false, reason: "This session is not running." });
    await expect(control(w, "session.pause", "pause-ended", session.sessionId)).rejects.toThrow(/not running/u);
    await expect(control(w, "session.pause", "pause-missing", "ses-nowhere")).rejects.toThrow(/not found/u);
  });

  it("holding a session is not working time and does not run down its step timeout; both go on from where they were", async () => {
    const { w, missionId, runner } = await startedMission();
    const offer = start(w, runner, "clock", ["sessions", "pause"]);
    const { sessionId } = await sessionOf(w, offer);
    const deadline = deadlineOf(w, offer);
    expect(deadline, "the task's step declares a timeout").not.toBeNull();

    elapse(w, runner, [offer], 5 * 60_000);
    expect(await activeMs(w, missionId)).toBe(5 * 60_000);

    await control(w, "session.pause", "pause-t", sessionId);
    report(w, runner, offer, 1, "session-paused");
    // Held for 20 minutes, far beyond the step timeout: working time stands still and the Governor does not time the attempt out.
    elapse(w, runner, [offer], 20 * 60_000);
    expect(await activeMs(w, missionId)).toBe(5 * 60_000);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(0);
    expect(w.brain.store.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(offer.attemptId)).toEqual({ state: "running" });

    await control(w, "session.continue", "continue-t", sessionId);
    report(w, runner, offer, 2, "session-continued");
    expect(deadlineOf(w, offer)).toBe(deadline! + 20 * 60_000);
    elapse(w, runner, [offer], 3 * 60_000);
    expect(await activeMs(w, missionId)).toBe(8 * 60_000);
    // Time still runs down the step timeout after the continue: the deadline moved, it did not go away.
    advance(Math.max(0, deadlineOf(w, offer)! - w.brain.store.now()) + 1);
    expect(w.brain.jobProtocol.expireDeadlines()).toBe(1);
  });

  it("stops a session held longer than the hold limit like any stop, freeing the slot, and never touches one that was continued", async () => {
    const { w, missionId, runner } = await startedMission({ tasks: [task("a"), task("b")] });
    const held = start(w, runner, "held", ["sessions", "pause"]);
    const other = start(w, runner, "other", ["sessions", "pause"]);
    const heldSession = await sessionOf(w, held);
    const otherSession = await sessionOf(w, other);
    for (const [offer, session, seq] of [[held, heldSession, 1], [other, otherSession, 1]] as const) {
      await control(w, "session.pause", `pause-${offer.attemptId}`, session.sessionId);
      report(w, runner, offer, seq, "session-paused");
    }
    elapse(w, runner, [held, other], 29 * 60_000);
    expect(w.brain.jobProtocol.expirePausedSessions()).toBe(0);
    await control(w, "session.continue", "continue-other", otherSession.sessionId);
    report(w, runner, other, 2, "session-continued");
    elapse(w, runner, [held, other], 2 * 60_000);

    expect(w.brain.jobProtocol.expirePausedSessions()).toBe(1);
    expect(w.brain.jobProtocol.expirePausedSessions()).toBe(0);
    // It is an ordinary stop, delivered until the session has ended; the mission itself is not paused.
    expect(forAttempt(heartbeat(w, runner), held)).toEqual(["stop-attempt"]);
    expect(forAttempt(heartbeat(w, runner), other)).toEqual([]);
    expect(await missionOf(w, missionId)).toMatchObject({ state: "active" });
  });

  it("delivers stop until the session has ended, so a lost acknowledgement cannot leave a held session holding its slot", async () => {
    const { w, runner } = await startedMission();
    const offer = start(w, runner, "stop", ["sessions", "pause"]);
    const { sessionId } = await sessionOf(w, offer);
    await control(w, "session.pause", "pause-s", sessionId);
    report(w, runner, offer, 1, "session-paused");
    expect((await run(w, "session.stop", "stop-held", { sessionId, reason: "Not needed any more" })).accepted).toBe(true);

    // The first acknowledgement is lost: the runner hears it again on the next heartbeats, and applies it once.
    expect(forAttempt(heartbeat(w, runner), offer)).toEqual(["stop-attempt"]);
    expect(forAttempt(heartbeat(w, runner), offer)).toEqual(["stop-attempt"]);
    const live = [{ attemptId: offer.attemptId, workspaceId: w.workspaceId, organizationId: w.org }];
    expect(drainSessionControls(w.brain.store, live, 100)).toEqual([expect.objectContaining({ type: "stop-attempt", attemptId: offer.attemptId })]);

    endAttemptSession(w.brain.store, { organizationId: w.org, workspaceId: w.workspaceId, attemptId: offer.attemptId, failed: true });
    expect(drainSessionControls(w.brain.store, live, 100)).toEqual([]);
    expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM session_controls").get()).toEqual({ n: 0 });
  });
});
