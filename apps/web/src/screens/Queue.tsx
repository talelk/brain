import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";
import { A, useParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { EmptyState } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import type { Priority, Queue, QueueItem, QueueRun, QueueRunner } from "@brain/contracts";
import { PRIORITIES } from "@brain/contracts/limits";
import { command, query, useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { t, tn } from "../i18n";
import { useNow } from "../lib/clock";
import { dateTime, duration, money } from "../lib/format";
import { brainOf, brainToml, paths } from "../lib/files";
import { waitText } from "../lib/queue";
import { Head } from "../components/Shell";
import { ConfirmButton, Failure, Icon, Keyed, Ready } from "../components/bits";

const reduced = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Moves a list's rows smoothly when their order changes: each row is measured, and one that moved slides from where it was. Nothing moves for a person who asked for less motion. */
function flip(list: () => HTMLElement | undefined, order: () => readonly string[]): void {
  let last = new Map<string, number>();
  createEffect(on(order, () => {
    const box = list();
    if (!box) return;
    queueMicrotask(() => {
      const next = new Map<string, number>();
      for (const row of box.querySelectorAll<HTMLElement>("[data-flip]")) {
        const key = row.dataset["flip"] as string;
        const top = row.offsetTop;
        next.set(key, top);
        const before = last.get(key);
        if (before !== undefined && before !== top && !reduced()) row.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], { duration: 220, easing: "ease-out" });
      }
      last = next;
    });
  }));
}

function Slot(props: { run?: QueueRun; hidden?: boolean }): JSX.Element {
  const now = useNow(1000);
  return (
    <li class={`flex min-h-14 flex-col justify-center rounded-control border px-3 py-2 ${props.run ? "border-outline-gray-2 bg-surface-elevation-1" : "border-dashed border-outline-gray-2 bg-surface-gray-1"}`}>
      <Show when={props.run} fallback={<span class="t-small text-ink-3">{props.hidden ? t("queue.slot.hidden") : t("queue.slot.free")}</span>}>
        {(run) => (<>
          <A href={`/w/${run().workspaceSlug}/tasks/${run().rootId}?link=${run().taskId}`} class="truncate t-small font-medium text-ink hover:underline" dir="auto">{run().goalTitle}</A>
          <span class="t-small text-ink-3">{run().title !== run().goalTitle ? <><bdi>{run().title}</bdi> · </> : ""}{run().agent} · {run().workspaceName} · {run().startedAt ? duration(now() - (run().startedAt as number)) : "…"} · {t("queue.run.tokens", { n: run().tokens.toLocaleString() })} · {money(run().microUsd)}</span>
        </>)}
      </Show>
    </li>
  );
}

function Lane(props: { runner: QueueRunner }): JSX.Element {
  const r = (): QueueRunner => props.runner;
  const shown = (): number => r().occupied.length + r().hiddenOccupied;
  const free = (): number => Math.max(0, r().slots - shown());
  return (
    <li class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4">
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class={`size-2 rounded-full ${r().online ? "bg-ok-mark" : "bg-ink-gray-4"}`} aria-hidden="true" />
        <h3 class="t-head text-ink">{r().name}</h3>
        <span class="t-small text-ink-3">{r().online ? t("queue.runner.online") : t("queue.runner.offline")} · {t("queue.runner.slots", { used: shown(), total: r().slots })}</span>
        <Show when={r().engines.length > 0}><span class="ms-auto t-small text-ink-3" dir="ltr">{r().engines.join(", ")} · {r().capabilities.join(", ")}</span></Show>
      </div>
      <ul class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <For each={r().occupied}>{(run) => <Slot run={run} />}</For>
        <For each={Array.from({ length: r().hiddenOccupied })}>{() => <Slot hidden />}</For>
        <For each={Array.from({ length: free() })}>{() => <Slot />}</For>
      </ul>
    </li>
  );
}

/** One waiting task: its place, what it is, why it is not running, and what a member may do about it. */
function Row(props: { item: QueueItem; shared: boolean }): JSX.Element {
  const now = useNow(10_000);
  const steer = useAction((change: { priority?: Priority; paused?: boolean }) => command("task.steer", { workspaceId: props.item.workspaceId, taskId: props.item.taskId, ...change }));
  const stop = useAction(() => command("task.stop", { workspaceId: props.item.workspaceId, taskId: props.item.taskId }));
  const item = (): QueueItem => props.item;
  return (
    <li class="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto]" data-flip={item().taskId} data-testid="queue-row">
      <span class="flex size-8 items-center justify-center rounded-full bg-lilac font-display t-small font-semibold text-ink tabular-nums" title={item().rank === null ? undefined : t("queue.rank", { n: item().rank as number })}>{item().rank ?? <Icon name="lucide-pause" />}</span>
      <div class="min-w-0">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <A href={`/w/${item().workspaceSlug}/tasks/${item().rootId}?link=${item().taskId}`} class="truncate t-text font-medium text-ink hover:underline" dir="auto">{item().goalTitle}</A>
          <Badge theme="gray" size="sm" label={t(`queue.kind.${item().kind}`)} />
          <Show when={item().priority !== "normal"}><Badge theme={item().priority === "high" ? "blue" : "gray"} size="sm" label={t(`queue.priority.${item().priority}`)} /></Show>
          <Show when={item().paused}><Badge theme="amber" size="sm" label={t("queue.wait.paused-task")} /></Show>
        </div>
        <p class="t-small text-ink-3"><Show when={props.shared}>{item().workspaceName} · </Show><Show when={item().title !== item().goalTitle}><bdi>{item().title}</bdi> · </Show>{item().agent ? `${item().agent} · ` : ""}{t("queue.since", { age: duration(now() - item().since) })}</p>
        <p class="mt-1 t-small text-ink-2" data-testid="queue-wait">{waitText(item().wait)}<Show when={item().startsAt}> {t("queue.starts", { time: dateTime(item().startsAt as number) })}</Show></p>
        <Failure error={steer.error() ?? stop.error()} class="mt-2" />
      </div>
      <Show when={item().canSteer}>
        <div class="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:justify-end max-sm:col-start-2">
          <label class="flex items-center gap-1.5 t-small text-ink-3">
            <span class="sr-only sm:not-sr-only">{t("queue.priority")}</span>
            <select class="rounded-control border border-outline-gray-2 bg-surface-elevation-1 px-2 py-1 t-small text-ink focus-visible:focus-ring" value={item().priority} aria-label={t("queue.priority")} onChange={(event) => void steer.run({ priority: event.currentTarget.value as Priority })}>
              <For each={PRIORITIES}>{(priority) => <option value={priority} selected={item().priority === priority}>{t(`queue.priority.${priority}`)}</option>}</For>
            </select>
          </label>
          <Show when={item().priority !== "high" && item().rank !== null}><Button variant="outline" size="sm" iconLeft="lucide-chevrons-up" loading={steer.busy()} onClick={() => void steer.run({ priority: "high" })}>{t("queue.runNext")}</Button></Show>
          <Button variant="outline" size="sm" iconLeft={item().paused ? "lucide-play" : "lucide-pause"} loading={steer.busy()} onClick={() => void steer.run({ paused: !item().paused })}>{item().paused ? t("queue.resume") : t("queue.pause")}</Button>
          <ConfirmButton label={t("queue.stop")} confirm={t("queue.stop.confirm")} busy={stop.busy()} icon="lucide-square" onConfirm={() => void stop.run()} />
        </div>
      </Show>
    </li>
  );
}

function Paused(props: { queue: Queue; admin: boolean }): JSX.Element {
  const session = useSession();
  const resume = useAction(async (id: string) => {
    const brain = brainOf((await query("workspace.get", { workspaceId: id })).snapshot);
    await command("file.write", { workspaceId: id, files: [{ path: paths.brain, content: brainToml({ ...brain, limits: { ...brain.limits, paused: false } }) }], message: "Resume the queue" });
  });
  return (
    <For each={props.queue.paused}>
      {(workspace) => (
        <div class="flex flex-wrap items-center gap-3 rounded-card border border-amber-border bg-amber-soft px-4 py-3" role="status">
          <Icon name="lucide-pause-circle" class="size-5 text-amber-text" />
          <p class="min-w-0 flex-1 t-text text-ink">{t("queue.paused", { name: workspace.name })}</p>
          <Show when={props.admin && session.workspaces().find((entry) => entry.id === workspace.id)?.role === "admin"}><Button variant="solid" theme="blue" size="md" iconLeft="lucide-play" loading={resume.busy()} onClick={() => void resume.run(workspace.id)}>{t("queue.resumeWorkspace")}</Button></Show>
        </div>
      )}
    </For>
  );
}

/** The queue: runners as lanes with their slots, then what waits in the order it will start and why it is not running yet. */
export default function QueueScreen(): JSX.Element {
  const session = useSession();
  const params = useParams<{ slug?: string }>();
  const place = createMemo(() => session.workspaces().find((workspace) => workspace.slug === params.slug));
  const queue = useQuery("queue", () => (params.slug === undefined ? {} : place() ? { workspaceId: (place() as { id: string }).id } : undefined));
  const [list, setList] = createSignal<HTMLElement>();
  flip(list, () => queue.data()?.waiting.map((item) => item.taskId) ?? []);
  const pause = useAction(async () => {
    const found = place();
    if (!found) return;
    const brain = brainOf((await query("workspace.get", { workspaceId: found.id })).snapshot);
    await command("file.write", { workspaceId: found.id, files: [{ path: paths.brain, content: brainToml({ ...brain, limits: { ...brain.limits, paused: true } }) }], message: "Pause the queue" });
  });
  const crumbs = (): Array<{ label: string; route?: string }> => (place() ? [{ label: place()?.name ?? "", route: `/w/${params.slug}` }, { label: t("nav.queue") }] : [{ label: t("nav.overview"), route: "/" }, { label: t("nav.queue") }]);
  return (
    <>
      <Head title={t("queue.title")} text={t("queue.title")} description={t("queue.text")} breadcrumbs={crumbs()}
        actions={<Show when={place()?.role === "admin" && !queue.data()?.paused.some((workspace) => workspace.id === place()?.id)}><Button variant="outline" size="md" iconLeft="lucide-pause" loading={pause.busy()} onClick={() => void pause.run()}>{t("queue.pauseWorkspace")}</Button></Show>} />
      <Ready shape="cards" data={queue.data()} error={queue.error()} retry={queue.refetch}>
        {(data) => (
          <div class="flex flex-col gap-6">
            <Failure error={pause.error()} />
            <Paused queue={data()} admin />
            <Section title={t("queue.runners")} headingLevel={2}>
              <Show when={data().runners.length > 0} fallback={<EmptyState icon="lucide-server-off" title={t("queue.runner.none")} />}>
                <ul class="flex flex-col gap-3"><Keyed each={data().runners} by={(runner) => runner.id}>{(runner) => <Lane runner={runner()} />}</Keyed></ul>
              </Show>
              <Show when={data().admin}><p class="mt-3 t-small text-ink-3">{t("queue.runner.how")}</p></Show>
            </Section>
            <Section title={t("queue.waiting")} headingLevel={2}>
              <Show when={data().waiting.length > 0} fallback={<EmptyState icon="lucide-check-check" title={t("queue.waiting.none")} description={t("queue.waiting.none.text")} />}>
                <ol ref={setList} class="relative divide-y divide-outline-gray-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1" aria-label={t("queue.waiting")}>
                  <Keyed each={data().waiting} by={(item) => item.taskId}>{(item) => <Row item={item()} shared={place() === undefined} />}</Keyed>
                </ol>
              </Show>
              <Show when={data().hidden > 0}><p class="mt-3 t-small text-ink-3">{tn("queue.hidden", data().hidden)}</p></Show>
            </Section>
            <Show when={data().blocked.length > 0}>
              <Section title={t("queue.blocked")} headingLevel={2}>
                <ul class="divide-y divide-outline-gray-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1">
                  <Keyed each={data().blocked} by={(item) => item.taskId}>{(item) => <li class="px-4 py-3"><A href={`/w/${item().workspaceSlug}/tasks/${item().rootId}?link=${item().taskId}`} class="t-text font-medium text-ink hover:underline" dir="auto">{item().goalTitle}</A><p class="t-small text-ink-3">{place() === undefined ? `${item().workspaceName} · ` : ""}<bdi>{item().title}</bdi> · {waitText(item().wait)}</p></li>}</Keyed>
                </ul>
              </Section>
            </Show>
          </div>
        )}
      </Ready>
    </>
  );
}
