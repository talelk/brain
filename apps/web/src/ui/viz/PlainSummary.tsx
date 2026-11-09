import type { JSX } from "solid-js";

/** One plain-language sentence saying what happens next, shown before any technical detail. */
export function PlainSummary(props: { children: JSX.Element; icon?: string }): JSX.Element {
  return <p class="flex items-start gap-2 text-base text-ink-gray-8"><span class={`${props.icon ?? "lucide-info"} mt-0.5 size-4 shrink-0 text-ink-blue-8`} aria-hidden="true" /><span class="min-w-0">{props.children}</span></p>;
}
