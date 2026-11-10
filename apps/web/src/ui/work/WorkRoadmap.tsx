import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { workGraph, type GraphNode } from "./work-model";

/** A node of the roadmap: one plan task or work item, with its dependencies. */
export interface RoadmapNode extends GraphNode { title: string }

interface Edge { from: string; to: string; d: string; critical: boolean; done: boolean }

/**
 * The dependency-aware roadmap: tasks laid out left to right in stages (a
 * task sits one stage after the last thing it waits for), connected by their
 * dependencies, with the critical path — the longest chain of work still to
 * do — drawn in the accent colour. Cards are rendered by the caller, so the
 * same map serves a plan proposal (no state yet) and live work items.
 */
export function WorkRoadmap(props: {
  nodes: readonly RoadmapNode[];
  label: string;
  renderNode: (node: RoadmapNode, critical: boolean) => JSX.Element;
}): JSX.Element {
  const graph = createMemo(() => workGraph(props.nodes));
  const critical = createMemo(() => new Set(graph().critical));
  const criticalEdges = createMemo(() => {
    const chain = graph().critical;
    return new Set(chain.slice(1).map((id, index) => `${chain[index]}>${id}`));
  });
  const nodeById = createMemo(() => new Map(props.nodes.map((node) => [node.id, node])));
  /** Within a stage: the critical task first, open work before done work, then the plan's own order. */
  const ordered = (ids: readonly string[]) => [...ids].sort((a, b) =>
    Number(critical().has(b)) - Number(critical().has(a)) || Number(!!nodeById().get(a)?.done) - Number(!!nodeById().get(b)?.done));
  const stageName = (index: number) => (index === 0 ? "Stage 1 · no prerequisites" : `Stage ${index + 1} · after stage ${index}`);
  const [edges, setEdges] = createSignal<Edge[]>([]);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  let canvas: HTMLOListElement | undefined;
  const arrow = `roadmap-arrow-${createUniqueId()}`;

  // Connectors are measured from the laid-out cards, so they follow any card
  // height (wrapped titles, wait reasons) and every viewport width.
  const measure = () => {
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const rect = (id: string) => canvas?.querySelector<HTMLElement>(`[data-roadmap-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    setSize({ width: canvas.scrollWidth, height: canvas.scrollHeight });
    setEdges(graph().edges.flatMap((edge) => {
      const a = rect(edge.from);
      const b = rect(edge.to);
      if (!a || !b) return [];
      const x1 = a.right - box.left;
      const y1 = a.top + Math.min(28, a.height / 2) - box.top;
      const x2 = b.left - box.left;
      const y2 = b.top + Math.min(28, b.height / 2) - box.top;
      const bend = Math.max(16, (x2 - x1) / 2);
      return [{
        from: edge.from, to: edge.to,
        d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        critical: criticalEdges().has(`${edge.from}>${edge.to}`),
        done: !!nodeById().get(edge.from)?.done,
      }];
    }));
  };
  onMount(() => {
    const observer = new ResizeObserver(() => requestAnimationFrame(measure));
    if (canvas) observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => { void graph(); void props.nodes.length; requestAnimationFrame(measure); });

  return <div class="min-w-0 overflow-x-auto pb-2" data-testid="work-roadmap">
    <ol ref={canvas} aria-label={props.label} class="relative m-0 grid list-none p-0 min-w-0 gap-y-6 sm:w-max sm:min-w-full sm:auto-cols-[minmax(14rem,16rem)] sm:grid-flow-col sm:items-start sm:gap-x-10">
      <svg class="pointer-events-none absolute inset-0 hidden overflow-visible sm:block" width={size().width} height={size().height} aria-hidden="true">
        <defs>
          <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--outline-gray-3)" />
          </marker>
          <marker id={`${arrow}-critical`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--surface-blue-7)" />
          </marker>
        </defs>
        <For each={edges().filter((edge) => !edge.critical)}>{(edge) => <path d={edge.d} fill="none" stroke="var(--outline-gray-3)" stroke-width="1.5" stroke-dasharray={edge.done ? "4 4" : undefined} marker-end={`url(#${arrow})`} />}</For>
        <For each={edges().filter((edge) => edge.critical)}>{(edge) => <path d={edge.d} fill="none" stroke="var(--surface-blue-7)" stroke-width="2.5" marker-end={`url(#${arrow}-critical)`} />}</For>
      </svg>
      <For each={graph().stages}>{(ids, index) => <li class="relative flex min-w-0 flex-col gap-3" aria-label={stageName(index())}>
        <p class="flex items-center gap-1.5 text-caption font-medium text-ink-gray-7" aria-hidden="true">
          <span class="grid size-5 place-items-center rounded-full bg-surface-gray-2 text-[0.6875rem] text-ink-gray-7">{index() + 1}</span>
          {stageName(index())}
        </p>
        <For each={ordered(ids)}>{(id) => <Show when={nodeById().get(id)}>{(node) =>
          <div data-roadmap-node={id} class={`relative rounded-card border bg-surface-elevation-1 p-3 shadow-sm transition-colors ${critical().has(id) ? "border-outline-blue-3 ring-1 ring-outline-blue-2" : "border-outline-gray-2"}`}>
            {props.renderNode(node(), critical().has(id))}
          </div>}</Show>}</For>
      </li>}</For>
    </ol>
  </div>;
}
