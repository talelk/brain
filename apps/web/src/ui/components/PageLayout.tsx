import { For, Show } from "solid-js";
import type { JSX, ParentProps } from "solid-js";
import { KeyValue } from "@talelk/newui-atoms";
import { Alert } from "@talelk/newui-molecules";

export { BrainPage } from "../page-context";

export function PageStack(props: ParentProps): JSX.Element {
  return <div class="brain-page-stack">{props.children}</div>;
}

export function ActionBar(props: ParentProps<{ label?: string }>): JSX.Element {
  return <fieldset class="brain-action-bar" aria-label={props.label ?? "Actions"}>{props.children}</fieldset>;
}

export function TechnicalDetails(props: ParentProps<{ label?: string }>): JSX.Element {
  return <details class="brain-technical-details">
    <summary class="cursor-pointer rounded-control text-caption font-medium text-ink-gray-7 focus-visible:focus-ring">{props.label ?? "Technical details"}</summary>
    <div class="mt-3 min-w-0 text-caption text-ink-gray-7">{props.children}</div>
  </details>;
}

export function KeyValueGrid(props: { items: { label: string; value: JSX.Element }[] }): JSX.Element {
  return <dl class="brain-key-value-grid">
    <For each={props.items}>{(item) => <KeyValue label={item.label} value={item.value} orientation="vertical" />}</For>
  </dl>;
}

export function ErrorSummary(props: { title?: string; errors: string[] }): JSX.Element {
  return <Show when={props.errors.length}>
    <Alert theme="red" variant="outline" title={props.title ?? "Review the highlighted information"}
      description={<ul class="ml-4 list-disc"><For each={props.errors}>{(error) => <li>{error}</li>}</For></ul>} />
  </Show>;
}
