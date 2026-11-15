import type { BrainSession } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import { enqueueSessionControl } from "./controls";

/**
 * Pausing one session (ADR 0058). A person holds a running session at its next turn boundary and continues it later. The attempt stays
 * alive: it keeps its fence, its lease (the runner goes on renewing it) and its runner slot, and the mission is untouched. What changes is
 * the clocks: a held session is not working time (ADR 0016) and does not run down its step's timeout (ADR 0046), and it may hold the slot
 * only for the hold limit, after which the Governor stops it like any other stop (its saved conversation can be resumed from the checkpoint).
 *
 * The facts live in `attempt_pauses`, one row per pause. The commands are level-triggered: every heartbeat of the runner that holds the
 * attempt carries what it should do until the runner reports it did it, so a lost acknowledgement is only a delay.
 */

const DEFAULT_PAUSE_HOLD_MINUTES = 30;

/** How long a paused session may hold its runner slot; BRAIN_SESSION_PAUSE_HOLD_MINUTES overrides the default. */
function pauseHoldLimitMs(): number {
  const minutes = Number(process.env["BRAIN_SESSION_PAUSE_HOLD_MINUTES"] ?? DEFAULT_PAUSE_HOLD_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_PAUSE_HOLD_MINUTES) * 60_000;
}

interface PauseRow {
  id: string; attempt_id: string; requested_by: string; requested_at_ms: number;
  paused_at_ms: number | null; continue_requested_at_ms: number | null; resumed_at_ms: number | null;
}

interface SessionAttempt { sessionId: string; attemptId: string; features: string[]; engineId: string }

const LIVE = "('running')";

function openPause(store: Store, attemptId: string): PauseRow | undefined {
  return store.control.prepare("SELECT * FROM attempt_pauses WHERE attempt_id=? AND resumed_at_ms IS NULL").get(attemptId) as PauseRow | undefined;
}

/** The running attempt a session is bound to, with what its engine can do; NOT_FOUND / CONFLICT in plain words otherwise. */
function pausableAttempt(store: Store, organizationId: string, workspaceId: string, sessionId: string): SessionAttempt {
  const db = store.workspaceDb(workspaceId, organizationId);
  const session = db.prepare("SELECT id, state, attempt_id, engine_id, engine_features FROM sessions WHERE id=?").get(sessionId) as
    { id: string; state: string; attempt_id: string | null; engine_id: string; engine_features: string } | undefined;
  if (!session) throw new BrainDomainError("NOT_FOUND", `session ${sessionId} not found in this workspace`);
  if (session.state !== "running" || !session.attempt_id) throw new BrainDomainError("CONFLICT", `session ${sessionId} is not running (${session.state}), so it cannot be paused or continued`);
  const attempt = store.control.prepare(`SELECT state FROM job_attempts WHERE id=? AND state IN ${LIVE}`).get(session.attempt_id);
  if (!attempt) throw new BrainDomainError("CONFLICT", `session ${sessionId} has no running attempt, so it cannot be paused or continued`);
  let features: string[] = [];
  try { features = (JSON.parse(session.engine_features) as unknown[]).filter((f): f is string => typeof f === "string"); } catch { features = []; }
  return { sessionId, attemptId: session.attempt_id, features, engineId: session.engine_id };
}

/** Why a session's engine cannot be paused, in plain words; undefined when it can. */
export function pauseUnsupportedReason(engineId: string, features: readonly string[]): string | undefined {
  if (features.includes("pause")) return undefined;
  return `${engineId === "unknown" || !engineId ? "This engine" : engineId} cannot stop at a turn boundary, so this session cannot be paused. You can still steer or stop it.`;
}

/** A person asks for a pause: taken at the engine's next turn boundary. Asking again while one is pending is a no-op. */
export function requestSessionPause(store: Store, input: { organizationId: string; workspaceId: string; sessionId: string; actorId: string }): void {
  const target = pausableAttempt(store, input.organizationId, input.workspaceId, input.sessionId);
  const unsupported = pauseUnsupportedReason(target.engineId, target.features);
  if (unsupported) throw new BrainDomainError("UNSUPPORTED_CAPABILITY", unsupported);
  const db = store.workspaceDb(input.workspaceId, input.organizationId);
  store.inTx(store.control, () => {
    const open = openPause(store, target.attemptId);
    if (open) {
      if (open.continue_requested_at_ms !== null) throw new BrainDomainError("CONFLICT", "this session is being continued; pause it again once it is running");
      return;
    }
    store.control.prepare("INSERT INTO attempt_pauses(id, attempt_id, requested_by, requested_at_ms) VALUES (?,?,?,?)").run(store.id("pau"), target.attemptId, input.actorId, store.now());
    store.emit(db, { aggregateType: "session", aggregateId: input.sessionId, eventType: "session.paused", payload: { sessionId: input.sessionId, state: "requested" } });
  });
}

/** A person asks to continue a paused (or pausing) session; the runner confirms when the engine runs again. Continuing a running session is a no-op. */
export function requestSessionContinue(store: Store, input: { organizationId: string; workspaceId: string; sessionId: string }): void {
  const target = pausableAttempt(store, input.organizationId, input.workspaceId, input.sessionId);
  const db = store.workspaceDb(input.workspaceId, input.organizationId);
  store.inTx(store.control, () => {
    const open = openPause(store, target.attemptId);
    if (!open || open.continue_requested_at_ms !== null) return;
    store.control.prepare("UPDATE attempt_pauses SET continue_requested_at_ms=? WHERE id=?").run(store.now(), open.id);
    store.emit(db, { aggregateType: "session", aggregateId: input.sessionId, eventType: "session.continued", payload: { sessionId: input.sessionId, state: "requested" } });
  });
}

/**
 * What the runner holding an attempt should do about its pause, if anything. One command per attempt, identified by the pause and its step so
 * the runner applies each once however often the heartbeat repeats it.
 */
export function pauseCommandFor(store: Store, attemptId: string): { commandId: string; type: "pause-attempt" | "continue-attempt" } | undefined {
  const open = openPause(store, attemptId);
  if (!open) return undefined;
  if (open.continue_requested_at_ms !== null) return { commandId: `${open.id}:continue`, type: "continue-attempt" };
  if (open.paused_at_ms === null) return { commandId: `${open.id}:pause`, type: "pause-attempt" };
  return undefined;
}

/**
 * The runner reports its engine held at a boundary (`session-paused`) or running again (`session-continued`). Called while the event batch is
 * stored, on the Governor's clock. A pause the person cancelled before the engine reached a boundary closes with no held time.
 */
export function recordPauseProgress(store: Store, attemptId: string, phase: string): number {
  if (phase !== "session-paused" && phase !== "session-continued") return 0;
  const open = openPause(store, attemptId);
  if (!open) return 0;
  let heldMs = 0;
  const now = store.now();
  if (phase === "session-paused") {
    if (open.paused_at_ms !== null) return 0;
    store.control.prepare("UPDATE attempt_pauses SET paused_at_ms=? WHERE id=?").run(now, open.id);
  } else {
    if (open.continue_requested_at_ms === null) return 0;
    store.control.prepare("UPDATE attempt_pauses SET resumed_at_ms=? WHERE id=?").run(now, open.id);
    // The time the engine was held must not run down the step's timeout: the caller (the jobs module owns attempts) moves the deadline by exactly that long.
    if (open.paused_at_ms !== null) heldMs = now - open.paused_at_ms;
  }
  // Open screens learn of it the way they learn of any change: an event on the session.
  const owner = store.control.prepare("SELECT j.organization_id AS organizationId, j.workspace_id AS workspaceId FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?").get(attemptId) as { organizationId: string; workspaceId: string } | undefined;
  if (!owner) return heldMs;
  const db = store.workspaceDb(owner.workspaceId, owner.organizationId);
  const session = db.prepare("SELECT id FROM sessions WHERE attempt_id=?").get(attemptId) as { id: string } | undefined;
  if (session) store.emit(db, { aggregateType: "session", aggregateId: session.id, eventType: phase === "session-paused" ? "session.paused" : "session.continued", payload: { sessionId: session.id, state: phase === "session-paused" ? "paused" : "running" } });
  return heldMs;
}

/** The time ranges an attempt was held (a range still open is held until `until`). */
export function heldRanges(store: Store, attemptId: string, until: number): Array<readonly [number, number]> {
  const rows = store.control.prepare("SELECT paused_at_ms, resumed_at_ms FROM attempt_pauses WHERE attempt_id=? AND paused_at_ms IS NOT NULL ORDER BY paused_at_ms").all(attemptId) as Array<{ paused_at_ms: number; resumed_at_ms: number | null }>;
  return rows.map((row) => [row.paused_at_ms, row.resumed_at_ms ?? until] as const);
}

/** The pause facts of a session as the views show them. */
export function pauseView(store: Store, session: { state: string; attemptId: string | null; engineId: string; engineFeatures: readonly string[] }): NonNullable<BrainSession["pause"]> {
  const holdLimitMs = pauseHoldLimitMs();
  const running = session.state === "running" && session.attemptId !== null;
  const reason = !running ? "This session is not running." : pauseUnsupportedReason(session.engineId, session.engineFeatures);
  const open = session.attemptId ? openPause(store, session.attemptId) : undefined;
  if (!open || !running) return { supported: reason === undefined, ...(reason ? { reason } : {}), state: "running", holdLimitMs };
  if (open.continue_requested_at_ms !== null) return { supported: true, state: "resuming", since: iso(open.continue_requested_at_ms), holdLimitMs };
  if (open.paused_at_ms === null) return { supported: true, state: "pausing", since: iso(open.requested_at_ms), holdLimitMs };
  return { supported: true, state: "paused", since: iso(open.paused_at_ms), stopsAt: iso(open.paused_at_ms + holdLimitMs), holdLimitMs };
}

/**
 * Stops the sessions held longer than the hold limit, so a forgotten pause cannot keep a runner slot for ever. The stop is the ordinary one:
 * the attempt ends, its slot is freed, and the engine's saved conversation can be resumed from the checkpoint. Returns how many were stopped.
 */
export function stopOverlongPauses(store: Store): number {
  const due = store.control.prepare(`SELECT p.id AS pauseId, p.attempt_id AS attemptId, j.organization_id AS organizationId, j.workspace_id AS workspaceId
    FROM attempt_pauses p JOIN job_attempts a ON a.id=p.attempt_id JOIN jobs j ON j.id=a.job_id
    WHERE p.resumed_at_ms IS NULL AND p.paused_at_ms IS NOT NULL AND p.paused_at_ms<=? AND a.state='running' ORDER BY p.paused_at_ms LIMIT 200`)
    .all(store.now() - pauseHoldLimitMs()) as Array<{ pauseId: string; attemptId: string; organizationId: string; workspaceId: string }>;
  let stopped = 0;
  for (const item of due) {
    const db = store.workspaceDb(item.workspaceId, item.organizationId);
    const session = db.prepare("SELECT id FROM sessions WHERE attempt_id=? AND state='running'").get(item.attemptId) as { id: string } | undefined;
    if (!session) continue;
    const queued = db.prepare("SELECT 1 AS ok FROM session_controls WHERE session_id=? AND kind='session.stop' AND payload LIKE '%pause-hold-limit%'").get(session.id);
    if (queued) continue;
    const minutes = Math.round(pauseHoldLimitMs() / 60_000);
    enqueueSessionControl(store, { organizationId: item.organizationId, workspaceId: item.workspaceId, sessionId: session.id, kind: "session.stop",
      payload: { sessionId: session.id, reason: `pause-hold-limit: paused for more than ${minutes} minutes` } });
    stopped++;
  }
  return stopped;
}
