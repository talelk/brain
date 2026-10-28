import { describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A } from "../helpers";

// T07 packet acceptance: per-destination outbox delivery into workspace
// projections is idempotent (replay-safe), and a digest collision parks the
// delivery instead of corrupting the projection.
describe("outbox projections (T07)", () => {
  it("job.queued projects into the workspace exactly once across replays", () => {
    const w = setupWorld();
    const s = w.brain.store;
    const digest = w.brain.activeRelease(w.org)!.digest;
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-proj", commandType: "workflow.dispatch",
      workspaceId: w.workspaceId, idempotencyKey: "proj-1",
      payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "project me" } },
    }, "proj-1");
    const pending = s.control.prepare("SELECT COUNT(*) AS c FROM outbox_deliveries WHERE state='pending'").get() as { c: number };
    expect(pending.c).toBeGreaterThanOrEqual(1);

    const delivered = w.brain.projectOutbox();
    expect(delivered).toBeGreaterThanOrEqual(1);
    const ws = s.workspaceDb(w.workspaceId, w.org);
    const projection = ws.prepare("SELECT job_id, state FROM job_projection").all() as Array<{ job_id: string; state: string }>;
    expect(projection).toHaveLength(1);
    expect(projection[0]!.state).toBe("queued");
    const inboxCount = (ws.prepare("SELECT COUNT(*) AS c FROM inbox WHERE source_id='control'").get() as { c: number }).c;
    expect(inboxCount).toBeGreaterThanOrEqual(1);

    // Replay: forcing the same delivery again changes nothing.
    s.control.prepare("UPDATE outbox_deliveries SET state='pending', delivered_at_ms=NULL").run();
    w.brain.projectOutbox();
    expect(ws.prepare("SELECT job_id, state FROM job_projection").all()).toEqual(projection);
    expect((ws.prepare("SELECT COUNT(*) AS c FROM inbox WHERE source_id='control'").get() as { c: number }).c).toBe(inboxCount);
    w.brain.close();
  });

  it("a digest collision parks the delivery and leaves the projection untouched", () => {
    const w = setupWorld();
    const s = w.brain.store;
    const digest = w.brain.activeRelease(w.org)!.digest;
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-park", commandType: "workflow.dispatch",
      workspaceId: w.workspaceId, idempotencyKey: "park-1",
      payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "park me" } },
    }, "park-1");
    const ws = s.workspaceDb(w.workspaceId, w.org);
    const ev = s.control.prepare("SELECT event_id FROM events WHERE event_type='job.queued' ORDER BY cursor DESC LIMIT 1").get() as { event_id: string };
    // Pre-seed a conflicting inbox digest for the same event.
    ws.prepare("INSERT INTO inbox(source_id, event_id, payload_digest, applied_at_ms) VALUES ('control', ?, ?, ?)").run(ev.event_id, DIGEST_A, s.now());
    w.brain.projectOutbox();
    const delivery = s.control.prepare("SELECT state, last_error FROM outbox_deliveries WHERE event_id=?").get(ev.event_id) as { state: string; last_error: string | null };
    expect(delivery.state).toBe("parked");
    expect(delivery.last_error).toMatch(/collision/);
    expect(ws.prepare("SELECT * FROM job_projection").all()).toEqual([]);
    w.brain.close();
  });
});
