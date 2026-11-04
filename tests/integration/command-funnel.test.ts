import { describe, expect, it } from "vitest";
import { setupWorld } from "../helpers";

/**
 * Phase 2 of the command funnel: every command path shares one envelope, so
 * replay, conflict and command-id semantics must be identical no matter which
 * module owns the effect.
 */
describe("command funnel", () => {
  it("replays a workspace command from the stored receipt without re-applying it", async () => {
    const w = setupWorld();
    const command = (key: string, title: string, id = `cmd-${key}`) => ({
      contractVersion: "brain.command/v1" as const, commandId: id, commandType: "objective.create",
      workspaceId: w.workspaceId, idempotencyKey: key, payload: { title, intent: "shared envelope", successCriteria: ["verified"] },
    });
    const first = await w.brain.executeCommand(w.owner, command("funnel-replay", "First"), "corr-1");
    const replay = await w.brain.executeCommand(w.owner, command("funnel-replay", "First"), "corr-2");
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.status).toBe(first.status);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect(db.prepare("SELECT COUNT(*) AS n FROM objectives").get()).toEqual({ n: 1 });
  });

  it("rejects the same idempotency key reused with different bytes", async () => {
    const w = setupWorld();
    const base = { contractVersion: "brain.command/v1" as const, commandType: "objective.create", workspaceId: w.workspaceId, idempotencyKey: "funnel-conflict" };
    await w.brain.executeCommand(w.owner, { ...base, commandId: "cmd-funnel-conflict", payload: { title: "Accepted", intent: "one", successCriteria: ["verified"] } }, "corr-1");
    await expect(w.brain.executeCommand(w.owner, { ...base, commandId: "cmd-funnel-conflict", payload: { title: "Different", intent: "two", successCriteria: ["verified"] } }, "corr-2")).rejects.toThrow(/different payload/);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect(db.prepare("SELECT title FROM objectives").all()).toEqual([{ title: "Accepted" }]);
  });

  it("refuses a command id that is already recorded, even under another key", async () => {
    const w = setupWorld();
    const command = (key: string, title: string) => ({
      contractVersion: "brain.command/v1" as const, commandId: "cmd-funnel-shared", commandType: "objective.create",
      workspaceId: w.workspaceId, idempotencyKey: key, payload: { title, intent: "shared envelope", successCriteria: ["verified"] },
    });
    await w.brain.executeCommand(w.owner, command("funnel-id-a", "Recorded"), "corr-1");
    await expect(w.brain.executeCommand(w.owner, command("funnel-id-b", "Collision"), "corr-2")).rejects.toThrow(/command id already recorded/);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect(db.prepare("SELECT title FROM objectives").all()).toEqual([{ title: "Recorded" }]);
  });

  it("routes organization administration through the same entry point", async () => {
    const w = setupWorld();
    const before = w.brain.store.control.prepare("SELECT revocation_generation AS generation FROM organizations WHERE id=?").get(w.org) as { generation: number };
    const grant = {
      contractVersion: "brain.command/v1" as const, commandId: "cmd-funnel-org", commandType: "organization.member.role-grant",
      idempotencyKey: "funnel-org", expectedVersion: before.generation, payload: { principalId: "owner-1", role: "security-admin", reason: "Shared envelope" },
    };
    const accepted = await w.brain.executeCommand(w.owner, grant, "corr-1");
    expect(accepted.status).toBe(200);
    const replay = await w.brain.executeCommand(w.owner, grant, "corr-2");
    expect(replay.receipt).toEqual(accepted.receipt);
    const after = w.brain.store.control.prepare("SELECT revocation_generation AS generation FROM organizations WHERE id=?").get(w.org) as { generation: number };
    expect(after.generation).toBe(before.generation + 1);
  });

  it("rejects an unknown command type before any effect is recorded", async () => {
    const w = setupWorld();
    await expect(w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-funnel-unknown", commandType: "definitely.not.a.command",
      workspaceId: w.workspaceId, idempotencyKey: "funnel-unknown", payload: {},
    }, "corr-1")).rejects.toThrow();
    const intents = w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM command_intents WHERE command_id=?").get("cmd-funnel-unknown") as { n: number };
    expect(intents.n).toBe(0);
  });
});
