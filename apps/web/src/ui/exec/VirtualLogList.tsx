import { For, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

/**
 * Windowed list over long execution streams: bounded DOM, stable scrolling,
 * reconnect-safe. Rows are absolutely positioned on a fixed row height, so the
 * browser never reflows the whole list and the scroll offset survives sibling
 * renders. No DOM queries: the visible window derives from scrollTop alone.
 */
export function VirtualLogList<T>(props: {
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  /** Fixed row height in px; the window math depends on it. */
  rowHeight: number;
  overscan?: number;
  /** Scroll this item index into view when it changes (restore / follow). */
  scrollToIndex?: number;
  ariaLabel: string;
  class?: string;
  children: (item: T, index: number) => JSX.Element;
}): JSX.Element {
  let container: HTMLUListElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(480);
  const overscan = () => props.overscan ?? 8;

  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height && height > 0) setViewport(height);
    });
    if (container) observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  const start = () => Math.max(0, Math.floor(scrollTop() / props.rowHeight) - overscan());
  const end = () => Math.min(props.items.length, Math.ceil((scrollTop() + viewport()) / props.rowHeight) + overscan());
  // Window wrappers are cached by row key and reused while the underlying item
  // keeps its identity: Solid's <For> keys by reference, so a stable wrapper
  // keeps the row's DOM (and any text selection inside it) alive across
  // re-computes that only appended records past the window.
  const wrappers = new Map<string, { item: T; index: number; key: string }>();
  const visible = () => {
    const from = start();
    const to = end();
    const out: { item: T; index: number; key: string }[] = [];
    for (let index = from; index < to; index += 1) {
      const item = props.items[index]!;
      const key = props.itemKey(item, index);
      const cached = wrappers.get(key);
      // The row's DOM is only reusable while BOTH the item and its absolute
      // index are unchanged (a window trim shifts indices, so those rows
      // re-render rather than jump to a stale transform).
      const wrapper = cached && cached.item === item && cached.index === index ? cached : { item, index, key };
      wrappers.set(key, wrapper);
      out.push(wrapper);
    }
    if (wrappers.size > out.length * 4 + 64) {
      const keep = new Set(out.map((wrapper) => wrapper.key));
      for (const key of [...wrappers.keys()]) if (!keep.has(key)) wrappers.delete(key);
    }
    return out;
  };

  createEffect(() => {
    const target = props.scrollToIndex;
    if (target === undefined || !container) return;
    container.scrollTo({ top: Math.max(0, target * props.rowHeight - viewport() / 3) });
  });

  return <ul ref={container} aria-label={props.ariaLabel}
    class={`brain-exec-scroll relative m-0 list-none p-0 ${props.class ?? ""}`}
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
    <div style={{ height: `${props.items.length * props.rowHeight}px`, position: "relative" }}>
      <For each={visible()}>
        {(row) => (
          <li data-key={row.key}
            style={{ position: "absolute", top: 0, left: 0, right: 0, height: `${props.rowHeight}px`, transform: `translateY(${row.index * props.rowHeight}px)` }}>
            {props.children(row.item, row.index)}
          </li>
        )}
      </For>
    </div>
  </ul>;
}
