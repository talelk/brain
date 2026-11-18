import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { EmptyState } from "@talelk/newui-molecules";
import { FilterBar, type DataTableColumn } from "@talelk/newui-organisms";
import type { TaskState, TaskSummary } from "@brain/contracts";
import { command, query, useAction, useLive } from "../data/api";
import { usePlace } from "../data/session";
import { t, tn } from "../i18n";
import { ago, money, shownState } from "../lib/format";
import { TASK_STATES } from "../lib/model";
import { Head } from "../components/Shell";
import { Failure, needText, Ready, StateWord } from "../components/bits";
import { Table } from "../components/Table";

const PAGE = 50;
const OPEN: readonly TaskState[] = ["waiting", "ready", "running", "needs_you"];

/** Every goal of the workspace: filter by state, search by title, sort, open one, stop several at once. */
export default function TasksScreen(): JSX.Element {
  const place = usePlace();
  const [state, setState] = createSignal<TaskState>();
  const [search, setSearch] = createSignal("");
  const [limit, setLimit] = createSignal(PAGE);
  /** The words searched for, once the person has stopped typing. */
  const [words, setWords] = createSignal("");
  createEffect(() => { const typed = search().trim(); const timer = setTimeout(() => { setWords(typed); setLimit(PAGE); }, 250); onCleanup(() => clearTimeout(timer)); });
  /** Goals only: a sub-task is reached through its goal. */
  const list = useLive(() => `${place.id()}:${state() ?? "all"}:${words()}:${limit()}`, () => query("tasks.list", { workspaceId: place.id(), rootsOnly: true, ...(state() ? { state: state() } : {}), ...(words() !== "" ? { search: words() } : {}), limit: limit() }));
  // While another page or search is on its way the last result stays, so the search box keeps its focus and the list its place.
  const kept = createMemo<ReturnType<typeof list.data>>((last) => list.data() ?? last, undefined);
  const stop = useAction(async (ids: string[]) => { for (const taskId of ids) await command("task.stop", { workspaceId: place.id(), taskId }); });
  const columns: DataTableColumn<TaskSummary>[] = [
    { id: "state", header: t("tasks.col.state"), accessorFn: (task) => shownState(task), meta: { mobile: "status" }, cell: (ctx) => <StateWord state={shownState(ctx.row.original)} /> },
    { accessorKey: "title", header: t("tasks.col.goal"), meta: { mobile: "title" }, cell: (ctx) => (
      <span class="flex min-w-0 flex-col">
        <A href={place.to(`/tasks/${ctx.row.original.id}`)} class="truncate font-medium text-ink-gray-9 hover:underline" dir="auto">{ctx.row.original.title}</A>
        <Show when={ctx.row.original.needs}>{(need) => <span class="truncate text-needs-text">{needText(need())}</span>}</Show>
        <Show when={ctx.row.original.supersededBy}><span class="truncate text-ink-gray-7">{t("tasks.superseded")}</span></Show>
      </span>
    ) },
    { accessorKey: "createdByName", header: t("tasks.col.by"), meta: { mobile: "meta" }, cell: (ctx) => <span class="text-ink-gray-7">{ctx.row.original.createdByName ?? ctx.row.original.play ?? "—"}</span> },
    { accessorKey: "createdAt", header: t("tasks.col.started"), meta: { mobile: "subtitle" }, cell: (ctx) => <span class="whitespace-nowrap text-ink-gray-7">{ago(ctx.row.original.createdAt)}</span> },
    { accessorKey: "microUsd", header: t("tasks.col.cost"), meta: { align: "end", mobile: "amount" }, cell: (ctx) => <span class="tabular-nums">{money(ctx.row.original.microUsd)}</span> },
  ];
  const filtered = (): boolean => state() !== undefined || words() !== "";
  return (
    <>
      <Head title={t("nav.tasks")} text={t("nav.tasks")} description={t("tasks.text")} breadcrumbs={[{ label: place.summary().name, route: place.to() }, { label: t("nav.tasks") }]}
        actions={<Button variant="solid" theme="blue" size="md" iconLeft="lucide-plus" route={`${place.to()}?new=1`}>{t("tasks.new")}</Button>} />
      <Ready shape="table" data={kept()} error={list.error()} retry={list.refetch}>
        {(loaded) => (
          <div class="flex flex-col gap-3">
            <Failure error={stop.error()} />
            <FilterBar surface="bare" query={{ value: search(), placeholder: t("tasks.search"), onInput: setSearch, width: "20rem" }}
              selects={[{ label: t("tasks.filter"), width: "11rem", value: state() ?? "", options: [{ label: t("tasks.filter.all"), value: "" }, ...TASK_STATES.map((value) => ({ label: t(`state.${value}`), value }))], onValueChange: (value) => { setState((value || undefined) as TaskState | undefined); setLimit(PAGE); } }]}
              chips={state() ? [{ label: `${t("tasks.filter")}: ${t(`state.${state() as TaskState}`)}`, onRemove: () => setState(undefined) }] : []}
              onClearAll={() => { setState(undefined); setSearch(""); }} />
            <Table title={t("nav.tasks")} rows={[...loaded().tasks]} columns={columns} count={tn("table.goals", loaded().tasks.length)} {...(place.can("member") ? { bulk: { label: t("tasks.stop.selected"), summary: (count: number) => tn("table.selected", count), eligible: (task: TaskSummary) => OPEN.includes(task.state), run: (ids: string[]) => void stop.run(ids) } } : {})} emptyTitle={filtered() ? t("tasks.none.match") : t("tasks.none")} emptyHint={filtered() ? t("tasks.none.match.text") : t("tasks.none.text")} onClearFilters={() => { setState(undefined); setSearch(""); }} />
            <Show when={loaded().tasks.length >= limit()}><div class="text-center"><Button variant="outline" size="md" onClick={() => setLimit(limit() + PAGE)}>{t("tasks.more")}</Button></div></Show>
            <Show when={!filtered() && loaded().tasks.length === 0}><EmptyState icon="lucide-list-checks" title={t("tasks.none")} description={t("tasks.none.text")} action={<Button variant="solid" theme="blue" size="md" route={`${place.to()}?new=1`}>{t("tasks.new")}</Button>} /></Show>
          </div>
        )}
      </Ready>
    </>
  );
}
