import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { loadSchemaSql } from "../../apps/governor/src/infrastructure/persistence/open";

// The live repair rebuilds the declared tables whose keys changed (releases
// owned per organization) in place, keeping every row and index.
// The control schema as it was before releases were owned per organization:
// derived from the current file by reversing exactly that change, so the test
// fails loudly if the schema moves again.
function previousControlSql(): string {
  const reversals: Array<[string, string]> = [
    ["digest TEXT NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id),", "digest TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),"],
    ["created_at_ms INTEGER NOT NULL,\n  PRIMARY KEY(organization_id, digest)\n", "created_at_ms INTEGER NOT NULL\n"],
    ["  release_digest TEXT NOT NULL,\n  version INTEGER NOT NULL CHECK(version > 0),\n  FOREIGN KEY(organization_id, release_digest) REFERENCES config_releases(organization_id, digest)\n", "  release_digest TEXT NOT NULL REFERENCES config_releases(digest),\n  version INTEGER NOT NULL CHECK(version > 0)\n"],
    ["CHECK(version > 0), config_digest TEXT NOT NULL,", "CHECK(version > 0), config_digest TEXT NOT NULL REFERENCES config_releases(digest),"],
    [",\n  FOREIGN KEY(organization_id, config_digest) REFERENCES config_releases(organization_id, digest)\n", "\n"],
  ];
  let sql = loadSchemaSql("control.sql");
  for (const [current, previous] of reversals) {
    expect(sql.split(current).length - 1, `schema no longer contains: ${current}`).toBe(1);
    sql = sql.replace(current, previous);
  }
  return sql;
}

function repair(dataDir: string): string {
  return execFileSync("npx", ["tsx", "scripts/repair-live-schema.ts"], { env: { ...process.env, BRAIN_DATA_DIR: dataDir }, encoding: "utf8" });
}

function indexes(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('config_releases','active_config','jobs') AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
}

describe("live schema repair", () => {
  it("rebuilds release-keyed tables in place, keeping rows, indexes and foreign keys", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "brain-repair-"));
    try {
      const path = join(dataDir, "control.db");
      const old = new Database(path);
      old.exec(previousControlSql());
      old.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES ('org-a','org-a')").run();
      old.prepare("INSERT INTO workspaces(id, organization_id, slug, status) VALUES ('ws-a','org-a','a','active')").run();
      old.prepare("INSERT INTO config_releases(digest, organization_id, source_revision, compiler_digest, manifest_json, created_at_ms) VALUES ('sha256:r1','org-a','rev','cmp','{}',1)").run();
      old.prepare("INSERT INTO active_config(organization_id, release_digest, version) VALUES ('org-a','sha256:r1',3)").run();
      old.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, created_at_ms, ready_at_ms, deadline_ms)
        VALUES ('job-1','org-a','ws-a','run-1:s','run-1','s','queued','sha256:r1','{}','d','read',1,1,2)`).run();
      const before = {
        releases: old.prepare("SELECT * FROM config_releases").all(),
        active: old.prepare("SELECT * FROM active_config").all(),
        jobs: old.prepare("SELECT * FROM jobs").all(),
      };
      old.close();

      const output = repair(dataDir);
      expect(output).toMatch(/rebuilt table config_releases \(1 rows kept\)/);
      expect(output).toMatch(/rebuilt table jobs \(1 rows kept\)/);

      const db = new Database(path);
      expect({
        releases: db.prepare("SELECT * FROM config_releases").all(),
        active: db.prepare("SELECT * FROM active_config").all(),
        jobs: db.prepare("SELECT * FROM jobs").all(),
      }).toEqual(before);
      const pk = (db.prepare("PRAGMA table_info(config_releases)").all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      expect(pk).toEqual(["organization_id", "digest"]);
      expect(db.prepare("PRAGMA foreign_key_check").all().filter((v) => ["config_releases", "active_config", "jobs"].includes((v as { table: string }).table))).toEqual([]);
      const fresh = new Database(":memory:");
      fresh.exec(loadSchemaSql("control.sql"));
      expect(indexes(db)).toEqual(indexes(fresh));
      // A second organization may now own the same release digest.
      db.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES ('org-b','org-b')").run();
      db.prepare("INSERT INTO config_releases(digest, organization_id, source_revision, compiler_digest, manifest_json, created_at_ms) VALUES ('sha256:r1','org-b','rev','cmp','{}',2)").run();
      db.close();
      fresh.close();

      expect(repair(dataDir)).not.toMatch(/rebuilt table/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("adds a column the schema declares with a default, keeping existing rows", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "brain-repair-"));
    try {
      const control = new Database(join(dataDir, "control.db"));
      control.exec(loadSchemaSql("control.sql"));
      control.close();
      const line = "  auto_start INTEGER NOT NULL DEFAULT 1 CHECK(auto_start IN (0,1)),\n";
      const sql = loadSchemaSql("workspace.sql");
      expect(sql.split(line).length - 1, "workspace.sql no longer declares missions.auto_start on its own line").toBe(1);
      mkdirSync(join(dataDir, "workspaces"));
      const path = join(dataDir, "workspaces", "ws-a.db");
      const old = new Database(path);
      old.exec(sql.replace(line, ""));
      old.prepare("INSERT INTO workspace_identity(singleton, workspace_id, organization_id, schema_version) VALUES (1,'ws-a','org-a',1)").run();
      old.prepare("INSERT INTO missions(id, title, intent, success_criteria_json, owner_id, created_at_ms, updated_at_ms) VALUES ('m1','Old mission','Intent','[]','u1',1,1)").run();
      old.close();

      expect(repair(dataDir)).toMatch(/added column missions\.auto_start/);
      const db = new Database(path);
      expect(db.prepare("SELECT id, auto_start FROM missions").all()).toEqual([{ id: "m1", auto_start: 1 }]);
      db.close();
      expect(repair(dataDir)).not.toMatch(/added column/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
