import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { A } from "@solidjs/router";
import type { WorkItem } from "@brain/contracts";
import { statusLabel, statusTheme } from "../components/StatusBadge";
import { formatInstant } from "../format";
import { StatusIcon } from "../viz/StatusIcon";
import { t } from "../../i18n";
import { TaskNowLine } from "./TaskNow";
import { minutesText, nextActionOf, waitReason, type NextAction } from "./work-model";

const ACCENT: Record<string, string> = {
  gray: "bg-surface-gray-5", blue: "bg-surface-blue-7", amber: "bg-surface-amber-6", red: "bg-surface-red-7", green: "bg-surface-green-7",
};
const STATE_INK: Record<string, string> = {
  gray: "text-ink-gray-7", blue: "text-ink-blue-8", amber: "text-ink-amber-8", red: "text-ink-red-8", green: "text-ink-green-8",
};

const PRIORITY_MARK: Record<string, { icon: string; tone: string }> = {
  urgent: { icon: "lucide-chevrons-up", tone: "text-ink-red-8" }, high: { icon: "lucide-arrow-up", tone: "text-ink-amber-8" }, low: { icon: "lucide-arrow-down", tone: "text-ink-gray-6" },
};

/** "15 Jan 2026" in the viewer's language and timezone. */
const dayText = (value: string): string => formatInstant(value, { day: "numeric", month: "short", year: "numeric" });

/**
 * One work item as a card, shared by the Board and the Timeline: state (icon,
 * colour edge and words), owner, dependencies, evidence and hand-off status,
 * why it waits, and its one next action. The title opens the item; the action
 * reuses the existing flow (Start dispatch, Review, Hand off, Retry).
 */
export function WorkCard(props: {
  item: WorkItem;
  items: readonly WorkItem[];
  owner?: string;
  estimateMinutes?: number;
  handoffRequired: boolean;
  canDispatch: boolean;
  critical?: boolean;
  /** The workspace board mixes missions, so each card names its own and links to it. */
  mission?: { title: string; href: string };
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
    if (props.item.evidenceDigest) return { icon: "lucide-shield-check", text: t("plan.evidence-verified.be99"), tone: "text-ink-green-8" };
    if (props.item.state === "review") return { icon: "lucide-shield-question", text: t("plan.evidence-to-check.5b0e"), tone: "text-ink-amber-8" };
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
        <Show when={props.critical}><span class="inline-flex items-center gap-1 rounded-full bg-surface-blue-2 px-1.5 text-ink-blue-8"><span class="lucide-route size-3" aria-hidden="true" />{t("plan.critical-path.c77e")}</span></Show>
      </p>
    </Show>
    <ul class="flex flex-wrap gap-x-3 gap-y-1 text-caption text-ink-gray-6" aria-label={t("plan.facts.aeff")}>
      <Show when={props.mission}>{(mission) => <li class="inline-flex min-w-0 items-center gap-1" data-testid="work-mission" title={t("board.in-mission", { title: mission().title })}>
        <span class="lucide-target size-3.5 shrink-0" aria-hidden="true" /><A href={mission().href} class="truncate rounded-control font-medium text-ink-blue-link hover:underline focus-visible:focus-ring">{mission().title}</A></li>}</Show>
      <Show when={PRIORITY_MARK[props.item.priority]}>{(mark) => <li class={`inline-flex items-center gap-1 font-medium ${mark().tone}`} title={t("work.priority")} data-testid="work-priority">
        <span class={`${mark().icon} size-3.5`} aria-hidden="true" />{t(`work.priority.${props.item.priority}` as "work.priority.urgent")}</li>}</Show>
      <Show when={props.item.dueAt}>{(due) => <li class={`inline-flex items-center gap-1 ${props.item.overdue ? "font-medium text-ink-red-8" : ""}`} title={t("work.due-date")} data-testid={props.item.overdue ? "work-overdue" : "work-due"}>
        <span class={`${props.item.overdue ? "lucide-calendar-x" : "lucide-calendar"} size-3.5`} aria-hidden="true" />{props.item.overdue ? t("work.overdue", { date: dayText(due()) }) : t("work.due", { date: dayText(due()) })}</li>}</Show>
      <For each={props.item.tags}>{(tag) => <li class="inline-flex items-center gap-1 rounded-full bg-surface-gray-2 px-1.5 text-ink-gray-7" data-testid="work-tag"><span class="lucide-tag size-3" aria-hidden="true" />{tag}</li>}</For>
      <Show when={props.owner}><li class="inline-flex min-w-0 items-center gap-1" title={t("plan.who-works-on-it.cb91")}><span class="lucide-bot size-3.5 shrink-0" aria-hidden="true" /><span class="truncate">{props.owner}</span></li></Show>
      <Show when={deps() > 0}><li class="inline-flex items-center gap-1" title={t("plan.tasks-that-must-be-verified-done.74ce")}>
        <span class={`${depsDone() === deps() ? "lucide-link" : "lucide-lock"} size-3.5`} aria-hidden="true" />{depsDone()} of {deps()} {deps() === 1 ? "dependency" : "dependencies"} done</li></Show>
      <Show when={props.estimateMinutes}>{(minutes) => <li class="inline-flex items-center gap-1" title={t("plan.estimated-effort.aea2")}><span class="lucide-clock size-3.5" aria-hidden="true" />{minutesText(minutes())}</li>}</Show>
      <Show when={evidence()}>{(entry) => <li class={`inline-flex items-center gap-1 ${entry().tone}`}><span class={`${entry().icon} size-3.5`} aria-hidden="true" />{entry().text}</li>}</Show>
      <Show when={props.handoffRequired && props.item.state === "review"}><li class="inline-flex items-center gap-1 text-ink-amber-8"><span class="lucide-send size-3.5" aria-hidden="true" />{t("plan.hand-off-due.1b75")}</li></Show>
    </ul>
    <TaskNowLine item={props.item} {...(props.estimateMinutes !== undefined ? { estimateMinutes: props.estimateMinutes } : {})} />
    <Show when={waitReason(props.item)}>{(reason) => <p class="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-caption text-ink-amber-8"><span class="lucide-hourglass mt-0.5 size-3 shrink-0" aria-hidden="true" /><span class="min-w-0 flex-1">{reason()}</span>
      <Show when={props.item.state === "blocked"}><button type="button" class="rounded-control text-start font-medium text-ink-blue-link underline focus-visible:focus-ring" data-testid="blocked-link" aria-label={`${t("work.blocked.link")}: ${props.item.title}`} onClick={() => props.onOpen()}>{t("work.blocked.link")}</button></Show></p>}</Show>
    <Show when={action()}>{(next) => <div>
      <Button size="sm" variant={next().kind === "follow" ? "ghost" : "outline"} theme={next().kind === "follow" ? "gray" : "blue"} iconLeft={next().icon}
        aria-label={`${next().label} ${props.item.title}`} onClick={() => props.onAction(next())}>{next().label}</Button>
    </div>}</Show>
  </article>;
}
