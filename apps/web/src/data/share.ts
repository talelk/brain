/**
 * Structural sharing for polled reads: a value equal to the previous one keeps the previous
 * reference, and an unchanged element of a changed list keeps its own. Solid then re-renders
 * only what really changed, so a poll never rebuilds a list, board or open menu under the reader.
 */
export function shareStructure<T>(previous: unknown, next: T): T {
  if (previous === next || next === null || typeof next !== "object" || previous === null || typeof previous !== "object") return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    const merged = next.map((entry, index) => shareStructure(previous[index], entry));
    return (merged.length === previous.length && merged.every((entry, index) => entry === previous[index]) ? previous : merged) as T;
  }
  if (Array.isArray(previous)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  const merged: Record<string, unknown> = {};
  for (const key of keys) merged[key] = shareStructure(before[key], after[key]);
  const same = keys.length === Object.keys(before).length && keys.every((key) => merged[key] === before[key]);
  return (same ? previous : merged) as T;
}
