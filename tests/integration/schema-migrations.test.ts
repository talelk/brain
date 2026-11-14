import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMaintenance } from "../../apps/governor/src/maintenance";
import { MIGRATIONS, migrateDirectory, type Migration } from "../../apps/governor/src/infrastructure/persistence/migrations";
import { setupWorld } from "../helpers";

/** A stopped data directory with one organization, one workspace and a mission, as the maintenance command would find it. */
function stoppedDirectory(): { dir: string; workspaceId: string } {
  const w = setupWorld();
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  ws.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,version,created_at_ms,updated_at_ms) VALUES ('m-1','Keep me','intent','[{\"id\":\"c1\",\"text\":\"x\"}]','owner-1',1,1,1)").run();
  w.brain.close();
  return { dir: w.dir, workspaceId: w.workspaceId };
}
const tables = (file: string) => {
  const db = new Database(file, { readonly: true });
  try { return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name); } finally { db.close(); }
};
const workspaceFile = (dir: string, id: string) => join(dir, "workspaces", `${id}.db`);
const columns = (file: string, table: string) => {
  const db = new Database(file, { readonly: true });
  try { return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name); } finally { db.close(); }
};

const RENAME: Migration[] = [
  { id: 1, name: "rename missions.intent to brief", database: "workspace", sql: "ALTER TABLE missions RENAME COLUMN intent TO brief" },
  { id: 2, name: "mark the control database", database: "control", sql: "CREATE TABLE migration_probe (id INTEGER PRIMARY KEY) STRICT" },
];

describe("versioned schema migrations (ADR 0025): additive, not active policy", () => {
  it("ships with an empty list and changes nothing: no table, no file touched", async () => {
    expect(MIGRATIONS).toEqual([]);
    const { dir, workspaceId } = stoppedDirectory();
    const before = [tables(join(dir, "control.db")), tables(workspaceFile(dir, workspaceId))];
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { expect(await runMaintenance(["migrate", dir])).toBe(0); expect(await runMaintenance(["migrate", dir, "--check"])).toBe(0); } finally { process.stdout.write = write; }
    expect(JSON.parse(out[0]!)).toEqual({ dryRun: false, databases: [] });
    expect([tables(join(dir, "control.db")), tables(workspaceFile(dir, workspaceId))]).toEqual(before);
    expect(before.flat()).not.toContain("schema_migrations");
  });

  it("applies numbered migrations in order, each recorded, keeps the rows, and a second run does nothing", () => {
    const { dir, workspaceId } = stoppedDirectory();
    const report = migrateDirectory(dir, RENAME);
    expect(report.databases.map((entry) => [entry.file, entry.applied])).toEqual([["control.db", [2]], [`workspaces/${workspaceId}.db`, [1]]]);
    const ws = new Database(workspaceFile(dir, workspaceId), { readonly: true });
    expect(ws.prepare("SELECT title, brief FROM missions WHERE id='m-1'").get()).toEqual({ title: "Keep me", brief: "intent" });
    expect(ws.prepare("SELECT id, name FROM schema_migrations").all()).toEqual([{ id: 1, name: "rename missions.intent to brief" }]);
    ws.close();
    expect(tables(join(dir, "control.db"))).toContain("migration_probe");
    expect(migrateDirectory(dir, RENAME).databases.every((entry) => entry.applied.length === 0)).toBe(true);
  });

  it("checks on copies first: --check leaves the live files untouched, and a failing change aborts before any real file changes", () => {
    const { dir, workspaceId } = stoppedDirectory();
    const trial = migrateDirectory(dir, RENAME, { dryRun: true });
    expect(trial.dryRun).toBe(true);
    expect(trial.databases.flatMap((entry) => entry.applied).sort()).toEqual([1, 2]);
    expect(columns(workspaceFile(dir, workspaceId), "missions")).toContain("intent");
    expect(tables(join(dir, "control.db"))).not.toContain("migration_probe");
    // The control change is fine, the workspace change is not: the trial on the copies fails, so even the control file stays as it was.
    const broken: Migration[] = [{ id: 1, name: "ok", database: "control", sql: "CREATE TABLE should_not_exist (id INTEGER PRIMARY KEY) STRICT" }, { id: 2, name: "bad", database: "workspace", sql: "ALTER TABLE no_such_table RENAME COLUMN a TO b" }];
    expect(() => migrateDirectory(dir, broken)).toThrow(/no such table/u);
    expect(tables(join(dir, "control.db"))).not.toContain("should_not_exist");
    expect(tables(join(dir, "control.db"))).not.toContain("schema_migrations");
  });

  it("rolls a failing migration back completely and records nothing", () => {
    const { dir, workspaceId } = stoppedDirectory();
    const half: Migration[] = [{ id: 1, name: "half done", database: "workspace", run: (db) => { db.exec("ALTER TABLE missions RENAME COLUMN intent TO brief"); throw new Error("boom"); } }];
    expect(() => migrateDirectory(dir, half)).toThrow(/boom/u);
    expect(columns(workspaceFile(dir, workspaceId), "missions")).toContain("intent");
    expect(tables(workspaceFile(dir, workspaceId))).not.toContain("schema_migrations");
  });

  it("refuses an edited migration, a gap in the numbering and a database newer than the code", () => {
    const { dir } = stoppedDirectory();
    migrateDirectory(dir, RENAME);
    expect(() => migrateDirectory(dir, [{ ...RENAME[0]!, sql: "ALTER TABLE missions RENAME COLUMN intent TO purpose" }, RENAME[1]!])).toThrow(/changed after it was applied/u);
    expect(() => migrateDirectory(dir, [RENAME[0]!])).toThrow(/newer than the code/u);
    expect(() => migrateDirectory(dir, [{ ...RENAME[1]!, id: 3 }])).toThrow(/numbered 1..n/u);
  });
});
