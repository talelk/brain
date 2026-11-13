import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainDomainError } from "../../domain/errors";
import { acquireDirectory } from "./directory";

/**
 * Versioned, forward-only schema migrations (ADR 0025). NOT part of initialization: nothing calls this on startup, in
 * `initialize-local` or in `repair-live-schema`. It runs only from `maintenance migrate`, on a stopped data directory, and its list is
 * empty until the owner changes the implementation policy (backlog row 74). With an empty list it does nothing, not even create its
 * table, so no existing database changes.
 */
export interface Migration {
  /** 1, 2, 3 ... with no gaps: the order they are applied in. */
  readonly id: number;
  readonly name: string;
  /** `control` is control.db; `workspace` runs once on every workspace database. */
  readonly database: "control" | "workspace";
  /** The change, as SQL (preferred) or code. It runs inside one transaction with its own record. */
  readonly sql?: string;
  readonly run?: (db: Database.Database) => void;
  /** Table rebuilds and renames that foreign keys would block: checks run with them off, `foreign_key_check` must then be clean. */
  readonly foreignKeysOff?: boolean;
}

/** Today's list. Empty on purpose: see the header and ADR 0025. */
export const MIGRATIONS: readonly Migration[] = [];

export interface MigrationRecord { readonly id: number; readonly name: string; readonly checksum: string; readonly appliedAtMs: number }
export interface MigrationReport { readonly database: string; readonly applied: readonly number[]; readonly pending: readonly number[] }

const TABLE = "schema_migrations";
const checksumOf = (m: Migration): string => `sha256:${createHash("sha256").update(JSON.stringify([m.id, m.name, m.database, m.sql ?? m.run?.toString() ?? ""])).digest("hex")}`;

function validateList(list: readonly Migration[]): void {
  list.forEach((m, index) => {
    if (m.id !== index + 1) throw new BrainDomainError("INVALID_ARGUMENT", `migrations must be numbered 1..n in order; found ${m.id} at position ${index + 1}`);
    if (!m.sql && !m.run) throw new BrainDomainError("INVALID_ARGUMENT", `migration ${m.id} has no change`);
  });
}

function recorded(db: Database.Database): MigrationRecord[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)) return [];
  return (db.prepare(`SELECT id,name,checksum,applied_at_ms FROM ${TABLE} ORDER BY id`).all() as Array<{ id: number; name: string; checksum: string; applied_at_ms: number }>)
    .map((row) => ({ id: row.id, name: row.name, checksum: row.checksum, appliedAtMs: row.applied_at_ms }));
}

/**
 * Applies the pending migrations of one database kind, each in its own immediate transaction together with its record. A failure rolls
 * that migration back completely and stops: nothing later runs. A database that records a migration this build does not know (newer
 * than the code) or one whose text changed since it was applied is refused: migrations only move forward.
 */
export function migrateDatabase(db: Database.Database, list: readonly Migration[], kind: Migration["database"], now: () => number = Date.now): MigrationReport {
  validateList(list);
  const mine = list.filter((m) => m.database === kind);
  const have = recorded(db);
  if (mine.length === 0 && have.length === 0) return { database: kind, applied: [], pending: [] };
  for (const row of have) {
    const known = mine.find((m) => m.id === row.id);
    if (!known) throw new BrainDomainError("UPGRADE_REQUIRED", `the database records migration ${row.id} (${row.name}) that this build does not know: it is newer than the code; nothing was changed`);
    if (known.name !== row.name || checksumOf(known) !== row.checksum) throw new BrainDomainError("CONFLICT", `migration ${row.id} (${row.name}) changed after it was applied; migrations are never edited, add a new one`);
  }
  const done = new Set(have.map((row) => row.id));
  const pending = mine.filter((m) => !done.has(m.id));
  if (pending.length === 0) return { database: kind, applied: [], pending: [] };
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL) STRICT`);
  const applied: number[] = [];
  for (const m of pending) {
    if (m.foreignKeysOff) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        if (m.sql) db.exec(m.sql);
        m.run?.(db);
        if (m.foreignKeysOff && (db.pragma("foreign_key_check") as unknown[]).length > 0) throw new BrainDomainError("CONFLICT", `migration ${m.id} (${m.name}) left foreign key violations`);
        db.prepare(`INSERT INTO ${TABLE}(id,name,checksum,applied_at_ms) VALUES (?,?,?,?)`).run(m.id, m.name, checksumOf(m), now());
      }).immediate();
    } finally { if (m.foreignKeysOff) db.pragma("foreign_keys = ON"); }
    applied.push(m.id);
  }
  return { database: kind, applied, pending: [] };
}

function databaseFiles(dir: string): Array<{ file: string; kind: Migration["database"] }> {
  const out: Array<{ file: string; kind: Migration["database"] }> = [{ file: "control.db", kind: "control" }];
  const workspaces = join(dir, "workspaces");
  if (existsSync(workspaces)) for (const name of readdirSync(workspaces).sort()) if (name.endsWith(".db")) out.push({ file: `workspaces/${name}`, kind: "workspace" });
  return out;
}

export interface DirectoryReport { readonly dryRun: boolean; readonly databases: readonly (MigrationReport & { file: string })[] }

/**
 * `maintenance migrate`: the pre-deploy snapshot check, kept. Every database is first copied (VACUUM INTO) and migrated there; only when
 * every copy migrated cleanly is the same change applied to the real files. `dryRun` stops after the check and touches nothing. An empty
 * list returns at once without opening a database.
 */
export function migrateDirectory(dataDir: string, list: readonly Migration[] = MIGRATIONS, opts: { dryRun?: boolean; now?: () => number } = {}): DirectoryReport {
  validateList(list);
  const dryRun = opts.dryRun === true;
  if (list.length === 0) return { dryRun, databases: [] };
  const release = acquireDirectory(dataDir);
  const scratch = mkdtempSync(join(tmpdir(), "brain-migrate-check-"));
  try {
    const files = databaseFiles(dataDir);
    const check: Array<MigrationReport & { file: string }> = [];
    for (const { file, kind } of files) {
      const live = new Database(join(dataDir, file), { readonly: true, fileMustExist: true });
      const copy = join(scratch, file.replaceAll("/", "__"));
      try { live.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`); } finally { live.close(); }
      const db = new Database(copy);
      try {
        check.push({ file, ...migrateDatabase(db, list, kind, opts.now) });
        if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new BrainDomainError("CONFLICT", `${file} failed its integrity check after the trial migration`);
      } finally { db.close(); }
    }
    if (dryRun) return { dryRun, databases: check };
    const databases: Array<MigrationReport & { file: string }> = [];
    for (const { file, kind } of files) {
      const db = new Database(join(dataDir, file), { fileMustExist: true });
      db.pragma("journal_mode = WAL");
      try { databases.push({ file, ...migrateDatabase(db, list, kind, opts.now) }); } finally { db.close(); }
    }
    return { dryRun, databases };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    release();
  }
}
