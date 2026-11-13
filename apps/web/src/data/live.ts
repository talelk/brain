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
/** Re-read pulse while a screen declared progress that emits no events. */
const FAST_MS = 2500;

type Listener = () => void;

const listeners = new Set<Listener>();
const [connected, setConnected] = createSignal(false);
const [updatedAt, setUpdatedAt] = createSignal(Date.now());
const [now, setNow] = createSignal(Date.now());
const [clockUsers, setClockUsers] = createSignal(0);

let source: EventSource | undefined;
let workspace = "";
let enabled = false;
let lastFlush = 0;
let coalesce: ReturnType<typeof setTimeout> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let fallback: ReturnType<typeof setInterval> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let fast: ReturnType<typeof setInterval> | undefined;
let fastWanted = 0;
let wasDown = false;

function flush(): void {
  coalesce = undefined;
  lastFlush = Date.now();
  setUpdatedAt(lastFlush);
  for (const listener of [...listeners]) { try { listener(); } catch { /* one read failing never blocks the others */ } }
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
  // Before the stream is open (a kiosk, the sign-in screens) the pulse keeps reads fresh.
  if (!source) startFallback();
  return () => { listeners.delete(listener); };
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
  stream.onopen = () => {
    setConnected(true); stopFallback();
    // What changed while the stream was down is unknown: one re-read of everything.
    if (wasDown) { wasDown = false; invalidateLive(); }
  };
  stream.addEventListener("changed", () => invalidateLive());
  stream.addEventListener("reset", () => { setConnected(false); wasDown = true; stream.close(); reconnect = setTimeout(open, 500); });
  stream.onerror = () => {
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
export const liveUpdatedAt: Accessor<number> = updatedAt;
