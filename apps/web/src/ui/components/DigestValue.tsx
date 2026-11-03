import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { toast } from "@talelk/newui-molecules";
import { shortDigest } from "../format";

export function DigestValue(props: { value: string; label?: string; short?: boolean }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const visible = () => (props.short === false ? props.value : shortDigest(props.value));
  async function copy() {
    await navigator.clipboard.writeText(props.value);
    setCopied(true);
    toast.success({ title: `${props.label ?? "Identifier"} copied` });
    setTimeout(() => setCopied(false), 1500);
  }
  return <span class="brain-digest">
    <code class="min-w-0 break-all font-mono text-caption" title={props.value}>{visible()}</code>
    <Button class="shrink-0" variant="ghost" size="xs" aria-label={`Copy full ${props.label ?? "identifier"}`} onClick={() => void copy()}>{copied() ? "Copied" : "Copy"}</Button>
    <Show when={props.short !== false}><details class="w-full"><summary class="cursor-pointer text-caption text-ink-gray-6">Full value</summary><code class="mt-1 block break-all text-caption">{props.value}</code></details></Show>
  </span>;
}
