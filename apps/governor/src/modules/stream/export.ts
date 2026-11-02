import type { ActorContext, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { EXPORT_LIMIT, readBetween, type StreamFilters } from "./query";

/**
 * Bounded sanitized log-segment export. Lines carry stream identity, source,
 * severity and time plus the bounded summary; payloads appear only as
 * references. Authorization is identical to reads (same scoping code path).
 */

export interface StreamExport {
  filename: string;
  body: string;
  count: number;
}

export function exportSegment(store: Store, actor: ActorContext, filters: StreamFilters, rawLimit?: number): StreamExport {
  const limit = Math.min(Math.max(Math.floor(rawLimit ?? 1000) || 1000, 1), EXPORT_LIMIT);
  const records = readBetween(store, actor, filters, limit);
  const lines = records.map((record) => JSON.stringify({
    streamSeq: record.streamSeq,
    eventId: record.eventId,
    emitter: record.emitter,
    eventType: record.eventType,
    severity: record.severity,
    at: record.at,
    ...(record.correlation ? { correlation: record.correlation } : {}),
    summary: record.summary,
  } as unknown as JsonValue));
  const from = records[0]?.streamSeq ?? filters.after ?? 0;
  const to = records[records.length - 1]?.streamSeq ?? filters.after ?? 0;
  const scope = filters.workspaceId ?? "org";
  return {
    filename: `brain-logs-${scope}-${from}-${to}.ndjson`,
    body: lines.join("\n"),
    count: records.length,
  };
}
