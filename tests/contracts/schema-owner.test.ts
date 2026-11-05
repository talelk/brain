import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeFresh, loadSchemaSql, openDb } from "../../apps/governor/src/infrastructure/persistence/open";
import { createBrainAuth } from "../../apps/governor/src/modules/identity/index";

/**
 * Schema ownership: the SQL files under apps/governor/schema are the single
 * authority. A fresh database must contain every table the code queries —
 * no lazy CREATE TABLE at first use — and no governor source may define
 * tables inline.
 */

const schemaFile = (name: string) => readFileSync(join(process.cwd(), "apps/governor/schema", name), "utf8");

function tables(db: ReturnType<typeof openDb>): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
}

function sourceFiles(dir: string, extensions = [".ts"]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path, extensions));
    else if (extensions.some((e) => entry.name.endsWith(e))) found.push(path);
  }
  return found;
}

describe("schema single owner", () => {
  it("a fresh control database carries the full control schema without running any job", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-schema-control-"));
    try {
      const db = openDb(join(root, "control.db"));
      initializeFresh(db, loadSchemaSql("control.sql"));
      const names = tables(db);
      for (const table of ["job_payloads", "attempt_events", "job_outputs", "memory_assets", "schema_metadata"]) {
        expect(names.has(table), `control.db missing ${table}`).toBe(true);
      }
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a fresh workspace database carries the full workspace schema without running any workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-schema-workspace-"));
    try {
      const db = openDb(join(root, "workspace.db"));
      initializeFresh(db, loadSchemaSql("workspace.sql"), { workspaceId: "ws-1", organizationId: "org-1" });
      const names = tables(db);
      for (const table of ["workspace_identity", "session_controls", "run_inputs", "step_outputs", "engine_links", "engine_resumes", "source_observations", "parked_observations"]) {
        expect(names.has(table), `workspace.db missing ${table}`).toBe(true);
      }
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("the auth namespace applies the Brain security file with the vendor schema under one digest", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-schema-auth-"));
    try {
      const db = openDb(join(root, "auth.db"));
      createBrainAuth(db, { secret: "schema-test-secret-0123456789abcdef", baseURL: "http://127.0.0.1:3100" });
      const names = tables(db);
      for (const table of ["brain_auth_recovery", "brain_initial_password", "auth_email_outbox", "auth_security_events", "auth_schema_metadata"]) {
        expect(names.has(table), `auth namespace missing ${table}`).toBe(true);
      }
      const expected = `sha256:${createHash("sha256").update(schemaFile("auth.sql")).update(schemaFile("auth-security.sql")).digest("hex")}`;
      const row = db.prepare("SELECT digest FROM auth_schema_metadata WHERE singleton=1").get() as { digest: string };
      expect(row.digest).toBe(expected);
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("no source defines a table inline; the schema files are the only authority", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "apps/governor/src"))) {
      if (/CREATE\s+TABLE/iu.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    // Tests and scripts may seed rows but never lazily create schema tables.
    // scripts/repair-live-schema.ts is the designated in-place repair path
    // (ADR 0001): it instantiates tables declared by the schema files, never
    // inline definitions, so it is exempt from the IF NOT EXISTS scan.
    for (const dir of ["tests", "scripts"]) {
      for (const file of sourceFiles(join(process.cwd(), dir), [".ts", ".py"])) {
        if (file.endsWith("repair-live-schema.ts")) continue;
        if (/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/iu.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    expect(existsSync(join(process.cwd(), "sql/reference/control.sql"))).toBe(false);
  });
});
