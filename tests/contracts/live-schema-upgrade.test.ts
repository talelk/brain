import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeFresh, loadSchemaSql } from "../../apps/governor/src/infrastructure/persistence/open";
import { addedColumns, describeMissingDefaults } from "../support/schema-upgrade";
import { scaled } from "../support/timing";

// Guard for the deploy that stranded the live Governor (docs/wiki/ops-live-server.md): the schema files of the
// previously released build are committed under tests/fixtures/released-schema (refreshed after each deploy by
// scripts/refresh-released-schema.sh), and the live repair must be able to upgrade them to the working tree.
const fixtureDir = join(process.cwd(), "tests/fixtures/released-schema");
const released = (name: string): string => readFileSync(join(fixtureDir, name), "utf8");
const current = (name: string): string => readFileSync(join(process.cwd(), "apps/governor/schema", name), "utf8");

function repair(dataDir: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "scripts/repair-live-schema.ts"], { env: { ...process.env, BRAIN_DATA_DIR: dataDir }, encoding: "utf8", timeout: scaled(60_000) });
}

describe("live schema upgrade guard", () => {
  it("every column added to an existing table since the last release declares a DEFAULT", () => {
    for (const file of ["control.sql", "workspace.sql", "auth-security.sql"]) {
      const message = describeMissingDefaults(addedColumns(released(file), current(file)));
      expect(message, `${file}: ${message}`).toBe("");
    }
  });

  it("the lint names a column added without a DEFAULT and accepts DEFAULT NULL", () => {
    const old = "CREATE TABLE t (id TEXT PRIMARY KEY) STRICT;";
    const bad = addedColumns(old, "CREATE TABLE t (id TEXT PRIMARY KEY, extra TEXT NOT NULL) STRICT; CREATE TABLE u (id TEXT) STRICT;");
    expect(bad).toEqual([{ table: "t", column: "extra", notNull: true, hasDefault: false }]);
    expect(describeMissingDefaults(bad)).toContain("t.extra");
    expect(describeMissingDefaults(addedColumns(old, "CREATE TABLE t (id TEXT PRIMARY KEY, extra TEXT DEFAULT NULL) STRICT;"))).toBe("");
  });

  it("repair upgrades databases built from the previously released schema to the current one, keeping rows", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "brain-upgrade-"));
    try {
      mkdirSync(join(dataDir, "workspaces"));
      const control = new Database(join(dataDir, "control.db"));
      initializeFresh(control, released("control.sql"));
      control.exec(released("auth.sql"));
      control.exec(released("auth-security.sql"));
      const releasedAuth = `sha256:${createHash("sha256").update(released("auth.sql")).update(released("auth-security.sql")).digest("hex")}`;
      control.prepare("INSERT INTO auth_schema_metadata VALUES (1,?)").run(releasedAuth);
      control.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES ('org-a','org-a')").run();
      control.close();
      const ws = new Database(join(dataDir, "workspaces", "ws-a.db"));
      initializeFresh(ws, released("workspace.sql"), { workspaceId: "ws-a", organizationId: "org-a" });
      ws.close();

      repair(dataDir);

      const upgraded = new Database(join(dataDir, "control.db"), { readonly: true });
      expect(upgraded.prepare("SELECT id FROM organizations").all()).toEqual([{ id: "org-a" }]);
      const digest = upgraded.prepare("SELECT schema_digest FROM schema_metadata").get() as { schema_digest: string };
      expect(digest.schema_digest).toBe(`sha256:${createHash("sha256").update(loadSchemaSql("control.sql")).digest("hex")}`);
      upgraded.close();
      const upgradedWs = new Database(join(dataDir, "workspaces", "ws-a.db"), { readonly: true });
      expect(upgradedWs.prepare("SELECT workspace_id FROM workspace_identity").all()).toEqual([{ workspace_id: "ws-a" }]);
      upgradedWs.close();
      // Idempotent: a second run changes nothing.
      expect(repair(dataDir)).not.toMatch(/created |added column|rebuilt/u);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  }, scaled(120_000));
});
