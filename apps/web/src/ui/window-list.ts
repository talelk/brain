// Bounded list windowing (E092): long runs/transcript lists render only the
// visible slice plus overscan, with spacer heights preserving total scroll
// geometry and the user's scroll position across data refreshes.
export interface ListWindow<T> {
  readonly start: number;
  readonly end: number;
  readonly items: readonly T[];
  readonly topPadPx: number;
  readonly bottomPadPx: number;
  readonly total: number;
}

export function visibleWindow<T>(
  items: readonly T[],
  scrollTopPx: number,
  rowHeightPx: number,
  viewportHeightPx: number,
  overscanRows = 8,
): ListWindow<T> {
  const total = items.length;
  const row = Math.max(1, rowHeightPx);
  const firstVisible = Math.max(0, Math.floor(scrollTopPx / row));
  const visibleCount = Math.max(1, Math.ceil(viewportHeightPx / row));
  const start = Math.min(total, Math.max(0, firstVisible - overscanRows));
  const end = Math.min(total, firstVisible + visibleCount + overscanRows);
  return {
    start,
    end,
    items: items.slice(start, end),
    topPadPx: start * row,
    bottomPadPx: (total - end) * row,
    total,
  };
}
