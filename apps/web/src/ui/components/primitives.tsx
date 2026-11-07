import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Pagination } from "@talelk/newui-molecules";

/**
 * The shared screen-building blocks. Every card grid, list row, field grid and
 * disclosure renders through these so spacing and breakpoints cannot drift
 * per page again.
 */

/* Shared actions use compact md/sm controls; xs is reserved for inline utilities. */

/** One bordered surface card; the standard container for grouped content. */
export function CardTile(props: { children: JSX.Element; wide?: boolean; class?: string; onClick?: () => void }): JSX.Element {
  return <article class={`min-w-0 rounded-card border border-outline-gray-1 bg-surface-elevation-1 ${props.wide ? "p-card-pad-wide" : "p-card-pad"} ${props.class ?? ""}`}>{props.children}</article>;
}

/* Row lists and field grids use the shared `.brain-row-list` / `.brain-field-grid` classes (index.css). */

/** A selectable master-list item (plans missions, resources). */
export function SelectableListItem(props: { selected?: boolean; onClick: () => void; children: JSX.Element; class?: string }): JSX.Element {
  return <button type="button"
    class={`min-w-0 rounded-control border p-2.5 text-start focus-visible:focus-ring ${props.selected ? "border-outline-blue-2 bg-surface-blue-1" : "border-outline-gray-2"} ${props.class ?? ""}`}
    onClick={props.onClick}>{props.children}</button>;
}

/** The shared compact header refresh affordance. */
export function RefreshButton(props: { onClick: () => void; label?: string; busy?: boolean }): JSX.Element {
  return <Button size="md" variant="outline" iconLeft="lucide-refresh-cw" loading={props.busy} onClick={props.onClick}>{props.label ?? "Refresh"}</Button>;
}

/** Tinted icon square used in list rows and queue tiles. */
export function IconTile(props: { icon: string; tone?: "blue" | "gray" | "green" | "red" | "amber"; size?: "md" | "lg" }): JSX.Element {
  const tones: Record<string, string> = {
    blue: "bg-surface-blue-2 text-ink-blue-8", gray: "bg-surface-gray-2 text-ink-gray-7",
    green: "bg-surface-green-2 text-ink-green-8", red: "bg-surface-red-2 text-ink-red-8",
    amber: "bg-surface-amber-2 text-ink-amber-8",
  };
  return <span class={`grid ${props.size === "lg" ? "size-9" : "size-8"} shrink-0 place-items-center rounded-control ${props.tone ? tones[props.tone] : tones.blue}`}><span class={`${props.icon} ${props.size === "lg" ? "size-4.5" : "size-4"}`} aria-hidden="true" /></span>;
}

/** The styled disclosure for exact payloads and technical detail. */
export function DisclosureCard(props: { label: string; children: JSX.Element; open?: boolean }): JSX.Element {
  return <details class="min-w-0 rounded-control border border-outline-gray-1 p-card-pad-compact" open={props.open}>
    <summary class="cursor-pointer break-words text-base-medium focus-visible:focus-ring">{props.label}</summary>
    <div class="mt-2 min-w-0">{props.children}</div>
  </details>;
}

/** The Brain brand mark: blue square "B" + optional wordmark. */
export function BrandMark(props: { collapsed?: boolean }): JSX.Element {
  return <Show when={props.collapsed} fallback={<span class="flex min-h-9 items-center gap-2 rounded-control px-1.5 font-semibold"><span class="grid size-7 shrink-0 place-items-center rounded-control bg-surface-blue-9 text-interface font-semibold text-white">B</span><span>Keyrus Brain</span></span>}>
    <span role="img" aria-label="Keyrus Brain" class="grid size-9 place-items-center rounded-control"><span class="grid size-7 place-items-center rounded-control bg-surface-blue-9 text-interface font-semibold text-white">B</span></span>
  </Show>;
}

/** Shared client-side page size for list screens that slice in memory. */
export const LIST_PAGE_SIZE = 25;

/** The shared client-side pager; renders only once a list outgrows one page. Pair slicing with LIST_PAGE_SIZE so paging and page size cannot drift. */
export function Pager(props: { count: number; page: number; onPage: (page: number) => void; label: string }): JSX.Element {
  return <Show when={props.count > LIST_PAGE_SIZE}>
    <Pagination.Root class="mt-1" count={props.count} pageSize={LIST_PAGE_SIZE} page={props.page} onPageChange={props.onPage} aria-label={props.label}>
      <Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /><Pagination.Range class="ms-2" />
    </Pagination.Root>
  </Show>;
}

/** Split axis: "row" divides columns (drag left/right), "column" divides rows (drag up/down). */
export type SplitOrientation = "row" | "column";

/** Clamp a pane size to its declared bounds; resize deltas and restores cannot escape them. */
export function clampPaneSize(size: number, min: number, max: number): number {
  return Math.min(Math.max(size, min), max);
}

/**
 * The one resizable divider for the execution console's split panes.
 * Pointer drag reports the pixel delta since the last move; the keyboard steps
 * by 16 px (64 px with Shift), and Enter/Space or double-click resets. The
 * consumer owns the size state, its bounds and its persistence (ConsoleStore);
 * the divider only reports motion.
 */
export function PaneResizer(props: {
  orientation: SplitOrientation;
  /** Pixel delta since the last move; positive grows the pane after the divider. */
  onResize: (deltaPx: number) => void;
  /** Double-click, Enter or Space resets to the consumer's default size. */
  onReset?: () => void;
  /** Accessible name; state what the handle resizes and in which direction. */
  label: string;
}): JSX.Element {
  const [dragging, setDragging] = createSignal(false);
  let lastPosition = 0;
  const position = (event: PointerEvent) => (props.orientation === "row" ? event.clientX : event.clientY);
  return <button type="button" aria-label={props.label} title={props.label}
    data-orientation={props.orientation} data-dragging={dragging()}
    class="brain-exec-divider"
    onPointerDown={(event) => {
      setDragging(true);
      lastPosition = position(event);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!dragging()) return;
      const next = position(event);
      props.onResize(next - lastPosition);
      lastPosition = next;
    }}
    onPointerUp={(event) => { setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
    onLostPointerCapture={() => setDragging(false)}
    onDblClick={() => props.onReset?.()}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 64 : 16;
      const grows = event.key === "ArrowRight" || event.key === "ArrowDown";
      const shrinks = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (grows || shrinks) {
        event.preventDefault();
        props.onResize(grows ? step : -step);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        props.onReset?.();
      }
    }} />;
}
