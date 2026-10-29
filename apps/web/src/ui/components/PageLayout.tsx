import { For, Show } from "solid-js";
import type { JSX, ParentProps } from "solid-js";
import { Button, KeyValue } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";

export function PageIntro(props: {
  title: string;
  description: string;
  eyebrow?: string;
  freshness?: JSX.Element;
  actions?: JSX.Element;
}): JSX.Element {
  return <header class="brain-page-intro">
    <div class="min-w-0 max-w-3xl">
      <Show when={props.eyebrow}><p class="mb-1 text-caption font-medium uppercase tracking-wide text-ink-gray-6">{props.eyebrow}</p></Show>
      <h2 class="text-heading text-ink-gray-9">{props.title}</h2>
      <p class="mt-1 text-base text-ink-gray-7">{props.description}</p>
      <Show when={props.freshness}><div class="mt-2 text-caption text-ink-gray-6">{props.freshness}</div></Show>
    </div>
    <Show when={props.actions}><ActionBar>{props.actions}</ActionBar></Show>
  </header>;
}

export function ActionBar(props: ParentProps<{ label?: string }>): JSX.Element {
  return <div class="brain-action-bar" role={props.label ? "group" : undefined} aria-label={props.label}>{props.children}</div>;
}

export function KeyValueGrid(props: { items: { label: string; value: JSX.Element }[] }): JSX.Element {
  return <dl class="brain-key-value-grid">
    <For each={props.items}>{(item) => <KeyValue label={item.label} value={item.value} orientation="vertical" />}</For>
  </dl>;
}

export function EmptyAction(props: { title: string; description: string; actionLabel?: string; onAction?: () => void }): JSX.Element {
  return <div class="brain-empty-state">
    <h3 class="text-base-medium text-ink-gray-9">{props.title}</h3>
    <p class="mt-1 max-w-xl text-base text-ink-gray-7">{props.description}</p>
    <Show when={props.actionLabel && props.onAction}>
      <Button class="mt-4 min-h-11" variant="outline" onClick={() => props.onAction?.()}>{props.actionLabel}</Button>
    </Show>
  </div>;
}

export function ErrorSummary(props: { title?: string; errors: string[] }): JSX.Element {
  return <Show when={props.errors.length}>
    <Alert theme="red" variant="outline" title={props.title ?? "Review the highlighted information"}
      description={<ul class="ml-4 list-disc"><For each={props.errors}>{(error) => <li>{error}</li>}</For></ul>} />
  </Show>;
}
