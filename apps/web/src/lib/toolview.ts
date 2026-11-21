/** How a tool's output is shown to a person: the shape it has, found from the text, never from the tool's name. */
export type View =
  | { readonly kind: "error"; readonly message: string; readonly rest: readonly (readonly [string, unknown])[] }
  | { readonly kind: "table"; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "fields"; readonly fields: readonly (readonly [string, unknown])[] }
  | { readonly kind: "text"; readonly text: string };

const cell = (value: unknown): string => (value === null || value === undefined ? "" : typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A list of flat objects is a table: the columns are the keys, in the order first met. */
export function tableOf(list: readonly unknown[]): View | null {
  if (list.length === 0 || !list.every(isRecord)) return null;
  const header: string[] = [];
  for (const row of list) for (const key of Object.keys(row)) if (!header.includes(key)) header.push(key);
  if (header.length === 0 || header.length > 8) return null;
  return { kind: "table", header, rows: list.map((row) => header.map((key) => cell(row[key]))) };
}

/** Lines of the same number (two or more) of tab-separated cells, as `docker ps --format` or `df` print them, are a table. */
function tabular(text: string): View | null {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) return null;
  const rows = lines.map((line) => line.split("\t"));
  const width = rows[0]?.length ?? 0;
  if (width < 2 || !rows.every((row) => row.length === width)) return null;
  return { kind: "table", header: rows[0] as string[], rows: rows.slice(1) };
}

export function viewOf(output: string): View {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return tabular(output) ?? { kind: "text", text: output }; }
  if (Array.isArray(parsed)) return tableOf(parsed) ?? { kind: "text", text: output };
  if (!isRecord(parsed)) return { kind: "text", text: output };
  const entries = Object.entries(parsed);
  if (typeof parsed["error"] === "string") return { kind: "error", message: parsed["error"], rest: entries.filter(([key]) => key !== "error") };
  return entries.length === 0 ? { kind: "text", text: output } : { kind: "fields", fields: entries };
}
