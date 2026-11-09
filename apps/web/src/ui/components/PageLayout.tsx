import { For, Show } from "solid-js";
import type { JSX, ParentProps } from "solid-js";
import { Alert, Collapsible } from "@talelk/newui-molecules";

export { BrainPage } from "../page-context";

export function PageStack(props: ParentProps): JSX.Element {
  return <div class="brain-page-stack">{props.children}</div>;
}

export function TechnicalDetails(props: ParentProps<{ label?: string }>): JSX.Element {
  return <Collapsible.Root class="brain-technical-details">
    <Collapsible.Trigger>{props.label ?? "Technical details"}</Collapsible.Trigger>
    <Collapsible.Content><div class="min-w-0 pt-2 text-caption text-ink-gray-7">{props.children}</div></Collapsible.Content>
  </Collapsible.Root>;
}

export function ErrorSummary(props: { title?: string; errors: string[] }): JSX.Element {
  return <Show when={props.errors.length}>
    <Alert theme="red" variant="outline" title={props.title ?? "Review the highlighted information"}
      description={<ul class="ml-4 min-w-0 list-disc break-words"><For each={props.errors}>{(error) => <li>{error}</li>}</For></ul>} />
  </Show>;
}
