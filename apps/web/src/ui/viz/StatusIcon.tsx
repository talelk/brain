import { Show } from "solid-js";
import type { JSX } from "solid-js";
import type { BadgeTheme } from "@talelk/newui-atoms";
import { AlertTriangleLineIcon, CloseCircleLineIcon, SuccessLineIcon } from "@talelk/newui-icons";

/** State-specific glyphs, so two states with the same tone still differ by shape. */
const STATE_ICON: Record<string, string> = {
  backlog: "lucide-circle-dashed", ready: "lucide-circle-play", "in-progress": "lucide-loader-circle", running: "lucide-loader-circle",
  review: "lucide-eye", blocked: "lucide-octagon-x", abandoned: "lucide-circle-slash", pending: "lucide-hourglass",
  queued: "lucide-hourglass", paused: "lucide-circle-pause", cancelled: "lucide-circle-slash",
};

const TONE_INK: Record<string, string> = { green: "text-ink-green-8", red: "text-ink-red-8", amber: "text-ink-amber-8", blue: "text-ink-blue-8" };

/** The icon for a state value and tone; shape carries the meaning so tone is never the only signal. Decorative: pair it with the state's text. */
export function StatusIcon(props: { state: string; theme: BadgeTheme; class?: string }): JSX.Element {
  const size = () => props.class ?? "size-3";
  const named = () => STATE_ICON[props.state.toLowerCase()];
  return <span class={`inline-flex shrink-0 ${TONE_INK[props.theme] ?? "text-ink-gray-7"}`}>
    <Show when={named()} fallback={
      props.theme === "green" ? <SuccessLineIcon class={size()} />
        : props.theme === "red" ? <CloseCircleLineIcon class={size()} />
          : props.theme === "amber" ? <AlertTriangleLineIcon class={size()} />
            : <span class={`${props.theme === "blue" ? "lucide-activity" : "lucide-circle"} ${size()}`} aria-hidden="true" />}>
      {(icon) => <span class={`${icon()} ${size()}`} aria-hidden="true" />}
    </Show>
  </span>;
}
