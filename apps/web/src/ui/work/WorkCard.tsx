import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import type { WorkItem } from "@brain/contracts";
import { statusLabel, statusTheme } from "../components/StatusBadge";
import { StatusIcon } from "../viz/StatusIcon";
import { minutesText, nextActionOf, waitReason, type NextAction } from "./work-model";

const ACCENT: Record<string, string> = {
  gray: "bg-surface-gray-5", blue: "bg-surface-blue-7", amber: "bg-surface-amber-6", red: "bg-surface-red-7", green: "bg-surface-green-7",
};
const STATE_INK: Record<string, string> = {
  gray: "text-ink-gray-7", blue: "text-ink-blue-8", amber: "text-ink-amber-8", red: "text-ink-red-8", green: "text-ink-green-8",
};

/**
 * One work item as a card, shared by the Board and the Timeline: state (icon,
 * colour edge and words), owner, dependencies, evidence and hand-off status,
 * why it waits, and its one next action. The title opens the item; the action
 * reuses the existing flow (Start dispatch, Review, Hand off, Unblock).
 */
export function WorkCard(props: {
  item: WorkItem;
  items: readonly WorkItem[];
  owner?: string;
  estimateMinutes?: number;
  handoffRequired: boolean;
  canDispatch: boolean;
  critical?: boolean;
  /** The Board's column already names the state; the Timeline shows it. */
  showState?: boolean;
  onOpen: () => void;
  onAction: (action: NextAction) => void;
}): JSX.Element {
  const theme = () => statusTheme("workItem", props.item.state);
  const deps = () => props.item.dependsOn.length;
  const depsDone = () => props.item.dependsOn.filter((id) => props.items.find((other) => other.workItemId === id)?.state === "done").length;
  const action = () => nextActionOf(props.item, props.handoffRequired, props.canDispatch);
  const done = () => props.item.state === "done";
  const evidence = (): { icon: string; text: string; tone: string } | undefined => {
    if (props.item.evidenceDigest) return { icon: "lucide-shield-check", text: "Evidence verified", tone: "text-ink-green-8" };
    if (props.item.state === "review") return { icon: "lucide-shield-question", text: "Evidence to check", tone: "text-ink-amber-8" };
    return undefined;
  };
  return <article class={`relative flex min-w-0 flex-col gap-2 ps-2 ${done() ? "opacity-80" : ""}`} aria-label={props.item.title} data-work-item={props.item.workItemId}>
    <span class={`absolute inset-y-0 start-0 w-0.5 rounded-full ${ACCENT[theme()] ?? ACCENT.gray}`} aria-hidden="true" />
    <div class="flex min-w-0 items-start gap-2">
      <span class="mt-0.5"><StatusIcon state={props.item.state} theme={theme()} class="size-4" /></span>
      <button type="button" aria-label={`Manage ${props.item.title}`} onClick={() => props.onOpen()}
        class={`min-w-0 flex-1 cursor-pointer rounded-control text-start text-interface font-medium leading-snug text-ink-gray-9 hover:text-ink-blue-link hover:underline focus-visible:focus-ring ${done() ? "line-through decoration-outline-gray-3" : ""}`}>{props.item.title}</button>
    </div>
    <Show when={props.showState || props.critical}>
      <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption">
        <Show when={props.showState}><span class={`font-medium ${STATE_INK[theme()] ?? STATE_INK.gray}`}>{props.item.state === "backlog" && deps() ? "Waiting" : statusLabel("workItem", props.item.state)}</span></Show>
        <Show when={props.critical}><span class="inline-flex items-center gap-1 rounded-full bg-surface-blue-2 px-1.5 text-ink-blue-8"><span class="lucide-route size-3" aria-hidden="true" />Critical path</span></Show>
      </p>
    </Show>
    <ul class="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-6" aria-label="Facts">
      <Show when={props.owner}><li class="inline-flex min-w-0 items-center gap-1" title="Who works on it"><span class="lucide-bot size-3.5 shrink-0" aria-hidden="true" /><span class="truncate">{props.owner}</span></li></Show>
      <Show when={deps() > 0}><li class="inline-flex items-center gap-1" title="Tasks that must be verified done first">
        <span class={`${depsDone() === deps() ? "lucide-link" : "lucide-lock"} size-3.5`} aria-hidden="true" />{depsDone()} of {deps()} {deps() === 1 ? "dependency" : "dependencies"} done</li></Show>
      <Show when={props.estimateMinutes}>{(minutes) => <li class="inline-flex items-center gap-1" title="Estimated effort"><span class="lucide-clock size-3.5" aria-hidden="true" />{minutesText(minutes())}</li>}</Show>
      <Show when={evidence()}>{(entry) => <li class={`inline-flex items-center gap-1 ${entry().tone}`}><span class={`${entry().icon} size-3.5`} aria-hidden="true" />{entry().text}</li>}</Show>
      <Show when={props.handoffRequired && props.item.state === "review"}><li class="inline-flex items-center gap-1 text-ink-amber-8"><span class="lucide-send size-3.5" aria-hidden="true" />Hand-off due</li></Show>
    </ul>
    <Show when={waitReason(props.item)}>{(reason) => <p class="flex items-start gap-1 text-caption text-ink-amber-8"><span class="lucide-hourglass mt-0.5 size-3 shrink-0" aria-hidden="true" />{reason()}</p>}</Show>
    <Show when={action()}>{(next) => <div>
      <Button size="sm" variant={next().kind === "follow" ? "ghost" : "outline"} theme={next().kind === "follow" ? "gray" : "blue"} iconLeft={next().icon}
        aria-label={`${next().label} ${props.item.title}`} onClick={() => props.onAction(next())}>{next().label}</Button>
    </div>}</Show>
  </article>;
}
