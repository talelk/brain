import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { A, useParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { EmptyState } from "@talelk/newui-molecules";
import type { Overview } from "@brain/contracts";
import { query, useLive, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { t } from "../i18n";
import { activityBuckets, feedEvents, goalStates, groupFeed, newlyDone, pushSamples, stageCounts, type Placed, type Samples } from "../lib/live";
import { Feed, Lane, reduced, Ring, River, Tick, Ticker, Tile, useTick, visible, type Ending, type Leaving } from "../components/LiveParts";
import { Head } from "../components/Shell";
import { Failure, Icon, Loading } from "../components/bits";

const LEAVE_MS = 6000;
const CELEBRATE_MS = 8000;
const MAX_WORKSPACES = 8;

/** A goal that finished while the page was open: a ring that completes, a brief glow, then it is gone. */
function Celebration(props: { title: string }): JSX.Element {
  return (
    <div class="live-glow flex items-center gap-3 rounded-card border border-ok-mark bg-ok-soft px-4 py-3" role="status" data-testid="live-celebration">
      <Ring fraction={1} tone="var(--ok-mark)" size={36} class="live-complete"><Icon name="lucide-check" class="size-4 text-ok" /></Ring>
      <p class="min-w-0 flex-1 t-text text-ink"><span class="font-medium">{t("live.goal.done")}</span> <bdi class="text-ink-2">{props.title}</bdi></p>
    </div>
  );
}

/** Live: what Brain is doing right now, drawn from the Overview, the Queue and the tasks, which every other screen reads too. */
export default function LiveScreen(): JSX.Element {
  const session = useSession();
  const params = useParams<{ slug?: string }>();
  const places = createMemo(() => session.workspaces().filter((workspace) => workspace.status === "active" && (params.slug === undefined || workspace.slug === params.slug)));
  const place = createMemo(() => (params.slug === undefined ? undefined : places()[0]));
  const now = useTick(1000);
  const slow = useTick(15_000);

  const queue = useQuery("queue", () => (params.slug === undefined ? {} : place() ? { workspaceId: (place() as { id: string }).id } : undefined));
  const tasks = useLive<Placed[]>(() => places().slice(0, MAX_WORKSPACES).map((workspace) => workspace.id).join(",") || undefined, async () => {
    const lists = await Promise.all(places().slice(0, MAX_WORKSPACES).map(async (workspace) => (await query("tasks.list", { workspaceId: workspace.id, limit: 100 })).tasks.map((task): Placed => ({ task, slug: workspace.slug, name: workspace.name }))));
    return lists.flat();
  });
  // Tokens move between live changes: a slow read keeps the streams moving while the page is on screen.
  const poll = setInterval(() => { if (visible()) queue.refetch(); }, 5000);
  onCleanup(() => clearInterval(poll));

  const overview = createMemo((): Overview | undefined => {
    const data = session.overview.data();
    if (!data) return undefined;
    const ids = new Set(places().map((workspace) => workspace.id));
    return { ...data, workspaces: data.workspaces.filter((workspace) => ids.has(workspace.id)), needsYou: data.needsYou.filter((need) => ids.has(need.workspaceId)) };
  });
  const placed = (): readonly Placed[] => tasks.data() ?? [];
  const counts = createMemo(() => stageCounts(queue.data(), overview(), placed(), slow()));
  const events = createMemo(() => feedEvents(placed()));
  const groups = createMemo(() => groupFeed(events().filter((event) => event.at >= slow() - 6 * 3_600_000)));
  const activity = createMemo(() => activityBuckets(events(), slow()));

  // Token samples of each running attempt, for the sparklines.
  const [samples, setSamples] = createSignal<Samples>(new Map());
  const runs = createMemo(() => (queue.data()?.runners ?? []).flatMap((runner) => runner.occupied.map((run) => ({ runner: runner.id, run }))));
  createEffect(on(runs, (list) => setSamples((before) => pushSamples(before, list.map((entry) => entry.run)))));

  // An attempt that leaves its slot stays a few seconds, in the colour of how it ended, then the slot is free again.
  const [leaving, setLeaving] = createSignal<ReadonlyArray<{ runner: string; run: Leaving["run"] }>>([]);
  let before: ReadonlyMap<string, { runner: string; run: Leaving["run"] }> | undefined;
  createEffect(on(runs, (list) => {
    const current = new Map(list.map((entry) => [entry.run.attemptId, entry]));
    if (before && visible()) {
      for (const [id, entry] of before) {
        if (current.has(id)) continue;
        setLeaving((all) => [...all.filter((other) => other.run.attemptId !== id), entry]);
        setTimeout(() => setLeaving((all) => all.filter((other) => other.run.attemptId !== id)), LEAVE_MS);
      }
    }
    before = current;
  }));
  const ending = (taskId: string): Ending => { const state = placed().find((entry) => entry.task.id === taskId)?.task.state; return state ?? "done"; };
  const leavers = createMemo((): readonly Leaving[] => leaving().map((entry) => ({ ...entry, state: ending(entry.run.taskId) })));

  // A goal that finishes while the page is open rings once.
  const [celebrating, setCelebrating] = createSignal<ReadonlyArray<{ id: string; title: string }>>([]);
  let states: Map<string, string> | undefined;
  createEffect(on(placed, (list) => {
    if (tasks.data() === undefined) return;
    for (const id of newlyDone(states, list)) {
      const title = list.find((entry) => entry.task.id === id)?.task.title ?? "";
      setCelebrating((all) => [...all.filter((entry) => entry.id !== id), { id, title }]);
      setTimeout(() => setCelebrating((all) => all.filter((entry) => entry.id !== id)), CELEBRATE_MS);
    }
    states = goalStates(list);
  }));

  // Ambient: the same page filling the screen for a wall display; Escape or the button leaves.
  const [ambient, setAmbient] = createSignal(false);
  const [idle, setIdle] = createSignal(false);
  let wake: { release: () => Promise<void> } | undefined;
  let hush: ReturnType<typeof setTimeout> | undefined;
  const wakeIdle = (): void => { setIdle(false); clearTimeout(hush); hush = setTimeout(() => setIdle(true), 4000); };
  const enter = (): void => {
    setAmbient(true);
    wakeIdle();
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    void (navigator as unknown as { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen").then((lock) => { wake = lock; }).catch(() => undefined);
  };
  const leave = (): void => {
    setAmbient(false);
    clearTimeout(hush);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    void wake?.release().catch(() => undefined);
    wake = undefined;
  };
  const key = (event: KeyboardEvent): void => { if (event.key === "Escape" && ambient()) leave(); };
  document.addEventListener("keydown", key);
  const fullscreen = (): void => { if (!document.fullscreenElement && ambient()) leave(); };
  document.addEventListener("fullscreenchange", fullscreen);
  onCleanup(() => { document.removeEventListener("keydown", key); document.removeEventListener("fullscreenchange", fullscreen); clearTimeout(hush); void wake?.release().catch(() => undefined); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); });

  const crumbs = (): Array<{ label: string; route?: string }> => (place() ? [{ label: place()?.name ?? "", route: `/w/${params.slug}` }, { label: t("nav.live") }] : [{ label: t("nav.overview"), route: "/" }, { label: t("nav.live") }]);
  const spent = (): number => (overview()?.workspaces ?? []).reduce((sum, workspace) => sum + workspace.spend.todayMicroUsd, 0);
  const cap = (): number => ((overview()?.workspaces ?? []).some((workspace) => workspace.spend.capMicroUsd === 0) ? 0 : (overview()?.workspaces ?? []).reduce((sum, workspace) => sum + workspace.spend.capMicroUsd, 0));
  const days = (): number[] => (overview()?.workspaces[0]?.days ?? []).map((_, index) => (overview()?.workspaces ?? []).reduce((sum, workspace) => sum + (workspace.days[index]?.microUsd ?? 0), 0) / 1_000_000);
  const inFlight = (): number => runs().reduce((sum, entry) => sum + entry.run.tokens, 0);
  const needs = (): NonNullable<ReturnType<typeof overview>>["needsYou"] => overview()?.needsYou ?? [];
  const ready = (): boolean => queue.data() !== undefined && overview() !== undefined;

  return (
    <>
      <Head title={t("live.title")} text={t("live.title")} description={t("live.text")} breadcrumbs={crumbs()}
        actions={<Button variant="outline" size="md" iconLeft="lucide-maximize" onClick={enter}>{t("live.ambient")}</Button>} />
      <Failure error={queue.error()} retry={queue.refetch} />
      <Show when={ready()} fallback={<Show when={!queue.error()}><Loading shape="cards" /></Show>}>
        <div class={`live-root flex flex-col gap-4 ${ambient() ? "fixed inset-0 z-50 overflow-auto bg-paper p-6 lg:p-10" : ""} ${ambient() && idle() ? "cursor-none" : ""}`} data-ambient={ambient() || undefined} data-hidden={!visible() || undefined} data-still={reduced() || undefined}
          onPointerMove={() => { if (ambient()) wakeIdle(); }}>
          <Show when={ambient()}>
            <div class="flex items-center gap-4">
              <h2 class="font-display text-2xl font-semibold text-ink">{t("live.title")}{place() ? ` · ${place()?.name}` : ""}</h2>
              <span class="ms-auto t-title text-ink-2 tabular-nums" dir="ltr"><Tick now={now()} /></span>
              <Button variant="outline" size="md" iconLeft="lucide-minimize" onClick={leave} class={idle() ? "opacity-0 focus-visible:opacity-100" : ""}>{t("live.ambient.exit")}</Button>
            </div>
          </Show>
          <For each={celebrating()}>{(goal) => <Celebration title={goal.title} />}</For>
          <Show when={needs().length > 0}>
            <section class="live-attn-bar flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-[var(--needs-line)] bg-needs-soft px-4 py-3" aria-label={t("live.need.title", { n: needs().length })} data-testid="live-attention">
              <span class="live-dot size-2.5 rounded-full bg-needs" aria-hidden="true" />
              <p class="t-text font-medium text-ink">{t("live.need.title", { n: needs().length })}</p>
              <ul class="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1 t-small">
                <For each={needs().slice(0, 3)}>{(need) => <li class="min-w-0 max-w-full"><A href={`/w/${need.workspaceSlug}/tasks/${need.rootId}?link=${need.id}`} class="block max-w-[22rem] truncate text-needs-text hover:underline" dir="auto">{need.goalTitle}</A></li>}</For>
              </ul>
            </section>
          </Show>
          <River counts={counts()} activity={activity()} ambient={ambient()} />
          <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div class="flex min-w-0 flex-col gap-6">
            <section class="flex min-w-0 flex-col gap-3" aria-labelledby="live-runners">
              <h2 id="live-runners" class="t-head text-ink">{t("live.lanes.title")}</h2>
              <Show when={(queue.data()?.runners ?? []).length > 0} fallback={<EmptyState icon="lucide-server-off" size="md" title={t("queue.runner.none")} />}>
                <ul class="flex flex-col gap-3">
                  <For each={queue.data()?.runners}>{(runner) => <Lane runner={runner} samples={samples()} leaving={leavers()} now={now()} ambient={ambient()} />}</For>
                </ul>
              </Show>
            </section>
              <Show when={(overview()?.workspaces ?? []).length > 0}>
                <section class="flex flex-col gap-3" aria-labelledby="live-tiles">
                  <h2 id="live-tiles" class="t-head text-ink">{t("live.tiles.title")}</h2>
                  <ul class="grid items-start gap-3 sm:grid-cols-2">
                    <For each={overview()?.workspaces}>{(workspace) => <Tile workspace={workspace} />}</For>
                  </ul>
                </section>
              </Show>
            </div>
            <div class="flex min-w-0 flex-col gap-4">
              <Ticker spent={spent()} cap={cap()} days={days()} tokens={inFlight()} />
              <section class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 px-4 py-3" aria-labelledby="live-feed">
                <h2 id="live-feed" class="mb-1 t-head text-ink">{t("live.feed.title")}</h2>
                <Feed groups={groups()} now={slow()} shared={params.slug === undefined} />
              </section>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
