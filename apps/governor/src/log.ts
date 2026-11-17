/**
 * The Governor's log: one line per event on stdout, `ts=<iso> level=<level> event=<name> key=value ...`. `LOG_LEVEL` (debug, info, warn,
 * error; default info) sets the least level written. A line names ids, routes, codes and durations, never a secret, a prompt or a result.
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = (): number => LEVELS[(process.env["LOG_LEVEL"] ?? "info").toLowerCase() as LogLevel] ?? LEVELS.info;
const value = (v: unknown): string => {
  const text = String(v).replace(/\s+/gu, " ").slice(0, 200);
  return /^[\w./:@-]+$/u.test(text) ? text : JSON.stringify(text);
};

export function log(level: LogLevel, event: string, fields: Readonly<Record<string, string | number | boolean | undefined>> = {}): void {
  if (LEVELS[level] < threshold()) return;
  const pairs = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${value(v)}`);
  console.log([`ts=${new Date().toISOString()}`, `level=${level}`, `event=${event}`, ...pairs].join(" "));
}

/** What an unexpected error says about itself without its message, which can carry a URL or a value: its name, its code, and where it was thrown. */
export function errorFields(e: unknown): Record<string, string | undefined> {
  if (!(e instanceof Error)) return { error: typeof e };
  const cause = (e.cause ?? undefined) as { code?: unknown } | undefined;
  const code = (e as { code?: unknown }).code ?? cause?.code;
  const frame = /\(?((?:\/|file:)[^\s)]+:\d+):\d+\)?/u.exec(e.stack?.split("\n").slice(1).join("\n") ?? "")?.[1];
  return { error: e.name, ...(typeof code === "string" ? { code } : {}), ...(frame ? { at: frame.split("/").slice(-3).join("/") } : {}) };
}
