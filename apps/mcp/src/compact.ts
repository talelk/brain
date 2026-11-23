const MAX_STRING = 800;
const MAX_ITEMS = 40;
const MAX_TOTAL = 24_000;

const cut = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}... [truncated, ${text.length - limit} more characters]`);

const shrink = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") return cut(value, MAX_STRING);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => shrink(item, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `... [${value.length - MAX_ITEMS} more items not shown]`] : items;
  }
  if (value !== null && typeof value === "object") {
    if (depth > 8) return "[nested too deep]";
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shrink(inner, depth + 1)]));
  }
  return value;
};

/** An answer as an LLM reads it: long text and long lists cut with a note saying so, and the whole kept under a size. */
export const compact = (value: unknown): string => cut(JSON.stringify(shrink(value, 0)) ?? "null", MAX_TOTAL);

/** The text of a file, cut at `limit` characters with a note. */
export const compactText = (text: string, limit = 20_000): string => cut(text, limit);
