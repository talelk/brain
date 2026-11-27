import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpoint } from "../../apps/governor/src/trust/audit";
import { createHarness, type Harness } from "./harness";

let harness: Harness;
let workspaceId: string;
beforeEach(async () => {
  harness = await createHarness();
  ({ workspaceId } = await harness.createWorkspace());
  await harness.admin.command("secret.set", { workspaceId, name: "github", value: "a-secret-value" });
  await harness.admin.command("file.write", { workspaceId, files: [{ path: "memory/note.md", content: "---\ntype: Note\ntitle: Note\n---\n" }] });
});
afterEach(() => harness.close());

const events = () => harness.governor.gov.db.prepare("SELECT seq, type, workspace_id AS workspaceId, subject, actor_kind AS actorKind, actor_id AS actorId FROM events ORDER BY seq").all() as Array<{ seq: number; type: string; workspaceId: string | null; subject: string; actorKind: string; actorId: string }>;

describe("audit.verify", () => {
  it("every change is one event of the chain, with who made it", async () => {
    const me = (await harness.admin.query("me", {})).user;
    expect(events().map((event) => [event.type, event.actorKind])).toEqual([
      ["audit.keyRecorded", "system"], ["user.signed_in", "person"], ["setup.completed", "person"], ["workspace.created", "person"], ["secret.set", "person"], ["workspace.changed", "person"],
    ]);
    expect(events().slice(1).every((event) => event.actorId === me?.id)).toBe(true);
    expect(events().slice(3).every((event) => event.workspaceId === workspaceId)).toBe(true);
    // A refused change records nothing.
    await expect(harness.admin.command("file.write", { workspaceId, files: [{ path: "brain.toml", content: "nonsense" }] })).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
    expect(events()).toHaveLength(6);
  });

  it("passes on an untouched log, with its signed checkpoint", async () => {
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true, events: 6, checkpoints: 0, head: { seq: 6 } });
    checkpoint(harness.governor.gov);
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true, events: 6, checkpoints: 1 });
    await harness.restart();
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true, events: 6, checkpoints: 1 });
  });

  it.each<[string, string, string, number]>([
    ["a row whose payload was edited", "UPDATE events SET payload_json = replace(payload_json, 'github', 'other') WHERE type = 'secret.set'", "payload-edited", 5],
    ["a row whose actor was edited", "UPDATE events SET actor_id = 'someone-else' WHERE seq = 3", "event-edited", 3],
    ["a removed row", "DELETE FROM events WHERE seq = 5", "sequence-gap", 6],
    ["rows removed from the end after a checkpoint", "DELETE FROM events WHERE seq = 6", "tail-truncated", 6],
  ])("fails after %s, naming where", async (_name, tamper, kind, seq) => {
    checkpoint(harness.governor.gov);
    harness.governor.gov.db.exec(tamper);
    const result = await harness.admin.query("audit.verify", {});
    expect(result).toMatchObject({ ok: false, break: { kind, seq } });
    expect(result.break?.detail).toBeTruthy();
  });
});
