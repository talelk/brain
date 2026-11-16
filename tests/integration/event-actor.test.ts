import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "@brain/contracts";
import { UNATTRIBUTED, actingAs, systemActor } from "../../apps/governor/src/application/actor-context";
import { bearer, closeWorlds, command, run, running, startedMission as started, type World } from "../support/machine-session";

// ADR 0032 (#148): every event records who caused it (principal, kind, the attempt it acted through, and the person a machine acts for),
// taken from the actor scope the work runs in. Reached through commands, passes and the runner protocol, never through table writes.

afterEach(closeWorlds);

interface Recorded { event_id: string; event_type: string; actor_id: string; actor_kind: string; actor_attempt_id: string | null; acting_for: string | null }
const columns = "event_id, event_type, actor_id, actor_kind, actor_attempt_id, acting_for";
const allEvents = (w: World): Recorded[] => [
  ...(w.brain.store.control.prepare(`SELECT ${columns} FROM events ORDER BY cursor`).all() as Recorded[]),
  ...(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare(`SELECT ${columns} FROM events ORDER BY cursor`).all() as Recorded[]),
];
/** What was written since `seen` was taken: events are told apart by id, because the control and workspace logs are read together. */
const since = (w: World, seen: ReadonlySet<string>): Recorded[] => allEvents(w).filter((event) => !seen.has(event.event_id));
const idsOf = (w: World): Set<string> => new Set(allEvents(w).map((event) => event.event_id));
const audit = async (w: World): Promise<AuditEntry[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "audit.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: AuditEntry[] } }).snapshot.items;

describe("every event records its actor", () => {
  it("an event written outside any actor scope is refused in a test run, and inside one it carries the scope's actor", async () => {
    const { w } = await started();
    const emit = () => w.brain.store.emit(w.brain.store.control, { organizationId: w.org, aggregateType: "probe", aggregateId: "p1", eventType: "probe.happened", payload: {} });
    expect(emit).toThrow(/outside an actor scope/u);
    actingAs(systemActor("probe"), emit);
    expect(w.brain.store.control.prepare(`SELECT ${columns} FROM events WHERE event_type='probe.happened'`).get()).toMatchObject({ event_type: "probe.happened", actor_id: "system:probe", actor_kind: "system", actor_attempt_id: null, acting_for: null });
  });

  it("a person's command is the person's, a session's is the agent acting for the owner through its attempt, a pass is a named system principal, a runner call is the runner", async () => {
    const { w, missionId, runner, workItemId } = await started();
    await run(w, "workItem.comment", "owner-comment", { workItemId, text: "Thanks" });
    expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare(`SELECT ${columns} FROM events ORDER BY cursor DESC LIMIT 1`).get()).toMatchObject({ actor_id: w.owner.actorId, actor_kind: "human", acting_for: null, actor_attempt_id: null });

    const offer = running(w, runner, "actor");
    const { principalId, credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    const identity = await w.brain.resolveActor(bearer(credential), w.workspaceId);
    const before = idsOf(w);
    await w.brain.executeCommand(identity.actor, command(w, "workItem.comment", "agent-comment", { workItemId, text: "Found the cause" }), "corr-1");
    const byAgent = since(w, before);
    expect(byAgent.length).toBeGreaterThan(0);
    for (const event of byAgent) expect(event).toMatchObject({ actor_id: principalId, actor_kind: "agent", actor_attempt_id: offer.attemptId, acting_for: w.owner.actorId });
    // The separate "session acted" record is gone: the actor on each event says the same, in the audit trail too.
    expect((await audit(w)).some((entry) => entry.action === "session.acted")).toBe(false);
    const entry = (await audit(w)).find((item) => item.actorId === principalId);
    expect(entry).toMatchObject({ actorId: principalId, actorKind: "agent", actingFor: w.owner.actorId, attemptId: offer.attemptId });

    // The workflow engine reporting a run's end, with nobody acting, is the Governor's own act: a named principal, not the owner.
    const runId = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT run_id FROM execution_links WHERE mission_id=? LIMIT 1").get(missionId) as { run_id: string }).run_id;
    const beforePass = idsOf(w);
    w.brain.runFailed({ organizationId: w.org, workspaceId: w.workspaceId, runId, diagnostic: "the engine stopped" });
    const byPass = since(w, beforePass);
    expect(byPass.length).toBeGreaterThan(0);
    for (const event of byPass) expect(event).toMatchObject({ actor_id: "system:workflow", actor_kind: "system", acting_for: null });

    // A runner protocol call is the runner, with the attempt it served.
    const marker = idsOf(w);
    w.brain.jobProtocol.complete(runner, offer.attemptId, { result: "failed", jobFence: offer.jobFence, cleanupConfirmed: true, output: { reason: "stopped for the test" } });
    const byRunner = since(w, marker);
    expect(byRunner.length).toBeGreaterThan(0);
    for (const event of byRunner) expect(event).toMatchObject({ actor_id: runner.runnerId, actor_kind: "runner", actor_attempt_id: offer.attemptId });
  });

  it("no event of a mission's life is without an actor, and no Governor-internal event is the mission owner's", async () => {
    const { w, runner, workItemId } = await started();
    const offer = running(w, runner, "life");
    const { credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    const identity = await w.brain.resolveActor(bearer(credential), w.workspaceId);
    await w.brain.executeCommand(identity.actor, command(w, "workItem.comment", "life-comment", { workItemId, text: "Working" }), "corr");
    w.brain.jobProtocol.complete(runner, offer.attemptId, { result: "failed", jobFence: offer.jobFence, cleanupConfirmed: true, output: { reason: "done for the test" } });
    for (const pass of [() => w.brain.jobProtocol.sweepStuckJobs(), () => w.brain.jobProtocol.dispatchSchedules(), () => w.brain.jobProtocol.dispatchAutomations(), () => w.brain.projectOutbox(), () => w.brain.missions.pumpCoordinators()]) pass();
    await w.brain.autoStart.sweepAll();

    const events = allEvents(w);
    expect(events.length).toBeGreaterThan(10);
    expect(events.filter((event) => event.actor_id === UNATTRIBUTED || !event.actor_id || !event.actor_kind)).toEqual([]);
    // Everything is a person, a session principal, a runner, or a named system principal; a system principal is not a person's id.
    for (const event of events) {
      if (event.actor_kind === "system") expect(event.actor_id).toMatch(/^system:[a-z][a-z0-9:-]*$/u);
      if (event.actor_kind === "agent") expect(event.acting_for).toBeTruthy();
      if (event.actor_kind === "human") expect(event.acting_for).toBeNull();
    }
    // The audit trail and the stream read the same record.
    expect((await audit(w)).every((entry) => entry.actorId !== UNATTRIBUTED)).toBe(true);
    w.brain.stream.projectAll();
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM execution_stream WHERE actor_id=?").get(UNATTRIBUTED)).toEqual({ n: 0 });
  });
});
