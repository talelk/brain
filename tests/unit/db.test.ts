import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../apps/governor/src/db";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "brain-db-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("the database", () => {
  it("an empty one gets every table of the architecture, and the sign-in tables", () => {
    const db = openDb(dataDir);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_index_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    db.close();
    expect(tables).toEqual([
      "account", "approvals", "artifact_links", "artifacts", "attempt_events", "attempts", "audit_checkpoints", "audit_keys", "checks", "events", "idempotency", "instance", "instance_admins",
      "members", "memory_index", "memory_proposals", "notes", "pull_requests", "rateLimit", "runner_challenges", "runner_tokens", "runners", "secrets", "session", "snapshots",
      "standing_uses", "tasks", "task_deps", "tool_calls", "triggers", "usage", "user", "verification", "webhook_deliveries", "workspaces",
      "deactivated_users", "group_grants", "group_members", "groups", "invitations",
    ].sort());
  });

  it("opens again as it is, and a database made by another schema is refused and kept", () => {
    openDb(dataDir).close();
    const db = openDb(dataDir);
    db.prepare("UPDATE instance SET value = 'sha256:another-schema' WHERE key = 'schema_digest'").run();
    db.close();
    expect(() => openDb(dataDir)).toThrow(/made by another version of Brain/u);
    expect(() => openDb(dataDir)).toThrow(/kept as it is/u);
  });
});
