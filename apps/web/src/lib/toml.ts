/**
 * Writes the workspace's TOML files from the forms. Only what those files use: strings, numbers, booleans, lists, tables and
 * lists of tables. A long or multi-line string is written as a `"""` block so a goal or a description stays readable in the file.
 */
export type TomlValue = string | number | boolean | readonly TomlValue[] | TomlTable | undefined;
export interface TomlTable { readonly [key: string]: TomlValue }

const isTable = (value: TomlValue): value is TomlTable => typeof value === "object" && value !== null && !Array.isArray(value);
const isTableList = (value: TomlValue): value is readonly TomlTable[] => Array.isArray(value) && value.length > 0 && value.every(isTable);
const key = (name: string): string => (/^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name));
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function text(value: string): string {
  if (!value.includes("\n") && value.length <= 100) return JSON.stringify(value);
  const body = value.replaceAll("\\", "\\\\").replaceAll('"""', '""\\"');
  return `"""\n${body}"""`;
}

function scalar(value: TomlValue, name: string): string {
  if (typeof value === "string") return name === "until" && DATE.test(value) ? value : text(value);
  if (Array.isArray(value)) return `[${value.map((item: TomlValue) => (isTable(item) ? inline(item) : scalar(item, ""))).join(", ")}]`;
  if (isTable(value)) return inline(value);
  return String(value);
}

const inline = (table: TomlTable): string => `{ ${Object.entries(table).filter(([, value]) => value !== undefined).map(([name, value]) => `${key(name)} = ${scalar(value, name)}`).join(", ")} }`;

function table(value: TomlTable, path: readonly string[], out: string[]): void {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  for (const [name, item] of entries) if (!isTable(item) && !isTableList(item)) out.push(`${key(name)} = ${scalar(item, name)}`);
  for (const [name, item] of entries) {
    const next = [...path, key(name)];
    if (isTableList(item)) {
      for (const row of item) { out.push("", `[[${next.join(".")}]]`); table(row, next, out); }
    } else if (isTable(item)) {
      // A table that only holds tables (`[inputs]`, `[approvals]`) needs no header of its own.
      if (Object.values(item).some((child) => child !== undefined && !isTable(child) && !isTableList(child))) out.push("", `[${next.join(".")}]`);
      table(item, next, out);
    }
  }
}

export function toToml(value: TomlTable): string {
  const out: string[] = [];
  table(value, [], out);
  return `${out.join("\n").replace(/^\n+/u, "")}\n`;
}

/** Drops what a file does not need to say: empty lists, empty text and empty tables. */
export function compact(value: TomlTable): TomlTable {
  const out: Record<string, TomlValue> = {};
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined || item === "" || (Array.isArray(item) && item.length === 0)) continue;
    if (isTable(item)) { const inner = compact(item); if (Object.keys(inner).length > 0) out[name] = inner; continue; }
    out[name] = isTableList(item) ? item.map(compact) : item;
  }
  return out;
}
