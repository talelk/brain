import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import type { Approval, Check, Task, TaskState, TaskSummary } from "@brain/contracts";
import { t } from "../i18n";
import { isolate, money, shownState, titleOf } from "../lib/format";
import { curve, layout, NODE_W, type Link, type Placed } from "../lib/graph";
import { needText } from "./bits";

/**
 * The record of a goal, drawn as a graph. The goal is the first node and every sub-task a node after it, in a column by how many steps
 * it waits behind; copies of a for-each step stand in one column. An edge runs from what a task waits for. A check and an approval hang
 * under their node. Only a running node moves.
 */

/** The mark of a state: a ring, with what the state adds inside it. */
function Mark(props: { state: TaskState }): JSX.Element {
  return (
    <span class="gmark" data-state={props.state} aria-hidden="true">
      <svg viewBox="0 0 20 20"><circle class="ring" cx="10" cy="10" r="8" pathLength="100" /><Show when={props.state === "running"}><circle class="runner" cx="10" cy="10" r="8" pathLength="100" /></Show></svg>
      <Show when={props.state === "done"}><span class="glyph lucide-check" /></Show>
      <Show when={props.state === "needs_you"}><span class="glyph dot" /></Show>
      <Show when={props.state === "failed"}><span class="glyph lucide-x" /></Show>
      <Show when={props.state === "stopped"}><span class="glyph lucide-minus" /></Show>
    </span>
  );
}

type Tone = "ok" | "needs" | "bad" | "quiet";
interface Hang { readonly tone: Tone; readonly text: string }

function hangs(checks: readonly Check[], approvals: readonly Approval[]): Hang[] {
  const checked = checks.map((check): Hang => ({ tone: check.pass ? "ok" : "bad", text: t(check.pass ? "hang.check.pass" : "hang.check.fail", { by: isolate(check.by.name), round: check.round }) }));
  const approved = approvals.map((approval): Hang => {
    if (approval.state === "pending") return { tone: "needs", text: t("hang.approval.pending", { tool: isolate(approval.tool) }) };
    if (approval.standing) return { tone: "ok", text: t("hang.approval.standing", { tool: isolate(approval.tool) }) };
    if (approval.state === "approved") return { tone: "ok", text: t("hang.approval.approved", { tool: isolate(approval.tool), by: isolate(approval.decidedBy?.name ?? "") }) };
    return { tone: approval.state === "rejected" ? "bad" : "quiet", text: t(`hang.approval.${approval.state}`, { tool: isolate(approval.tool), by: isolate(approval.decidedBy?.name ?? "") }) };
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
    if (last) return t("link.done.checked", { by: isolate(last.by.name) });
    return task.agent !== null && !record.attempts.some((attempt) => attempt.taskId === task.id) ? t("link.skipped") : t("link.done");
  }
  if (task.state === "running") return agent ? (task.round > 1 ? t("link.running.round", { agent: isolate(agent), round: task.round }) : t("link.running", { agent: isolate(agent) })) : t("state.running");
  if (task.state === "waiting" || task.state === "ready") return agent ? t(`link.${task.state}`, { agent: isolate(agent) }) : t(`state.${task.state}`);
  return t(`state.${task.state}`);
}


const HANG_H = 17;
/** A check or approval line takes a second line when its words are long: the box is as tall as what hangs under it. */
const hangHeight = (hang: Hang): number => (hang.text.length > 27 ? 2 * HANG_H - 2 : HANG_H);
const NODE_H = 74;

export function TaskGraph(props: { record: Task; order?: readonly string[]; selected: string; onSelect: (id: string) => void }): JSX.Element {
  const tasks = createMemo((): TaskSummary[] => {
    const order = props.order;
    const subs = order ? [...props.record.subtasks].sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9)) : [...props.record.subtasks];
    return [props.record, ...subs];
  });
  const mine = (id: string): Hang[] => hangs(props.record.checks.filter((check) => check.taskId === id), props.record.approvals.filter((approval) => approval.taskId === id));
  /** The tasks whose end a dependency really is: a for-each step is done when its copies are, so a task that waits for it waits for them. */
  const leaves = (id: string): string[] => { const children = props.record.subtasks.filter((sub) => sub.parentId === id); return children.length === 0 ? [id] : children.flatMap((child) => leaves(child.id)); };
  const links = createMemo((): Link[] => props.record.subtasks.flatMap((sub): Link[] => {
    const waits = sub.waitsFor.flatMap(leaves);
    const parent = sub.parentId !== null ? [sub.parentId] : [];
    const from = sub.parentId === props.record.id && waits.length > 0 ? waits : [...parent, ...waits];
    return [...new Set(from)].map((id) => ({ from: id, to: sub.id }));
  }));
  const shape = createMemo(() => layout(tasks().map((task) => ({ id: task.id, h: NODE_H + mine(task.id).reduce((sum, hang) => sum + hangHeight(hang), 0) })), links()));
  const byId = (id: string): TaskSummary => tasks().find((task) => task.id === id) as TaskSummary;
  let scroller: HTMLDivElement | undefined;
  /** The selected node is brought into view inside the graph, which scrolls sideways when it is wider than its pane. */
  createEffect(on(() => [props.selected, shape().width], () => queueMicrotask(() => scroller?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ inline: "center", block: "nearest" }))));
  /** A graph wider than its pane scrolls sideways, with a fade where more lies beyond; "fit" shrinks it to the pane instead. */
  const [pane, setPane] = createSignal(0);
  // A graph only a little wider than its pane is fitted at first, so a person never meets a half-cut card; the button still decides after that.
  const [chosen, setFit] = createSignal<boolean | undefined>(undefined);
  const fit = (): boolean => chosen() ?? (pane() > 0 && shape().width + 8 > pane() && (pane() - 8) / shape().width >= 0.7);
  const [more, setMore] = createSignal({ start: false, end: false });
  const wider = (): boolean => pane() > 0 && shape().width + 8 > pane();
  const scale = (): number => (fit() && wider() ? Math.max(0.2, (pane() - 8) / shape().width) : 1);
  const edges = (): void => {
    if (!scroller) return;
    const at = Math.abs(scroller.scrollLeft);
    setMore({ start: at > 2, end: at + scroller.clientWidth < scroller.scrollWidth - 2 });
  };
  onMount(() => {
    const watch = new ResizeObserver(() => { setPane(scroller?.clientWidth ?? 0); edges(); });
    if (scroller) watch.observe(scroller);
    onCleanup(() => watch.disconnect());
  });
  createEffect(on([shape, scale], () => queueMicrotask(edges)));
  const touches = (link: Link): boolean => link.from === props.selected || link.to === props.selected;
  return (
    <div class="graph-frame">
      <Show when={wider()}>
        <div class="graph-tools"><Button variant="ghost" size="sm" iconLeft={fit() ? "lucide-maximize-2" : "lucide-minimize-2"} onClick={() => setFit(!fit())} aria-pressed={fit()}>{fit() ? t("graph.full") : t("graph.fit")}</Button></div>
      </Show>
    <div class="graph-scroll" ref={scroller} role="group" aria-label={t("graph.label")} onScroll={edges} data-more-start={more().start} data-more-end={more().end}>
      <div class="graph" style={{ width: `${shape().width}px`, height: `${shape().height}px`, zoom: scale() === 1 ? undefined : scale() }}>
        <svg class="graph-edges" width={shape().width} height={shape().height} aria-hidden="true">
          <defs>
            <For each={["quiet", "solid", "active"]}>{(kind) => <marker id={`graph-arrow-${kind}`} class={`arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1,1 L9,5 L1,9 z" /></marker>}</For>
          </defs>
          <For each={links()}>
            {(link) => {
              const from = (): Placed | undefined => shape().placed.get(link.from);
              const to = (): Placed | undefined => shape().placed.get(link.to);
              const kind = (): string => (touches(link) ? "active" : byId(link.from).state === "done" ? "solid" : "quiet");
              return <Show when={from() && to()}><path class={`edge edge-${kind()}`} d={curve(from() as Placed, to() as Placed)} marker-end={`url(#graph-arrow-${kind()})`} /></Show>;
            }}
          </For>
        </svg>
        <ol class="graph-nodes">
          <For each={shape().order}>
            {(spot) => {
              const task = (): TaskSummary => byId(spot.id);
              const state = (): TaskState => shownState(task());
              const isGoal = (): boolean => task().id === props.record.id;
              const selected = (): boolean => props.selected === task().id;
              const tone = (): string => (state() === "needs_you" ? "font-medium text-needs-text" : state() === "failed" ? "text-bad" : state() === "running" ? "text-violet-text" : "text-ink-3");
              return (
                <li class="gnode" data-state={state()} data-selected={selected()} style={{ "inset-inline-start": `${spot.x}px`, top: `${spot.y}px`, width: `${NODE_W}px`, height: `${spot.h}px` }}>
                  <button type="button" class="gnode-main" aria-current={selected() ? "true" : undefined} onClick={() => props.onSelect(task().id)}>
                    <span class="gnode-top"><Mark state={state()} /><span class="gnode-title"><bdi>{isGoal() ? t("graph.goal") : titleOf(task())}</bdi></span></span>
                    <span class="gnode-line t-small text-ink-2">
                      <Show when={task().agent}><span class="gnode-agent"><bdi>{task().agent}</bdi></span></Show>
                      <Show when={task().round > 1}><span class="gnode-round"><span class="lucide-repeat" aria-hidden="true" />{t("graph.round", { round: task().round })}</span></Show>
                      <Show when={task().microUsd > 0}><span class="ms-auto tabular-nums text-ink-3">{money(task().microUsd)}</span></Show>
                    </span>
                    <span class={`gnode-phrase t-small ${tone()}`}>{phrase(task(), props.record, state())}</span>
                  </button>
                  <Show when={mine(task().id).length > 0}>
                    <ul class="gnode-hangs">
                      <For each={mine(task().id)}>{(hang) => <li class="chain-hang t-small" data-tone={hang.tone} style={{ height: `${hangHeight(hang)}px` }}><span class="small-ring" aria-hidden="true" /><span class="min-w-0 line-clamp-2">{hang.text}</span></li>}</For>
                    </ul>
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
      </div>
    </div>
    </div>
  );
}
