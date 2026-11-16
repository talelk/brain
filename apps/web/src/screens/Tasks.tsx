import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Button, TextInput } from "@talelk/newui-atoms";
import type { TaskState, TaskSummary } from "@brain/contracts";
import { query, useLive } from "../data/api";
import { usePlace } from "../data/session";
import { t } from "../i18n";
import { TASK_STATES } from "../lib/model";
import { Empty, Keyed, PageHead, Ready, TaskRow } from "../components/bits";

const PAGE = 50;

/** Every goal of the workspace: filter by state, search by title, open one. */
export default function TasksScreen(): JSX.Element {
  const place = usePlace();
  const [state, setState] = createSignal<TaskState>();
  const [search, setSearch] = createSignal("");
  const [limit, setLimit] = createSignal(PAGE);
  const list = useLive(() => `${place.id()}:${state() ?? "all"}:${limit()}`, () => query("tasks.list", { workspaceId: place.id(), ...(state() ? { state: state() } : {}), limit: limit() }));
  /** Goals only: a sub-task is reached through its goal. */
  const goals = createMemo((): TaskSummary[] => (list.data()?.tasks ?? []).filter((task) => task.parentId === null));
  const shown = createMemo((): TaskSummary[] => { const words = search().trim().toLowerCase(); return words === "" ? goals() : goals().filter((task) => task.title.toLowerCase().includes(words)); });
  const filter = (value: TaskState | undefined, label: string): JSX.Element => (
    <button type="button" aria-pressed={state() === value} class="whitespace-nowrap rounded-full border border-rule-2 px-3.5 py-1.5 t-small font-medium text-ink-2 hover:border-ink-3 hover:text-ink aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper" onClick={() => { setState(value); setLimit(PAGE); }}>{label}</button>
  );
  return (
    <div class="mx-auto max-w-[60rem]">
      <PageHead title={t("nav.tasks")} text={t("tasks.text")} actions={<Button variant="solid" theme="blue" size="md" route={`${place.to()}?new=1`}>{t("tasks.new")}</Button>} />
      <div class="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div class="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-1" role="group" aria-label={t("tasks.filter")}>
          {filter(undefined, t("tasks.filter.all"))}
          <For each={TASK_STATES}>{(value) => filter(value, t(`state.${value}`))}</For>
        </div>
        <div class="w-full lg:w-64"><TextInput size="md" type="search" aria-label={t("tasks.search")} placeholder={t("tasks.search")} value={search()} onInput={(event) => setSearch(event.currentTarget.value)} /></div>
      </div>
      <Ready data={list.data()} error={list.error()} retry={list.refetch}>
        {(loaded) => (
          <Show when={shown().length > 0} fallback={
            <Show when={goals().length === 0 && state() === undefined} fallback={<Empty title={t("tasks.none.match")} text={t("tasks.none.match.text")} />}>
              <Empty title={t("tasks.none")} text={t("tasks.none.text")}><Button variant="solid" theme="blue" size="md" route={`${place.to()}?new=1`}>{t("tasks.new")}</Button></Empty>
            </Show>
          }>
            <ul class="-mx-3">
              <Keyed each={shown()} by={(task) => task.id}>{(task) => <li class="border-b border-rule last:border-b-0"><TaskRow task={task()} href={place.to(`/tasks/${task().id}`)} by={task().createdByName ?? task().agent ?? undefined} /></li>}</Keyed>
            </ul>
            <Show when={loaded().tasks.length >= limit()}><div class="mt-5 text-center"><Button variant="outline" size="md" onClick={() => setLimit(limit() + PAGE)}>{t("tasks.more")}</Button></div></Show>
          </Show>
        )}
      </Ready>
    </div>
  );
}
