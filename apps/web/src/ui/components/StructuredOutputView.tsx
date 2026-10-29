import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";

function Value(props: { value: unknown; depth?: number }): JSX.Element {
  const depth = () => props.depth ?? 0;
  if (props.value === null || typeof props.value !== "object") return <span class="whitespace-pre-wrap break-words text-base text-ink-gray-8">{props.value === null ? "null" : String(props.value)}</span>;
  if (Array.isArray(props.value)) return <ol class="ml-5 flex list-decimal flex-col gap-1"><For each={props.value}>{(item) => <li><Value value={item} depth={depth() + 1} /></li>}</For></ol>;
  const entries = () => Object.entries(props.value as Record<string, unknown>);
  return <dl class={`flex flex-col gap-2 ${depth() ? "border-l border-outline-gray-2 pl-3" : ""}`}><For each={entries()}>{([key, value]) => <div class="grid gap-1 sm:grid-cols-[minmax(8rem,0.35fr)_1fr]">
    <dt class="text-base-medium text-ink-gray-7">{key.replaceAll("-", " ")}</dt><dd class="min-w-0"><Value value={value} depth={depth() + 1} /></dd>
  </div>}</For></dl>;
}

export function StructuredOutputView(props: { value: unknown }): JSX.Element {
  const [raw, setRaw] = createSignal(false);
  return <div class="brain-detail-stack">
    <div><Button variant="ghost" size="sm" class="min-h-11" onClick={() => setRaw(!raw())}>{raw() ? "Readable view" : "Raw JSON"}</Button></div>
    <Show when={raw()} fallback={<Value value={props.value} />}><pre class="brain-readable overflow-auto whitespace-pre-wrap break-words rounded-card bg-surface-gray-1 p-4 text-caption">{JSON.stringify(props.value, null, 2)}</pre></Show>
  </div>;
}
