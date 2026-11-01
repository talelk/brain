import { createUniqueId, For, Show } from "solid-js";
import type { JSX, ParentProps } from "solid-js";
import { IconTile } from "./primitives";
import { RelativeTime } from "../screen-region";

export function WorkspaceSection(props: ParentProps<{
  title: string;
  description?: string;
  actions?: JSX.Element;
  class?: string;
}>): JSX.Element {
  const id = createUniqueId();
  return <section class={`brain-section ${props.class ?? ""}`} aria-labelledby={id}>
    <div class="brain-section-header">
      <div><h2 id={id} class="text-section text-ink-gray-9">{props.title}</h2><Show when={props.description}><p class="mt-1 max-w-3xl text-interface text-ink-gray-6">{props.description}</p></Show></div>
      <Show when={props.actions}><div class="brain-action-bar">{props.actions}</div></Show>
    </div>
    {props.children}
  </section>;
}

export function FactStrip(props: {
  items: readonly { label: string; value: JSX.Element; hint?: string; icon?: string }[];
  label: string;
}): JSX.Element {
  return <dl class="brain-fact-strip" aria-label={props.label}>
    <For each={props.items}>{(item) => <div>
      <dt class="flex items-center gap-1.5 text-caption text-ink-gray-6"><Show when={item.icon}><span class={`${item.icon} size-3.5`} aria-hidden="true" /></Show>{item.label}</dt>
      <dd class="mt-1 text-base-medium tabular-nums text-ink-gray-9">{item.value}</dd>
      <Show when={item.hint}><dd class="mt-0.5 text-caption text-ink-gray-6">{item.hint}</dd></Show>
    </div>}</For>
  </dl>;
}

export function QueueRow(props: {
  title: string;
  description: string;
  icon: string;
  tone?: "blue" | "gray" | "green" | "red" | "amber";
  eyebrow?: string;
  meta?: JSX.Element;
  trailing?: JSX.Element;
  selected?: boolean;
  onClick: () => void;
  label?: string;
}): JSX.Element {
  return <button type="button" class="brain-queue-row" data-selected={props.selected ? "true" : "false"} aria-label={props.label ?? `${props.title}. ${props.description}`} onClick={props.onClick}>
    <IconTile icon={props.icon} tone={props.tone ?? "gray"} />
    <span class="min-w-0">
      <Show when={props.eyebrow}><span class="mb-1 block text-caption font-medium uppercase tracking-wide text-ink-gray-6">{props.eyebrow}</span></Show>
      <span class="block break-words text-base-medium text-ink-gray-9">{props.title}</span>
      <span class="mt-1 block break-words text-interface text-ink-gray-7">{props.description}</span>
      <Show when={props.meta}><span class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-gray-6">{props.meta}</span></Show>
    </span>
    <Show when={props.trailing}><span class="flex max-w-48 flex-wrap items-center justify-end gap-2">{props.trailing}</span></Show>
  </button>;
}

export function DetailAside(props: ParentProps<{ title: string; description?: string; sticky?: boolean }>): JSX.Element {
  return <aside class="brain-detail-aside" data-sticky={props.sticky ? "true" : "false"} aria-label={props.title}>
    <div><h2 class="text-section text-ink-gray-9">{props.title}</h2><Show when={props.description}><p class="mt-1 text-interface text-ink-gray-6">{props.description}</p></Show></div>
    {props.children}
  </aside>;
}

export function Freshness(props: { value?: string; label?: string; stale?: boolean }): JSX.Element {
  return <span class="inline-flex items-center gap-1.5 text-caption text-ink-gray-6">
    <span class={`size-1.5 rounded-full ${props.stale ? "bg-surface-amber-7" : "bg-surface-green-7"}`} aria-hidden="true" />
    {props.label ?? "Updated"} <RelativeTime value={props.value} />
  </span>;
}

export function EmptyPreview(props: { icon: string; title: string; description: string; action?: JSX.Element }): JSX.Element {
  return <div class="flex min-h-56 flex-col items-start justify-center gap-3 py-8">
    <IconTile icon={props.icon} size="lg" tone="gray" />
    <div><h2 class="text-section text-ink-gray-8">{props.title}</h2><p class="mt-1 max-w-md text-interface text-ink-gray-6">{props.description}</p></div>
    <Show when={props.action}>{props.action}</Show>
  </div>;
}
