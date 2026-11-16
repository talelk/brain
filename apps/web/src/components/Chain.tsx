import { For, Show, type Accessor, type JSX } from "solid-js";
import type { Approval, Check, Task, TaskState, TaskSummary } from "@brain/contracts";
import { t } from "../i18n";
import { money, shownState, titleOf } from "../lib/format";
import { Keyed, needText } from "./bits";

/**
 * The record of a goal, drawn as a chain. The goal is the first link and every sub-task is a link after it; a link turns to solid ink when
 * its result is checked. A check and an approval hang off their link as smaller links. The running link is the only thing that moves.
 */

/** One link, seen face on: a ring whose stroke says the state. */
function Link(props: { state: TaskSummary["state"] }): JSX.Element {
  return (
    <span class="chain-link" data-state={props.state} aria-hidden="true">
      <svg viewBox="0 0 28 44">
        <rect class="ring" x="2.5" y="2.5" width="23" height="39" rx="11.5" pathLength="100" />
        <Show when={props.state === "running"}><rect class="runner" x="2.5" y="2.5" width="23" height="39" rx="11.5" pathLength="100" /></Show>
      </svg>
      <Show when={props.state === "done"}><span class="mark lucide-check" /></Show>
      <Show when={props.state === "needs_you"}><span class="mark dot" /></Show>
      <Show when={props.state === "failed"}><span class="mark lucide-x" /></Show>
      <Show when={props.state === "stopped"}><span class="mark lucide-minus" /></Show>
    </span>
  );
}

type Tone = "ok" | "needs" | "bad" | "quiet";
interface Hang { readonly tone: Tone; readonly text: string }

function hangs(checks: readonly Check[], approvals: readonly Approval[]): Hang[] {
  const checked = checks.map((check): Hang => ({ tone: check.pass ? "ok" : "bad", text: t(check.pass ? "hang.check.pass" : "hang.check.fail", { by: check.by.name, round: check.round }) }));
  const approved = approvals.map((approval): Hang => {
    if (approval.state === "pending") return { tone: "needs", text: t("hang.approval.pending", { tool: approval.tool }) };
    if (approval.standing) return { tone: "ok", text: t("hang.approval.standing", { tool: approval.tool }) };
    if (approval.state === "approved") return { tone: "ok", text: t("hang.approval.approved", { tool: approval.tool, by: approval.decidedBy?.name ?? "" }) };
    return { tone: approval.state === "rejected" ? "bad" : "quiet", text: t(`hang.approval.${approval.state}`, { tool: approval.tool, by: approval.decidedBy?.name ?? "" }) };
  });
  return [...checked, ...approved];
}

/** What a link says under its title: who is on it and where it stands, as one plain phrase. */
function phrase(task: TaskSummary, record: Task, shown: TaskState): string {
  const agent = task.agent ?? "";
  if (task.state === "needs_you" && task.needs) return needText(task.needs);
  if (shown === "needs_you") return t("link.needsYou");
  if (task.state === "done") {
    const last = record.checks.filter((check) => check.taskId === task.id).at(-1);
    if (last) return t("link.done.checked", { by: last.by.name });
    return task.agent !== null && !record.attempts.some((attempt) => attempt.taskId === task.id) ? t("link.skipped") : t("link.done");
  }
  if (task.state === "running") return agent ? (task.round > 1 ? t("link.running.round", { agent, round: task.round }) : t("link.running", { agent })) : t("state.running");
  if (task.state === "waiting" || task.state === "ready") return agent ? t(`link.${task.state}`, { agent }) : t(`state.${task.state}`);
  return t(`state.${task.state}`);
}

export function Chain(props: { record: Task; order?: readonly string[]; selected: string; onSelect: (id: string) => void }): JSX.Element {
  const childrenOf = (id: string): TaskSummary[] => {
    const children = props.record.subtasks.filter((task) => task.parentId === id);
    const order = props.order;
    return order && id === props.record.id ? [...children].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : children;
  };
  const shown = shownState;
  const item = (task: Accessor<TaskSummary>, title: () => string): JSX.Element => {
    const mine = (): Hang[] => hangs(props.record.checks.filter((check) => check.taskId === task().id), props.record.approvals.filter((approval) => approval.taskId === task().id));
    const selected = (): boolean => props.selected === task().id;
    const tone = (): string => { const state = shown(task()); return state === "needs_you" ? "font-medium text-needs-text" : state === "failed" ? "text-bad" : state === "running" ? "text-violet-text" : "text-ink-3"; };
    return (
      <li class="chain-item" data-selected={selected()} data-solid={task().state === "done"}>
        <Link state={shown(task())} />
        <div class="min-w-0">
          <button type="button" class="chain-row" aria-current={selected() ? "true" : undefined} onClick={() => props.onSelect(task().id)}>
            <span class="flex items-baseline gap-3">
              <span class="min-w-0 flex-1 font-display text-[1.0625rem] font-semibold leading-snug text-ink"><bdi>{title()}</bdi></span>
              <Show when={task().microUsd > 0}><span class="t-small tabular-nums text-ink-3">{money(task().microUsd)}</span></Show>
            </span>
            <span class={`block t-small ${tone()}`}>{phrase(task(), props.record, shown(task()))}</span>
          </button>
          <Show when={mine().length > 0}>
            <ul class="chain-hangs">
              <For each={mine()}>{(hang) => <li class="chain-hang t-small" data-tone={hang.tone}><span class="small-ring" aria-hidden="true" /><span class="min-w-0">{hang.text}</span></li>}</For>
            </ul>
          </Show>
          <Show when={task().id !== props.record.id && childrenOf(task().id).length > 0}>
            <ol class="chain"><Keyed each={childrenOf(task().id)} by={(child) => child.id}>{(child) => item(child, () => titleOf(child()))}</Keyed></ol>
          </Show>
        </div>
      </li>
    );
  };
  return (
    <ol class="chain" aria-label={t("chain.label")}>
      {item(() => props.record, () => t("chain.goal"))}
      <Keyed each={childrenOf(props.record.id)} by={(task) => task.id}>{(task) => item(task, () => titleOf(task()))}</Keyed>
    </ol>
  );
}
