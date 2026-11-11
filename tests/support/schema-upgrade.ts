import Database from "better-sqlite3";

export interface NewColumn { table: string; column: string; notNull: boolean; hasDefault: boolean }

/** Every column the new schema has on a table that already exists in the old schema, with whether it declares a DEFAULT. */
export function addedColumns(oldSql: string, newSql: string): NewColumn[] {
  const oldDb = new Database(":memory:");
  const newDb = new Database(":memory:");
  try {
    oldDb.exec(oldSql);
    newDb.exec(newSql);
    const tables = (newDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
    const added: NewColumn[] = [];
    for (const table of tables) {
      const oldColumns = oldDb.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
      if (!oldColumns.length) continue; // a new table is created whole by the repair
      const known = new Set(oldColumns.map((c) => c.name));
      for (const c of newDb.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>) {
        if (!known.has(c.name)) added.push({ table, column: c.name, notNull: c.notnull === 1, hasDefault: c.dflt_value !== null });
      }
    }
    return added;
  } finally { oldDb.close(); newDb.close(); }
}

/** The loud message for columns the live schema repair cannot add in place. */
export function describeMissingDefaults(columns: NewColumn[]): string {
  const bad = columns.filter((c) => !c.hasDefault);
  return bad.length
    ? `New column(s) on existing tables must declare DEFAULT (use DEFAULT NULL for nullable) or the live deploy leaves the Governor stopped: ${bad.map((c) => `${c.table}.${c.column}`).join(", ")}. See docs/wiki/ops-live-server.md.`
    : "";
}
