import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";

/**
 * The shared screen-building blocks. Every card grid, list row, field grid and
 * disclosure renders through these so spacing and breakpoints cannot drift
 * per page again.
 */

/** One bordered surface card; the standard container for grouped content. */
export function CardTile(props: { children: JSX.Element; wide?: boolean; class?: string; onClick?: () => void }): JSX.Element {
  return <article class={`rounded-card border border-outline-gray-1 bg-surface-elevation-1 ${props.wide ? "p-card-pad-wide" : "p-card-pad"} ${props.class ?? ""}`}>{props.children}</article>;
}

/* Row lists and field grids use the shared `.brain-row-list` / `.brain-field-grid` classes (index.css). */

/** A selectable master-list item (plans objectives, resources). */
export function SelectableListItem(props: { selected?: boolean; onClick: () => void; children: JSX.Element; class?: string }): JSX.Element {
  return <button type="button"
    class={`rounded-control border p-3 text-start focus-visible:focus-ring ${props.selected ? "border-outline-blue-2 bg-surface-blue-1" : "border-outline-gray-2"} ${props.class ?? ""}`}
    onClick={props.onClick}>{props.children}</button>;
}

/** The header refresh affordance; one definition instead of twelve copies. Page-header actions stay size lg to match their sibling primary CTA. */
export function RefreshButton(props: { onClick: () => void; label?: string; busy?: boolean }): JSX.Element {
  return <Button size="lg" variant="outline" iconLeft="lucide-refresh-cw" loading={props.busy} onClick={props.onClick}>{props.label ?? "Refresh"}</Button>;
}

/** Tinted icon square used in list rows and queue tiles. */
export function IconTile(props: { icon: string; tone?: "blue" | "gray" | "green" | "red" | "amber"; size?: "md" | "lg" }): JSX.Element {
  const tones: Record<string, string> = {
    blue: "bg-surface-blue-2 text-ink-blue-8", gray: "bg-surface-gray-2 text-ink-gray-7",
    green: "bg-surface-green-2 text-ink-green-8", red: "bg-surface-red-2 text-ink-red-8",
    amber: "bg-surface-amber-2 text-ink-amber-8",
  };
  return <span class={`grid ${props.size === "lg" ? "size-11" : "size-10"} shrink-0 place-items-center rounded-control ${props.tone ? tones[props.tone] : tones.blue}`}><span class={`${props.icon} size-5`} aria-hidden="true" /></span>;
}

/** The styled disclosure for exact payloads and technical detail. */
export function DisclosureCard(props: { label: string; children: JSX.Element; open?: boolean }): JSX.Element {
  return <details class="rounded-card border border-outline-gray-1 bg-surface-gray-1 p-card-pad" open={props.open}>
    <summary class="cursor-pointer text-base-medium focus-visible:focus-ring">{props.label}</summary>
    <div class="mt-3">{props.children}</div>
  </details>;
}

/** The Brain brand mark: blue square "B" + optional wordmark. */
export function BrandMark(props: { collapsed?: boolean }): JSX.Element {
  return <Show when={props.collapsed} fallback={<span class="flex min-h-10 items-center gap-2 rounded-control px-2 font-semibold"><span class="grid size-7 shrink-0 place-items-center rounded-control bg-surface-blue-9 text-interface font-semibold text-white">B</span><span>Keyrus Brain</span></span>}>
    <span role="img" aria-label="Keyrus Brain" class="grid size-10 place-items-center rounded-control"><span class="grid size-8 place-items-center rounded-control bg-surface-blue-9 text-interface font-semibold text-white">B</span></span>
  </Show>;
}
