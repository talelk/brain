import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

/** The mission lifecycle, in order. */
export const FLOW_STEPS = [{ id: "plan", label: "Plan" }, { id: "confirm", label: "Confirm" }, { id: "start", label: "Start" }, { id: "review", label: "Review" }, { id: "close", label: "Close" }] as const;
export type FlowStep = (typeof FLOW_STEPS)[number]["id"];

/** Plan → Confirm → Start → Review → Close: earlier steps are checked, the current one carries aria-current="step", later ones stay muted. */
export function FlowStepper(props: { current: FlowStep }): JSX.Element {
  const index = () => FLOW_STEPS.findIndex((step) => step.id === props.current);
  return <ol aria-label="Mission progress" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-interface">
    <For each={FLOW_STEPS}>{(step, i) => <li class="flex items-center gap-2" aria-current={i() === index() ? "step" : undefined}>
      <span class={`inline-flex items-center gap-1.5 ${i() === index() ? "text-base-medium text-ink-blue-8" : i() < index() ? "text-ink-gray-8" : "text-ink-gray-6"}`}>
        <span class={`grid size-5 place-items-center rounded-full text-caption ${i() === index() ? "bg-surface-blue-9 text-white" : i() < index() ? "bg-surface-blue-2 text-ink-blue-8" : "bg-surface-gray-3 text-ink-gray-7"}`}>
          <Show when={i() < index()} fallback={i() + 1}><span class="lucide-check size-3" aria-hidden="true" /><span class="sr-only">Done: </span></Show>
        </span>{step.label}
      </span>
      <Show when={i() < FLOW_STEPS.length - 1}><span class="lucide-chevron-right size-3.5 text-ink-gray-5" aria-hidden="true" /></Show>
    </li>}</For>
  </ol>;
}
