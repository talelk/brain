import type { LogRecord } from "./LogTail";
import type { LogRowModel } from "./LogRow";

/**
 * Error navigation (T61): jump to the first failed operation with surrounding
 * context. "Failed operation" means a record the projector classified as
 * `error` or `critical` — failed tool results, errored sessions, quarantine —
 * so the jump target is the first authoritative failure in the visible order,
 * never an invented summary.
 */

interface FailureJump {
  /** Index into the displayed row list (grouped rows included). */
  readonly index: number;
  readonly record: LogRecord;
  /** The record's own failure text, for the jump affordance's title. */
  readonly reason: string;
}

const isFailure = (record: LogRecord): boolean => record.severity === "error" || record.severity === "critical";

/** The records behind one displayed row, in order. */
export function rowMembers(row: LogRowModel): readonly LogRecord[] {
  switch (row.kind) {
    case "tool": return row.members;
    case "repeat": return [...row.members];
    default: return [row.record];
  }
}

/** The first displayed row whose records include a failure, if any. */
export function failureJump(rows: readonly LogRowModel[]): FailureJump | undefined {
  for (const [index, row] of rows.entries()) {
    const failed = rowMembers(row).find(isFailure);
    if (failed) return { index, record: failed, reason: failureReason(failed) };
  }
  return undefined;
}

function failureReason(record: LogRecord): string {
  const summary = record.summary;
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    const payload = summary as Record<string, unknown>;
    const receipt = payload["receipt"];
    if (receipt && typeof receipt === "object") {
      const result = (receipt as Record<string, unknown>)["result"];
      if (typeof result === "string") return `tool result ${result}`;
    }
    if (typeof payload["reason"] === "string" && payload["reason"].length > 0) return `session stopped: ${payload["reason"]}`;
    const error = payload["error"];
    if (error && typeof error === "object") {
      const detail = (error as Record<string, unknown>)["message"] ?? (error as Record<string, unknown>)["code"];
      if (typeof detail === "string") return detail;
    }
  }
  return record.type;
}

/**
 * The surrounding records rendered beside a jumped-to failure: a bounded run
 * of the records immediately before it (what led up to the failure) and after
 * it (what the failure triggered), taken from the flat record order.
 */
export function contextAround(rows: readonly LogRowModel[], anchor: LogRecord, before = 3, after = 3): readonly LogRecord[] {
  const flat = rows.flatMap(rowMembers);
  const at = flat.findIndex((record) => record.eventId === anchor.eventId && record.streamSeq === anchor.streamSeq);
  if (at < 0) return [];
  return flat.slice(Math.max(0, at - before), Math.min(flat.length, at + after + 1));
}
