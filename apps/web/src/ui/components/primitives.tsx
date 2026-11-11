import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Collapsible, Pagination } from "@talelk/newui-molecules";

/**
 * The shared screen-building blocks. Every card grid, list row, field grid and
 * disclosure renders through these so spacing and breakpoints cannot drift
 * per page again.
 */

/* Shared actions use compact md/sm controls; xs is reserved for inline utilities. */

/* Row lists and field grids use the shared `.brain-row-list` / `.brain-field-grid` classes (index.css). */

/** A selectable master-list item (plans missions, resources). */
export function SelectableListItem(props: { selected?: boolean; onClick: () => void; children: JSX.Element; class?: string }): JSX.Element {
  return <button type="button"
    class={`min-w-0 rounded-control border p-2.5 text-start focus-visible:focus-ring ${props.selected ? "border-outline-blue-2 bg-surface-blue-1" : "border-outline-gray-2"} ${props.class ?? ""}`}
    onClick={props.onClick}>{props.children}</button>;
}

/** Tinted icon square used in list rows, queue tiles and page headers (`sm` is the quiet header size). */
export function IconTile(props: { icon: string; tone?: "blue" | "gray" | "green" | "red" | "amber"; size?: "sm" | "md" | "lg" }): JSX.Element {
  const tones: Record<string, string> = {
    blue: "bg-surface-blue-2 text-ink-blue-8", gray: "bg-surface-gray-2 text-ink-gray-7",
    green: "bg-surface-green-2 text-ink-green-8", red: "bg-surface-red-2 text-ink-red-8",
    amber: "bg-surface-amber-2 text-ink-amber-8",
  };
  const box = () => props.size === "lg" ? "size-9" : props.size === "sm" ? "size-6" : "size-8";
  const glyph = () => props.size === "lg" ? "size-4.5" : props.size === "sm" ? "size-3.5" : "size-4";
  return <span class={`grid ${box()} shrink-0 place-items-center rounded-control ${props.tone ? tones[props.tone] : tones.blue}`}><span class={`${props.icon} ${glyph()}`} aria-hidden="true" /></span>;
}

/** Exact payloads and technical detail behind a NewUI `Collapsible`. */
export function DisclosureCard(props: { label: string; children: JSX.Element; open?: boolean }): JSX.Element {
  return <Collapsible.Root defaultOpen={props.open} class="min-w-0 rounded-control border border-outline-gray-1 p-card-pad-compact">
    <Collapsible.Trigger>{props.label}</Collapsible.Trigger>
    <Collapsible.Content><div class="min-w-0 pt-2">{props.children}</div></Collapsible.Content>
  </Collapsible.Root>;
}

/** The Brain brand mark: a petrol tile holding a three-node graph glyph, plus the wordmark unless collapsed. Decorative glyph; the name is the accessible label. */
export function BrandMark(props: { collapsed?: boolean }): JSX.Element {
  const glyph = (size: string) => (
    <span class={`relative grid ${size} shrink-0 place-items-center overflow-hidden rounded-control bg-surface-blue-9 text-white ring-1 ring-inset ring-white/15`}>
      <svg viewBox="0 0 24 24" class="size-[70%]" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7 16.5 12 7l5 9.5M7 16.5h10" opacity="0.7" />
        <circle cx="12" cy="7" r="2.1" fill="currentColor" />
        <circle cx="7" cy="16.5" r="1.7" fill="currentColor" />
        <circle cx="17" cy="16.5" r="1.7" fill="currentColor" />
      </svg>
    </span>
  );
  return <Show when={props.collapsed} fallback={<span class="flex min-h-9 items-center gap-2 rounded-control px-1.5 font-semibold">{glyph("size-7")}<span class="tracking-tight">Keyrus Brain</span></span>}>
    <span role="img" aria-label="Keyrus Brain" class="grid size-9 place-items-center rounded-control">{glyph("size-7")}</span>
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
  // Right-to-left reading order puts the first pane on the right, so horizontal movement and arrow keys mean the opposite.
  const flip = () => (props.orientation === "row" && document.documentElement.dir === "rtl" ? -1 : 1);
  const position = (event: PointerEvent) => (props.orientation === "row" ? event.clientX * flip() : event.clientY);
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
      const forward = flip() === 1 ? "ArrowRight" : "ArrowLeft";
      const backward = flip() === 1 ? "ArrowLeft" : "ArrowRight";
      const grows = event.key === forward || event.key === "ArrowDown";
      const shrinks = event.key === backward || event.key === "ArrowUp";
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
