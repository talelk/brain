import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, tx, type Db } from "../../apps/governor/src/db";
import { append } from "../../apps/governor/src/events";
import { checkpoint, ensureAuditKey, verify } from "../../apps/governor/src/trust/audit";

const clock = { nowMs: () => Date.now(), monotonicMs: () => performance.now() };
let dataDir: string;
let db: Db;
const gov = () => ({ db, dataDir, clock });
const record = (count: number): void => tx(db, () => {
  for (let i = 0; i < count; i++) append(db, { type: "task.created", workspaceId: "ws_1", subject: `task:t${i}`, payload: { title: `Task ${i}` }, actor: { kind: "person", id: "user_1" } });
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "brain-audit-"));
  db = openDb(dataDir);
  ensureAuditKey(gov());
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the audit chain", () => {
  it("appends events in one chain and verifies it, checkpoints included", () => {
    record(5);
    checkpoint(gov());
    record(3);
    // One event records the signing key, then eight changes.
    expect(verify(db)).toMatchObject({ ok: true, events: 9, checkpoints: 1, head: { seq: 9 } });
    expect(db.prepare("SELECT COUNT(DISTINCT prev_digest) AS links FROM events").get()).toEqual({ links: 9 });
  });

  it("refuses an event appended outside a transaction", () => {
    expect(() => append(db, { type: "x", subject: "x:1", payload: {}, actor: { kind: "system", id: "governor" } })).toThrow(/outside a transaction/u);
  });

  it("leaves no event behind when the change is rolled back", () => {
    expect(() => tx(db, () => {
      append(db, { type: "task.created", subject: "task:t", payload: {}, actor: { kind: "system", id: "governor" } });
      throw new Error("the change failed");
    })).toThrow("the change failed");
    expect(verify(db)).toMatchObject({ ok: true, events: 1 });
  });

  it("does not sign the same head twice", () => {
    record(2);
    expect(checkpoint(gov())).toEqual(checkpoint(gov()));
    expect(verify(db).checkpoints).toBe(1);
  });

  it.each<[string, string, string]>([
    ["an edited payload", "UPDATE events SET payload_json = '{\"title\":\"Other\"}' WHERE seq = 3", "payload-edited"],
    ["an edited actor", "UPDATE events SET actor_id = 'user_2' WHERE seq = 3", "event-edited"],
    ["an edited type", "UPDATE events SET type = 'task.removed' WHERE seq = 5", "event-edited"],
    ["an edited subject", "UPDATE events SET subject = 'task:other' WHERE seq = 4", "event-edited"],
    ["a removed event", "DELETE FROM events WHERE seq = 3", "sequence-gap"],
    ["a removed tail that a checkpoint covered", "DELETE FROM events WHERE seq > 4", "tail-truncated"],
    ["a checkpoint moved to another position", "UPDATE audit_checkpoints SET through_seq = 2", "checkpoint-unsigned"],
    ["a swapped signing key", "UPDATE audit_keys SET public_key = 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE='", "key-mismatch"],
  ])("detects %s", (_name, tamper, kind) => {
    record(5);
    checkpoint(gov());
    db.exec(tamper);
    expect(verify(db)).toMatchObject({ ok: false, break: { kind } });
  });
});
