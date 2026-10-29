import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { toast } from "@talelk/newui-molecules";

export function DigestValue(props: { value: string; label?: string; short?: boolean }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const visible = () => props.short === false ? props.value : `${props.value.slice(0, 15)}…${props.value.slice(-8)}`;
  async function copy() {
    await navigator.clipboard.writeText(props.value);
    setCopied(true);
    toast.success({ title: `${props.label ?? "Identifier"} copied` });
    setTimeout(() => setCopied(false), 1500);
  }
  return <span class="brain-digest">
    <code title={props.value} aria-label={`${props.label ?? "Identifier"}: ${props.value}`}>{visible()}</code>
    <Button variant="ghost" size="sm" class="min-h-11 min-w-11" aria-label={`Copy full ${props.label ?? "identifier"}`} onClick={() => void copy()}>{copied() ? "Copied" : "Copy"}</Button>
    <Show when={props.short !== false}><details class="w-full"><summary class="cursor-pointer text-caption text-ink-gray-6">Full value</summary><code class="mt-1 block break-all text-caption">{props.value}</code></details></Show>
  </span>;
}
