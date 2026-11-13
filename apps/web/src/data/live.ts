import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";

/**
 * The one live data bus (phase 2). The Governor's execution stream says "something changed"
 * (`GET /v1/events?live=1&wake=1`); every mounted read re-loads together on that one signal,
 * so a count in the header, a list on a page and the Working-now strip are read at the same
 * moment and cannot disagree for longer than one round trip. Reads never own a timer.
 *
 * This file is the only place in the web app allowed to hold a timer or an EventSource for
 * live data (guarded by tests/domain/live-store.test.ts). Three honest exceptions share it:
 * a fallback pulse while the stream is down, a fast pulse while a screen declares progress
 * that emits no events (a model download, a runner coming online), and one clock for
 * "ago" and countdown labels.
 */

/** Smallest gap between two re-reads; a busy run emits many events a second. */
const MIN_GAP_MS = 1200;
const COALESCE_MS = 300;
/** Re-read pulse while the stream is down. */
const FALLBACK_MS = 10_000;
/** The Governor closes a live stream after 55 s; one open longer than this ended on schedule, not by failure. */
const PLANNED_CLOSE_MS = 45_000;
/** A quiet safety re-read while the stream is up, for things that change without an event (a runner's heartbeat, a countdown reaching zero). */
const HEARTBEAT_MS = 20_000;
/** Re-read pulse while a screen declared progress that emits no events. */
const FAST_MS = 2500;

type Listener = () => undefined | Promise<unknown>;

const listeners = new Set<Listener>();
const [connected, setConnected] = createSignal(false);
const [updatedAt, setUpdatedAt] = createSignal(Date.now());
const [now, setNow] = createSignal(Date.now());
const [clockUsers, setClockUsers] = createSignal(0);
const [slow, setSlow] = createSignal(false);

let source: EventSource | undefined;
let workspace = "";
let enabled = false;
let lastFlush = 0;
let coalesce: ReturnType<typeof setTimeout> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let fallback: ReturnType<typeof setInterval> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let fast: ReturnType<typeof setInterval> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let fastWanted = 0;
let wasDown = false;

function flush(): void {
  coalesce = undefined;
  lastFlush = Date.now();
  const pending: Promise<unknown>[] = [];
  for (const listener of [...listeners]) { try { const result = listener(); if (result) pending.push(Promise.resolve(result).catch(() => undefined)); } catch { /* one read failing never blocks the others */ } }
  // "Updated" is stamped when every read of this pass has landed, so the label never claims a time the screens do not show yet.
  const showSlow = setTimeout(() => setSlow(true), 400);
  void Promise.all(pending).then(() => { clearTimeout(showSlow); setSlow(false); setUpdatedAt(Date.now()); });
}

/** Ask every mounted read to re-load (coalesced). */
export function invalidateLive(options?: { immediate?: boolean }): void {
  if (options?.immediate) { if (coalesce) clearTimeout(coalesce); flush(); return; }
  if (coalesce) return;
  const wait = Math.max(COALESCE_MS, lastFlush + MIN_GAP_MS - Date.now());
  coalesce = setTimeout(flush, wait);
}

/** Re-load now (the Refresh control, and after a command the person just ran). */
export function refreshLiveNow(): void { invalidateLive({ immediate: true }); }

/** A read registers here instead of owning a timer; returns the unsubscribe. */
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  if (!heartbeat && typeof window !== "undefined") heartbeat = setInterval(() => { if (listeners.size > 0 && navigator.onLine !== false) invalidateLive(); }, HEARTBEAT_MS);
  // Before the stream is open (a kiosk, the sign-in screens) the pulse keeps reads fresh.
  if (!source) startFallback();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
  };
}

function startFallback(): void {
  if (fallback || typeof window === "undefined") return;
  fallback = setInterval(() => { if (listeners.size > 0 && navigator.onLine !== false) invalidateLive(); }, FALLBACK_MS);
}
function stopFallback(): void { if (fallback) clearInterval(fallback); fallback = undefined; }

function closeSource(): void {
  source?.close(); source = undefined;
  if (reconnect) clearTimeout(reconnect); reconnect = undefined;
}

function open(): void {
  closeSource();
  if (!enabled || !workspace || typeof EventSource === "undefined") { setConnected(false); startFallback(); return; }
  const url = `/v1/events?live=1&wake=1&after=head&workspace=${encodeURIComponent(workspace)}`;
  const stream = new EventSource(url, { withCredentials: true });
  source = stream;
  let openedAt = 0;
  stream.onopen = () => {
    openedAt = Date.now();
    setConnected(true); stopFallback();
    // What changed while the stream was down is unknown: one re-read of everything.
    if (wasDown) { wasDown = false; invalidateLive(); }
  };
  stream.addEventListener("changed", () => invalidateLive());
  stream.addEventListener("reset", () => { setConnected(false); wasDown = true; stream.close(); reconnect = setTimeout(open, 500); });
  stream.onerror = () => {
    // The Governor ends every live stream after about a minute on purpose. A stream that had been healthy simply opens again, without saying "reconnecting".
    if (openedAt > 0 && Date.now() - openedAt > PLANNED_CLOSE_MS) { stream.close(); open(); invalidateLive(); return; }
    setConnected(false); wasDown = true; stream.close(); startFallback();
    reconnect = setTimeout(open, 2000);
  };
}

/** Point the bus at a workspace (or switch it off when nobody is signed in). */
export function configureLive(next: { workspaceId: string; enabled: boolean }): void {
  const changed = next.workspaceId !== workspace || next.enabled !== enabled;
  workspace = next.workspaceId; enabled = next.enabled;
  if (!changed) return;
  open();
}

/** Re-read on coming back to the tab or the network. */
if (typeof window !== "undefined") {
  window.addEventListener("online", () => invalidateLive({ immediate: true }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") invalidateLive(); });
}

/**
 * A screen whose progress emits no events (model download, a runner that is coming online)
 * asks for a faster pulse while it is true. The bus still owns the one timer.
 */
export function wantFastPulse(): () => void {
  let released = false;
  fastWanted += 1;
  if (!fast && typeof window !== "undefined") fast = setInterval(() => invalidateLive(), FAST_MS);
  return () => {
    if (released) return; released = true;
    fastWanted -= 1;
    if (fastWanted <= 0 && fast) { clearInterval(fast); fast = undefined; fastWanted = 0; }
  };
}

/** One shared wall clock (seconds resolution) for "ago" and countdown labels; ticks only while somebody reads it. */
export function liveNow(): Accessor<number> {
  return now;
}
export function useClock(): () => void {
  setClockUsers((n) => n + 1);
  if (!clock && typeof window !== "undefined") clock = setInterval(() => setNow(Date.now()), 1000);
  setNow(Date.now());
  let released = false;
  return () => {
    if (released) return; released = true;
    setClockUsers((n) => n - 1);
    if (clockUsers() <= 0 && clock) { clearInterval(clock); clock = undefined; }
  };
}

export const liveConnected: Accessor<boolean> = connected;
/** True while a re-read pass is taking noticeably long (the label then says "Updating…"). */
export const liveUpdating: Accessor<boolean> = slow;
export const liveUpdatedAt: Accessor<number> = updatedAt;
