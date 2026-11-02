/**
 * The Log Tail's arrival window over one SSE connection, as a pure function so
 * the window-trim semantics stay unit-testable without a live connection.
 */

/**
 * The frames a connection has not rendered yet. The SSE window keeps only the
 * newest 500 frames, so an absolute index into that array shifts every time
 * the window trims and records would be skipped from then on. The identity of
 * the last rendered frame survives the trim instead: frames after it are new,
 * and once the trim has consumed it, everything still visible arrived after
 * it — frame objects are never reused across deliveries, so reference
 * equality is exact.
 */
export function framesAfter<E>(events: readonly E[], lastFrame: E | undefined): readonly E[] {
  if (!lastFrame) return [...events];
  const at = events.lastIndexOf(lastFrame);
  return at < 0 ? [...events] : events.slice(at + 1);
}
