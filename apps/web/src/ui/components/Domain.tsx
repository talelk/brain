import { createContext, createUniqueId, Show, useContext } from "solid-js";
import type { JSX, ParentProps } from "solid-js";
import { Section } from "@talelk/newui-organisms";
import { IconTile } from "./primitives";
import { RelativeTime } from "../screen-region";

const InCard = createContext(false);

/** A page region: NewUI's `Section` (header, actions, body) with a stable accessible name. */
export function WorkspaceSection(props: ParentProps<{
  title: string;
  description?: string;
  actions?: JSX.Element;
  class?: string;
  /** Panels are cards on the canvas; a region nested inside a card is plain unless asked otherwise. */
  surface?: "card" | "plain" | "inset";
}>): JSX.Element {
  const id = createUniqueId();
  const nested = useContext(InCard);
  const surface = () => props.surface ?? (nested ? "plain" : "card");
  return <InCard.Provider value={surface() === "card" || nested}>
    <Section id={id} title={props.title} description={props.description} actions={props.actions} surface={surface()} class={props.class}>{props.children}</Section>
  </InCard.Provider>;
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
