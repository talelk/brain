/**
 * The one live connection: `GET /v1/events` says "something changed in this workspace" and every mounted query reads again, together.
 * Changes are coalesced, so a busy task costs one round of reads a second at most. While the stream is down a slow pulse keeps screens fresh.
 */
type Listener = () => void;

const MIN_GAP_MS = 1000;
const COALESCE_MS = 250;
const FALLBACK_MS = 15_000;

const listeners = new Set<Listener>();
let source: EventSource | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let fallback: ReturnType<typeof setInterval> | undefined;
let lastFlush = 0;

function flush(): void {
  timer = undefined;
  lastFlush = Date.now();
  for (const listener of [...listeners]) listener();
}

/** Ask every mounted query to read again. `now` skips the wait (after a command the person just sent). */
export function invalidate(now = false): void {
  if (now) { clearTimeout(timer); flush(); return; }
  timer ??= setTimeout(flush, Math.max(COALESCE_MS, lastFlush + MIN_GAP_MS - Date.now()));
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Opens the stream once someone is signed in; closes it when they sign out. */
export function connectLive(enabled: boolean): void {
  source?.close();
  source = undefined;
  clearInterval(fallback);
  fallback = undefined;
  if (!enabled) return;
  fallback = setInterval(() => { if (source?.readyState !== EventSource.OPEN && document.visibilityState === "visible") invalidate(); }, FALLBACK_MS);
  source = new EventSource("/v1/events", { withCredentials: true });
  source.addEventListener("changed", () => invalidate());
  // The Governor ends a stream every few minutes; the browser reconnects by itself, and one read covers the gap.
  source.addEventListener("open", () => invalidate());
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") invalidate(); });
window.addEventListener("online", () => invalidate(true));
