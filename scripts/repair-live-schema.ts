import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadSchemaSql, openDb, schemaDigest, type Db } from "../apps/governor/src/infrastructure/persistence/open";

/**
 * One-time in-place repair for existing deployments (ADR 0001: live databases
 * are repaired, not reset). The schema files under apps/governor/schema are
 * the single owner; when a database predates a schema-file change the digest
 * check refuses it. This script:
 *   1. creates every table the current schema file declares that the live
 *      database lacks,
 *   2. verifies that the columns of every existing declared table match the
 *      file and refuses with a precise diff on structural divergence,
 *   3. rebuilds the tables in REBUILDABLE whose definition (keys, foreign
 *      keys, constraints) differs from the file, copying every row and
 *      recreating their indexes, and rolls back if a foreign key check fails,
 *   4. realigns the stored schema digest so the current build accepts the
 *      database.
 * Apart from the declared rebuilds, which copy rows unchanged, existing
 * tables and rows are never touched. Idempotent: a second run is a no-op.
 * Run before initialize-local.ts on deploy.
 */

/**
 * Tables whose definition may change in place. Releases became owned per
 * organization (primary key (organization_id, digest)); active_config and
 * jobs reference them through that composite key. Parents come first.
 */
const REBUILDABLE = ["config_releases", "active_config", "jobs"];

const dataDir = process.env["BRAIN_DATA_DIR"] ?? "/data";

interface DeclaredTable { name: string; body: string; columns: string[] }

/** Index-scanned CREATE TABLE reader; avoids catastrophic-backtracking regexes. */
function parseTables(sql: string): DeclaredTable[] {
  const tables: DeclaredTable[] = [];
  const lower = sql.toLowerCase();
  let i = 0;
  while ((i = lower.indexOf("create table", i)) !== -1) {
    let j = i + "create table".length;
    const skipWs = (p: number) => { while (p < sql.length && /\s/u.test(sql[p]!)) p++; return p; };
    j = skipWs(j);
    if (lower.startsWith("if not exists", j)) j = skipWs(j + "if not exists".length);
    const nameStart = j;
    while (j < sql.length && /[\w"]/u.test(sql[j]!)) j++;
    const name = sql.slice(nameStart, j).replaceAll('"', "");
    const open = sql.indexOf("(", j);
    if (open === -1) { i = j; continue; }
    let depth = 0;
    let end = open;
    for (; end < sql.length; end++) {
      const ch = sql[end];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
    }
    const body = sql.slice(open + 1, end);
    if (/^\s*strict\s*;/iu.test(sql.slice(end + 1, end + 21))) tables.push({ name, body, columns: splitColumns(body) });
    i = end + 1;
  }
  return tables;
}

/** The top-level comma-separated parts of a CREATE TABLE body, in order. */
function splitParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const ch of body) {
    if (ch === "(" || ch === "{") depth++;
    if (ch === ")" || ch === "}") depth--;
    if (ch === "," && depth === 0) { parts.push(part); part = ""; } else part += ch;
  }
  parts.push(part);
  return parts;
}

function splitColumns(body: string): string[] {
  return splitParts(body).flatMap(columnOf).filter(Boolean);
}

/** The schema file's definition of one column, e.g. `auto_start INTEGER NOT NULL DEFAULT 1`. */
function columnDefinition(body: string, column: string): string | undefined {
  return splitParts(body).map((part) => part.trim()).find((part) => columnOf(part)[0] === column);
}

function columnOf(part: string): string[] {
  const trimmed = part.trim();
  if (!trimmed || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/iu.test(trimmed)) return [];
  const m = trimmed.match(/^(?:"([^"]+)"|([A-Za-z_]\w*))/u);
  return m ? [(m[1] ?? m[2]) as string] : [];
}

function actualColumns(db: Db, table: string): string[] | undefined {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!row) return undefined;
  return (db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name: string }>).map((c) => c.name);
}

const normalize = (text: string): string => text.replace(/\s+/gu, " ").replace(/\s*([(),])\s*/gu, "$1").trim();

/** The body between the outer parentheses of the live CREATE TABLE statement. */
function actualBody(db: Db, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
  return row.sql.slice(row.sql.indexOf("(") + 1, row.sql.lastIndexOf(")"));
}

/** The schema file's CREATE INDEX statements for one table. */
function indexStatements(sql: string, table: string): string[] {
  return sql.split(";").map((s) => s.trim()).filter((s) => (s.startsWith("CREATE INDEX ") || s.startsWith("CREATE UNIQUE INDEX ")) && s.includes(` ON ${table}(`));
}

/**
 * Creates the indexes and full-text tables the schema file declares that the database lacks. A table created by the
 * repair, or an index/FTS table added to the file later, would otherwise never exist on a live database (the file is
 * the single owner of the schema, so what it declares must exist).
 */
function ensureAuxiliaryObjects(db: Db, sql: string, label: string): void {
  for (const raw of sql.split(";")) {
    const statement = raw.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim();
    const match = /^CREATE (?:UNIQUE )?(?:INDEX|VIRTUAL TABLE) (?:IF NOT EXISTS )?([A-Za-z0-9_]+)/iu.exec(statement);
    if (!match) continue;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(match[1])) continue;
    db.exec(statement);
    console.log(`  ${label}: created ${match[1]}`);
  }
}

/** Rebuilds diverged REBUILDABLE tables from the file, keeping every row. */
function rebuildTables(db: Db, sql: string, tables: DeclaredTable[], label: string): void {
  // The pragma is a no-op inside a transaction, so it brackets it.
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const t of tables) {
        const temp = `${t.name}__rebuild`;
        const columns = t.columns.map((c) => `"${c}"`).join(",");
        db.exec(`CREATE TABLE ${temp} (${t.body}) STRICT`);
        db.exec(`INSERT INTO ${temp}(${columns}) SELECT ${columns} FROM ${t.name}`);
        db.exec(`DROP TABLE ${t.name}`);
        db.exec(`ALTER TABLE ${temp} RENAME TO ${t.name}`);
        for (const statement of indexStatements(sql, t.name)) db.exec(statement);
        const kept = (db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number }).n;
        console.log(`  ${label}: rebuilt table ${t.name} (${kept} rows kept)`);
      }
      for (const t of tables) {
        const violations = db.prepare(`PRAGMA foreign_key_check(${t.name})`).all();
        if (violations.length) throw new Error(`${label}: rebuilt table ${t.name} has ${violations.length} foreign key violations; rolled back`);
      }
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/** Creates missing tables, verifies existing ones, rebuilds declared ones, returns the digest to store. */
function repairNamespace(db: Db, sql: string, label: string): string {
  const declared = parseTables(sql);
  const rebuild: DeclaredTable[] = [];
  for (const t of declared) {
    const actual = actualColumns(db, t.name);
    if (!actual) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${t.name} (${t.body}) STRICT`);
      console.log(`  ${label}: created table ${t.name}`);
    } else {
      let missing = t.columns.filter((c) => !actual.includes(c));
      const extra = actual.filter((c) => !t.columns.includes(c));
      // A column the schema file declares with a DEFAULT can be added in place without touching any row.
      // Anything else (extra columns, a NOT NULL column without a default) still refuses to realign.
      if (!extra.length) {
        for (const column of missing) {
          const definition = columnDefinition(t.body, column);
          if (definition && /\bDEFAULT\b/iu.test(definition)) {
            db.exec(`ALTER TABLE ${t.name} ADD COLUMN ${definition}`);
            console.log(`  ${label}: added column ${t.name}.${column} (default applied to existing rows)`);
          }
        }
        missing = t.columns.filter((c) => !(actualColumns(db, t.name) ?? []).includes(c));
      }
      if (missing.length || extra.length) {
        throw new Error(`${label}: table ${t.name} diverges from the schema file (missing: ${missing.join(",") || "-"}; extra: ${extra.join(",") || "-"}); refusing to realign`);
      }
      if (REBUILDABLE.includes(t.name) && normalize(actualBody(db, t.name)) !== normalize(t.body)) rebuild.push(t);
    }
  }
  if (rebuild.length) rebuildTables(db, sql, rebuild.sort((a, b) => REBUILDABLE.indexOf(a.name) - REBUILDABLE.indexOf(b.name)), label);
  ensureAuxiliaryObjects(db, sql, label);
  return schemaDigest(sql);
}

function setControlDigest(db: Db, digest: string): void {
  const changed = db.prepare("UPDATE schema_metadata SET schema_digest=? WHERE singleton=1").run(digest).changes;
  if (!changed) db.prepare("INSERT INTO schema_metadata(singleton, schema_version, schema_digest, initialized_at_ms) VALUES (1, 1, ?, ?)").run(digest, Date.now());
}

function setWorkspaceDigest(db: Db, digest: string): void {
  const changed = db.prepare("UPDATE workspace_identity SET schema_digest=? WHERE singleton=1").run(digest).changes;
  if (!changed) throw new Error("workspace database has no singleton workspace_identity row; refusing to guess identity");
}

function setAuthDigest(db: Db, digest: string): void {
  const changed = db.prepare("UPDATE auth_schema_metadata SET digest=? WHERE singleton=1").run(digest).changes;
  if (!changed) db.prepare("INSERT INTO auth_schema_metadata VALUES (1,?)").run(digest);
}

const controlPath = join(dataDir, "control.db");
const wsDir = join(dataDir, "workspaces");

if (existsSync(controlPath)) {
  const db = openDb(controlPath);
  try {
    const digest = repairNamespace(db, loadSchemaSql("control.sql"), "control.db");
    setControlDigest(db, digest);
    console.log(`control.db repaired -> ${digest.slice(0, 18)}...`);
    // The auth namespace lives inside control.db (createBrainAuth binds to
    // store.control); its digest binds auth.sql + auth-security.sql together.
    const authPopulated = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user'").get();
    if (authPopulated) {
      const vendorSql = readFileSync(join(process.cwd(), "apps/governor/schema/auth.sql"), "utf8");
      const securitySql = readFileSync(join(process.cwd(), "apps/governor/schema/auth-security.sql"), "utf8");
      const authDigest = `sha256:${createHash("sha256").update(vendorSql).update(securitySql).digest("hex")}`;
      const metaTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_schema_metadata'").get();
      const stored = metaTable ? (db.prepare("SELECT digest FROM auth_schema_metadata WHERE singleton=1").get() as { digest: string } | undefined) : undefined;
      if (stored?.digest !== authDigest) {
        repairNamespace(db, securitySql, "control.db/auth");
        setAuthDigest(db, authDigest);
        console.log(`control.db/auth repaired -> ${authDigest.slice(0, 18)}...`);
      } else console.log("control.db/auth digest already current");
    }
  } finally { db.close(); }
}

for (const file of existsSync(wsDir) ? readdirSync(wsDir).filter((f) => f.endsWith(".db")) : []) {
  const db = openDb(join(wsDir, file));
  try {
    const digest = repairNamespace(db, loadSchemaSql("workspace.sql"), file);
    setWorkspaceDigest(db, digest);
    console.log(`${file} repaired -> ${digest.slice(0, 18)}...`);
  } finally { db.close(); }
}

console.log("live schema repair complete");
