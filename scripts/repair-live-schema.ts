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
 *      database lacks (additive only — existing tables are never rewritten),
 *   2. verifies that the columns of every existing declared table match the
 *      file and refuses with a precise diff on structural divergence,
 *   3. realigns the stored schema digest so the current build accepts the
 *      database.
 * Rows are never touched. Idempotent: exits 0 as a no-op when digests already
 * match. Run before initialize-local.ts on deploy.
 */

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

function splitColumns(body: string): string[] {
  const columns: string[] = [];
  let depth = 0;
  let part = "";
  for (const ch of body) {
    if (ch === "(" || ch === "{") depth++;
    if (ch === ")" || ch === "}") depth--;
    if (ch === "," && depth === 0) { columns.push(...columnOf(part)); part = ""; } else part += ch;
  }
  columns.push(...columnOf(part));
  return columns.filter(Boolean);
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

/** Creates missing tables, verifies existing ones, returns the digest to store. */
function repairNamespace(db: Db, sql: string, label: string): string {
  const declared = parseTables(sql);
  for (const t of declared) {
    const actual = actualColumns(db, t.name);
    if (!actual) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${t.name} (${t.body}) STRICT`);
      console.log(`  ${label}: created table ${t.name}`);
    } else {
      const missing = t.columns.filter((c) => !actual.includes(c));
      const extra = actual.filter((c) => !t.columns.includes(c));
      if (missing.length || extra.length) {
        throw new Error(`${label}: table ${t.name} diverges from the schema file (missing: ${missing.join(",") || "-"}; extra: ${extra.join(",") || "-"}); refusing to realign`);
      }
    }
  }
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
