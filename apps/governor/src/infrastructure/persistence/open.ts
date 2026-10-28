import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrainDomainError } from "../../domain/errors";

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = 1;

function schemaPath(name: string): string {
  const candidates = [
    join(here, "../../../schema", name),
    join(process.cwd(), "apps/governor/schema", name),
    join(process.cwd(), "schema", name),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", `schema file not found: ${name}`);
}

export function loadSchemaSql(name: "control.sql" | "workspace.sql"): string {
  return readFileSync(schemaPath(name), "utf8");
}

export function schemaDigest(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

export interface EngineHealth {
  readonly version: string;
  readonly compileOptions: readonly string[];
  readonly fts5: boolean;
  readonly walSafe: boolean;
}

export function engineHealth(db: Db): EngineHealth {
  const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  const opts = (db.prepare("PRAGMA compile_options").all() as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]));
  const parts = row.v.split(".").map(Number);
  const walSafe = (parts[0] ?? 0) > 3 || ((parts[0] ?? 0) === 3 && ((parts[1] ?? 0) > 51 || ((parts[1] ?? 0) === 51 && (parts[2] ?? 0) >= 3)));
  return { version: row.v, compileOptions: opts, fts5: opts.includes("ENABLE_FTS5"), walSafe };
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 100");
  const health = engineHealth(db);
  if (!health.walSafe) {
    db.close();
    throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", `SQLite ${health.version} predates WAL fix 3.51.3`);
  }
  return db;
}

export function initializeFresh(db: Db, sql: string, identity?: { workspaceId: string; organizationId: string }): void {
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schema_metadata','workspace_identity')").get();
  if (!hasMeta) {
    db.exec(sql);
    const digest = schemaDigest(sql);
    const now = Date.now();
    if (sql.includes("schema_metadata")) {
      db.prepare("INSERT INTO schema_metadata(singleton, schema_version, schema_digest, initialized_at_ms) VALUES (1, ?, ?, ?)")
        .run(SCHEMA_VERSION, digest, now);
    }
    if (identity && sql.includes("workspace_identity")) {
      db.prepare("INSERT INTO workspace_identity(singleton, workspace_id, organization_id, schema_version, schema_digest) VALUES (1, ?, ?, ?, ?)")
        .run(identity.workspaceId, identity.organizationId, SCHEMA_VERSION, digest);
    }
    return;
  }
  // Existing DB: validate identity only; never convert or reset.
  const digest = schemaDigest(sql);
  try {
    const meta = db.prepare("SELECT schema_digest FROM schema_metadata WHERE singleton=1").get() as { schema_digest: string } | undefined;
    if (meta && meta.schema_digest !== digest) {
      throw new BrainDomainError("UPGRADE_REQUIRED", "existing database schema does not match current target; preserved, not converted");
    }
  } catch (e) {
    if (e instanceof BrainDomainError) throw e;
    // workspace db has no schema_metadata; identity check below covers it
  }
  if (identity) {
    let row: { workspace_id: string; organization_id: string; schema_digest: string } | undefined;
    try {
      row = db.prepare("SELECT workspace_id, organization_id, schema_digest FROM workspace_identity WHERE singleton=1").get() as
        | { workspace_id: string; organization_id: string; schema_digest: string } | undefined;
    } catch {
      // Pre-digest workspace schema: exact-check cannot pass; preserved.
      throw new BrainDomainError("UPGRADE_REQUIRED", "workspace database predates schema-digest tracking; preserved, not converted");
    }
    if (!row || row.workspace_id !== identity.workspaceId || row.organization_id !== identity.organizationId) {
      throw new BrainDomainError("UPGRADE_REQUIRED", "workspace database identity mismatch; preserved, not converted");
    }
    if (row.schema_digest !== digest) {
      throw new BrainDomainError("UPGRADE_REQUIRED", "workspace database schema does not match current target; preserved, not converted");
    }
  }
}

export function withBusyRetry<T>(fn: () => T, attempts = 5): T {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) throw e;
      const wait = 10 * (i + 1);
      const end = Date.now() + wait;
      while (Date.now() < end) { /* bounded spin outside transaction */ }
    }
  }
  throw last;
}
