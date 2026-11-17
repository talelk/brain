import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { EmptyState } from "@talelk/newui-molecules";
import type { SnapshotManifest, TaskSummary } from "@brain/contracts";
import { t, tn } from "../i18n";
import { chord, NODE_W, ring } from "../lib/graph";
import { handoffs, type Handoff } from "../lib/team";

const NODE_H = 58;
/** How far an arrow bows to its side, so a "checks" arrow does not lie on a "hands over" arrow between the same two agents. */
const BOW = { work: 20, check: 50 } as const;

const words = (edge: Handoff): string => {
  const what = t(edge.kind === "work" ? "team.work" : "team.check", { from: edge.from, to: edge.to });
  return edge.count > 0 ? `${what}: ${tn(edge.kind === "work" ? "team.times.work" : "team.times.check", edge.count)}` : `${what}: ${t("team.planned")}`;
};

/** The workspace's agents as boxes and the handoffs between them as arrows: solid "hands over", dashed "checks"; faint when only a Play names it. */
export function TeamGraph(props: { snapshot: SnapshotManifest; tasks: readonly TaskSummary[]; href: (agent: string) => string }): JSX.Element {
  const [hover, setHover] = createSignal<string>();
  const edges = createMemo(() => handoffs(props.snapshot, props.tasks));
  const seen = (): boolean => edges().some((edge) => edge.count > 0);
  const shape = createMemo(() => ring(Object.keys(props.snapshot.agents), edges(), NODE_H));
  const key = (edge: Handoff): string => `${edge.kind}:${edge.from}:${edge.to}`;
  const geometry = (edge: Handoff): { d: string; mx: number; my: number } | undefined => {
    const from = shape().spots.find((spot) => spot.id === edge.from);
    const to = shape().spots.find((spot) => spot.id === edge.to);
    return from && to ? chord(from, to, BOW[edge.kind]) : undefined;
  };
  const marker = (edge: Handoff): string => (edge.count > 0 ? "solid" : "quiet");
  return (
    <div>
      <Show when={edges().length > 0} fallback={<EmptyState bordered icon="lucide-network" title={t("team.empty.title")} description={t("team.empty.text")} />}>
        <div class="graph-scroll max-sm:hidden">
          <div class="graph mx-auto" style={{ width: `${shape().width}px`, height: `${shape().height}px` }}>
            <svg class="graph-edges" width={shape().width} height={shape().height} aria-hidden="true">
              <defs>
                <For each={["quiet", "solid", "active"]}>{(kind) => <marker id={`team-arrow-${kind}`} class={`arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1,1 L9,5 L1,9 z" /></marker>}</For>
              </defs>
              <For each={edges()}>
                {(edge) => (
                  <Show when={geometry(edge)}>
                    {(line) => (
                      <g class="team-edge" data-kind={edge.kind} data-planned={edge.count === 0} onPointerEnter={() => setHover(key(edge))} onPointerLeave={() => setHover(undefined)}>
                        <title>{words(edge)}</title>
                        <path class="hit" d={line().d} />
                        <path class={`link edge-${hover() === key(edge) ? "active" : marker(edge)}`} d={line().d} marker-end={`url(#team-arrow-${hover() === key(edge) ? "active" : marker(edge)})`} />
                        <Show when={edge.count > 0}>
                          <g class="count" transform={`translate(${line().mx} ${line().my})`}>
                            <rect x="-13" y="-9" width="26" height="18" rx="9" />
                            <text text-anchor="middle" dominant-baseline="central">{edge.count}</text>
                          </g>
                        </Show>
                      </g>
                    )}
                  </Show>
                )}
              </For>
            </svg>
            <ol class="graph-nodes" aria-label={t("team.agents")}>
              <For each={shape().spots}>
                {(spot) => (
                  <li class="gnode gnode-agent-box" style={{ "inset-inline-start": `${spot.x}px`, top: `${spot.y}px`, width: `${NODE_W}px`, height: `${spot.h}px` }}>
                    <A class="gnode-main" href={props.href(spot.id)}>
                      <span class="gnode-title t-code"><bdi>{spot.id}</bdi></span>
                      <span class="t-small text-ink-2 gnode-phrase" dir="auto">{props.snapshot.agents[spot.id]?.description}</span>
                    </A>
                  </li>
                )}
              </For>
            </ol>
          </div>
        </div>
        <ul class="flex flex-col gap-2 sm:sr-only" aria-label={t("team.handoffs")}><For each={edges()}>{(edge) => <li class="rounded-control border border-outline-gray-1 bg-surface-elevation-1 px-3 py-2 t-small text-ink">{words(edge)}</li>}</For></ul>
        <p class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 t-small text-ink-2">
          <span class="inline-flex items-center gap-2"><svg width="28" height="8" aria-hidden="true" class="team-key"><path d="M0,4 H28" class="edge-solid" /></svg>{t("team.key.work")}</span>
          <span class="inline-flex items-center gap-2"><svg width="28" height="8" aria-hidden="true" class="team-key team-key-check"><path d="M0,4 H28" class="edge-solid" /></svg>{t("team.key.check")}</span>
          <Show when={!seen()}><span>{t("team.key.planned")}</span></Show>
        </p>
      </Show>
      <p class="mt-2 t-small text-ink-3">{t("team.never")}</p>
    </div>
  );
}
