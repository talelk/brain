import { createHash } from "node:crypto";

/**
 * One trace identifier per mission (Phase 4): the W3C trace-id shape (32 lowercase hex characters), derived from the mission id so it
 * needs no storage and every part of Brain computes the same value. It rides in the payload of every event that names a mission, so the
 * Logs view and the execution stream show it, and it is what a runner or an operator greps for. It is never a metric label: a mission
 * id as a label would make every mission a new time series.
 */
export function missionTraceId(missionId: string): string {
  return createHash("sha256").update(`brain:trace:v1:${missionId}`).digest("hex").slice(0, 32);
}

/** The event payload with the mission's trace id added when it names one (an event of a mission, or a `missionId` in the payload). */
export function withTrace<T>(aggregateType: string, aggregateId: string, payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (typeof record["traceId"] === "string") return payload;
  const missionId = typeof record["missionId"] === "string" ? record["missionId"] : aggregateType === "mission" ? aggregateId : undefined;
  return missionId ? ({ ...record, traceId: missionTraceId(missionId) } as T) : payload;
}
