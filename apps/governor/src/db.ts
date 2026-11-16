import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Db = Database.Database;

const sql = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");
/** The whole schema: the sign-in tables better-auth owns, then everything else. */
const schema = (): string => `${sql("./auth/auth.sql")}\n${sql("./schema.sql")}`;

/** Compiling a statement is a large share of every read and command, so the connection keeps the statements it has compiled, least recently used first out. */
function cacheStatements(db: Db): void {
  const cache = new Map<string, Database.Statement>();
  const prepare = db.prepare.bind(db) as (source: string) => Database.Statement;
  (db as { prepare: unknown }).prepare = (source: string): Database.Statement => {
    const hit = cache.get(source);
    if (hit) {
      cache.delete(source);
      cache.set(source, hit);
      return hit;
    }
    const statement = prepare(source);
    if (cache.size >= 256) cache.delete(cache.keys().next().value as string);
    cache.set(source, statement);
    return statement;
  };
}

/**
 * Opens `<data>/brain.db`. An empty database gets the current schema; a database made by another schema is refused and left as it is
 * (there are no migrations).
 */
export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, "brain.db"));
  try {
    chmodSync(join(dataDir, "brain.db"), 0o600);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    const source = schema();
    const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) {
      tx(db, () => {
        db.exec(source);
        db.prepare("INSERT INTO instance(key, value) VALUES ('schema_digest', ?)").run(digest);
      });
    } else {
      const known = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instance'").get();
      const row = known ? (db.prepare("SELECT value FROM instance WHERE key='schema_digest'").get() as { value: string } | undefined) : undefined;
      if (row?.value !== digest) throw new Error(`${join(dataDir, "brain.db")} was made by another version of Brain; it is kept as it is and not opened`);
    }
    cacheStatements(db);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** Runs `fn` in one immediate transaction (a savepoint when one is already open). */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function getInstance(db: Db, key: string): string | undefined {
  return (db.prepare("SELECT value FROM instance WHERE key=?").get(key) as { value: string } | undefined)?.value;
}
export function setInstance(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO instance(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
