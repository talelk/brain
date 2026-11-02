import type { LiveStatus, SessionContinuation, SessionDetail } from "@brain/contracts";
import { fetchView } from "./governor";

/**
 * The Live console's typed reads (T60). The console experience owns session
 * selection, steering controls and the default-landing gate; sessions.list and
 * jobs.list reuse the shared wrappers in data/governor.ts. Wire shapes are the
 * generated contracts (LiveStatus, SessionContinuation, SessionDetail).
 */

export type { LiveStatus, SessionContinuation, SessionDetail };

/** `live.status` snapshot — the cheap landing gate behind the default route. */
export const liveStatusQuery = (workspaceId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "live.status", workspaceId }, signal);

/** `session.get` extended with the stream cursor and continuation facts. */
export const sessionDetailQuery = (workspaceId: string, sessionId: string, signal?: AbortSignal) =>
  fetchView({ queryType: "session.get", workspaceId, resourceId: sessionId }, signal);
