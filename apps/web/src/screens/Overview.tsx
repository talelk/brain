import { createMemo, createSignal, For, lazy, Show, Suspense, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Badge, Button, Progress } from "@talelk/newui-atoms";
import { EmptyState, ItemListRow } from "@talelk/newui-molecules";
import { Section, StatGrid, type DataTableColumn } from "@talelk/newui-organisms";
import { Sparkline } from "@talelk/newui-charts";
import type { Overview, OverviewHealth, OverviewRun, OverviewWorkspace } from "@brain/contracts";
import { useSession } from "../data/session";
import { t, tn } from "../i18n";
import { roleAtLeast } from "../lib/model";
import { ago, duration, money } from "../lib/format";
import { useNow } from "../lib/clock";
import { PlatformBadge, VisibilityBadge } from "../components/Share";
import { Head } from "../components/Shell";
import { Icon, Loading, NeedsCount, Ready } from "../components/bits";
import { Table } from "../components/Table";
import { NeedsList, type NeedsItem } from "../components/Needs";
import { said } from "../lib/said";

const ROWS = 8;
const RUNS = 6;
/** A series that never moved draws nothing instead of a solid block. */
const flat = (values: number[]): number[] => (values.every((value) => value === 0) ? [] : values);
/** A sparkline whose hidden English summary is replaced by one in the interface's language. */
function Spark(props: { type: "bar" | "area"; data: number[]; show?: (value: number) => string }): JSX.Element {
  const show = (value: number): string => (props.show ? props.show(value) : String(value));
  return (
    <div class="w-24">
      <div aria-hidden="true"><Sparkline type={props.type} data={props.data} height="1.5rem" /></div>
      <span class="sr-only">{props.data.length === 0 ? t("overview.spark.none") : t("overview.spark", { n: props.data.length, min: show(Math.min(...props.data)), max: show(Math.max(...props.data)), last: show(props.data.at(-1) ?? 0) })}</span>
    </div>
  );
}
const Charts = lazy(() => import("../components/Charts"));

const sum = (list: readonly OverviewWorkspace[], pick: (workspace: OverviewWorkspace) => number): number => list.reduce((total, workspace) => total + pick(workspace), 0);

/** One workspace as a row: what it is doing now, what it did today, and its last week as small bars. */
function WorkspacesTable(props: { workspaces: readonly OverviewWorkspace[] }): JSX.Element {
  const week = (workspace: OverviewWorkspace, pick: (day: OverviewWorkspace["days"][number]) => number): number[] => workspace.days.slice(-7).map(pick);
  const columns: DataTableColumn<OverviewWorkspace>[] = [
    { accessorKey: "name", header: t("overview.col.workspace"), meta: { mobile: "title" }, cell: (ctx) => <span class="flex flex-wrap items-center gap-2"><A href={`/w/${ctx.row.original.slug}`} class="font-medium text-ink-gray-9 hover:underline">{ctx.row.original.name}</A><VisibilityBadge visibility={ctx.row.original.visibility} /><Show when={ctx.row.original.platform}><PlatformBadge /></Show><Show when={ctx.row.original.updates > 0}><Badge theme="amber" size="md" label={t("packs.update.badge")} /></Show></span> },
    { id: "projects", header: t("overview.col.projects"), accessorFn: (workspace) => workspace.projects.join(", "), meta: { mobile: "meta" }, cell: (ctx) => <span class="block max-w-48 truncate text-ink-gray-7" title={ctx.row.original.projects.join(", ")}>{ctx.row.original.projects.length > 0 ? ctx.row.original.projects.join(", ") : "—"}</span> },
    { accessorKey: "running", header: t("overview.col.running"), meta: { align: "end" }, cell: (ctx) => <span class="tabular-nums">{ctx.row.original.running}</span> },
    { accessorKey: "needsYou", header: t("overview.col.needs"), meta: { align: "end", mobile: "status" }, cell: (ctx) => (ctx.row.original.needsYou > 0 ? <NeedsCount n={ctx.row.original.needsYou} /> : <span class="text-ink-gray-7">0</span>) },
    { accessorKey: "doneToday", header: t("overview.col.done"), meta: { align: "end" }, cell: (ctx) => <span class="tabular-nums">{ctx.row.original.doneToday}</span> },
    { id: "spend", header: t("overview.col.spend"), accessorFn: (workspace) => workspace.spend.todayMicroUsd, meta: { align: "end", mobile: "amount" }, cell: (ctx) => {
      const spend = ctx.row.original.spend;
      return (
        <span class="inline-flex min-w-28 flex-col items-end gap-1 tabular-nums">
          <span>{money(spend.todayMicroUsd)}<span class="text-ink-gray-7"> / {spend.capMicroUsd > 0 ? money(spend.capMicroUsd) : t("overview.spend.nocap")}</span></span>
          <Show when={spend.capMicroUsd > 0}><Progress size="sm" value={Math.min(100, (spend.todayMicroUsd / spend.capMicroUsd) * 100)} class="w-24" aria-label={t("overview.spend.meter", { name: ctx.row.original.name })} /></Show>
        </span>
      );
    } },
    { id: "goals7", header: t("overview.col.goals7"), enableSorting: false, cell: (ctx) => <Spark type="bar" data={flat(week(ctx.row.original, (day) => day.done))} /> },
    { id: "spend7", header: t("overview.col.spend7"), enableSorting: false, cell: (ctx) => <Spark type="area" data={flat(week(ctx.row.original, (day) => day.microUsd))} show={money} /> },
    { accessorKey: "lastActivityAt", header: t("overview.col.last"), cell: (ctx) => <span class="whitespace-nowrap text-ink-gray-7">{ctx.row.original.lastActivityAt ? ago(ctx.row.original.lastActivityAt) : "—"}</span> },
  ];
  return <Table title={t("overview.workspaces")} rows={[...props.workspaces]} columns={columns} count={tn("table.workspaces", props.workspaces.length)} />;
}

/** Attempts running now, across the workspaces. */
function Running(props: { runs: readonly OverviewRun[]; workspaces: readonly OverviewWorkspace[] }): JSX.Element {
  const now = useNow();
  return (
    <Show when={props.runs.length > 0} fallback={
      <EmptyState size="sm" icon="lucide-moon" title={t("overview.running.none")} description={t("overview.running.none.text")}
        action={props.workspaces[0] && roleAtLeast(props.workspaces[0].role, "member") ? <Button variant="outline" size="md" route={`/w/${props.workspaces[0].slug}?new=1`}>{t("overview.start", { name: props.workspaces[0].name })}</Button> : undefined} />
    }>
      <ul class="flex flex-col divide-y divide-outline-gray-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1">
        <For each={props.runs.slice(0, RUNS)}>
          {(run) => (
            <li>
              <ItemListRow as="a" href={`/w/${run.workspaceSlug}/tasks/${run.rootId}?link=${run.taskId}`} size="lg" class="gap-3 py-2.5"
                prefix={<Icon name="lucide-loader-circle" class="size-4 animate-spin text-violet-text motion-reduce:animate-none" />}
                suffix={<span class="flex flex-col items-end t-small tabular-nums text-ink-3"><span>{run.startedAt ? duration(now() - run.startedAt) : "—"}</span><span>{money(run.microUsd)}</span></span>}>
                <span class="block truncate t-text font-medium text-ink" dir="auto">{run.goalTitle}</span>
                <span class="block truncate t-small text-ink-3">{run.workspaceName} · <span class="text-ink-2">{run.agent}</span> · {t(`attempt.kind.${run.kind}`)}<Show when={run.stepId}> · {run.title}</Show></span>
              </ItemListRow>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.runs.length > RUNS}><p class="mt-2 t-small text-ink-3">{t("overview.running.more", { n: props.runs.length - RUNS })}</p></Show>
    </Show>
  );
}

/** Runners, models and the record of this Brain as a whole; only an instance admin sees it. */
function HealthStrip(props: { health: OverviewHealth }): JSX.Element {
  const cell = (ok: boolean | null, label: string, value: string, hint: string): JSX.Element => (
    <div class="flex items-start gap-2.5 bg-surface-elevation-1 px-4 py-3">
      <Icon name={ok === null ? "lucide-circle-dashed" : ok ? "lucide-circle-check" : "lucide-circle-x"} class={`mt-0.5 size-4 ${ok === null ? "text-ink-gray-5" : ok ? "text-ok" : "text-bad"}`} />
      <div class="min-w-0"><p class="text-sm text-ink-gray-7">{label}</p><p class="text-lg-medium tabular-nums text-ink-gray-9">{value}</p><p class="text-xs text-ink-gray-6">{hint}</p></div>
    </div>
  );
  const h = (): OverviewHealth => props.health;
  return (
    <div class="grid gap-px overflow-hidden rounded-card border border-outline-gray-1 bg-outline-gray-1 sm:grid-cols-3 lg:grid-cols-1" role="group" aria-label={t("overview.health")}>
      {cell(h().runnersTotal === 0 ? false : h().runnersOnline > 0, t("overview.health.runners"), `${h().runnersOnline} / ${h().runnersTotal}`, t("overview.health.runners.hint"))}
      {cell(h().modelsTotal === 0 ? null : h().modelsReachable === h().modelsTotal, t("overview.health.models"), h().modelsTotal === 0 ? "—" : `${h().modelsReachable} / ${h().modelsTotal}`, t("overview.health.models.hint"))}
      {cell(h().auditProblem === null, t("overview.health.audit"), h().auditProblem === null ? t("health.audit.ok") : t("health.audit.problem"), said(h().auditProblem ?? t("overview.health.audit.hint")))}
    </div>
  );
}

function Content(props: { overview: Overview }): JSX.Element {
  const o = (): Overview => props.overview;
  const needs = createMemo((): NeedsItem[] => o().needsYou.map((need) => ({
    task: need, approval: need.approval, workspaceId: need.workspaceId, slug: need.workspaceSlug, workspaceName: need.workspaceName,
    role: o().workspaces.find((workspace) => workspace.id === need.workspaceId)?.role ?? "viewer",
  })));
  const [all, setAll] = createSignal(false);
  const shown = (): NeedsItem[] => (all() ? needs() : needs().slice(0, ROWS));
  const waiting = (): number => sum(o().workspaces, (workspace) => workspace.needsYou);
  const running = (): number => sum(o().workspaces, (workspace) => workspace.running);
  const spent = (): number => sum(o().workspaces, (workspace) => workspace.spend.todayMicroUsd);
  const caps = (): number => (o().workspaces.some((workspace) => workspace.spend.capMicroUsd === 0) ? 0 : sum(o().workspaces, (workspace) => workspace.spend.capMicroUsd));
  const failed = (): number => sum(o().workspaces, (workspace) => workspace.failedToday);
  const stats = () => [
    { label: t("overview.stat.needs"), icon: "lucide-circle-alert", value: <span class={waiting() > 0 ? "text-needs-text" : ""}>{waiting()}</span>, hint: waiting() > 0 ? tn("overview.stat.needs.hint", o().workspaces.filter((workspace) => workspace.needsYou > 0).length) : t("overview.stat.needs.none") },
    { label: t("overview.stat.running"), icon: "lucide-loader-circle", value: running(), hint: tn("overview.stat.running.hint", o().running.length) },
    { label: t("overview.stat.done"), icon: "lucide-circle-check", value: sum(o().workspaces, (workspace) => workspace.doneToday), hint: failed() > 0 ? tn("overview.stat.done.failed", failed()) : t("overview.stat.done.hint") },
    { label: t("overview.stat.spend"), icon: "lucide-wallet", value: money(spent()), hint: caps() > 0 ? t("overview.stat.spend.caps", { caps: money(caps()) }) : t("overview.stat.spend.nocap") },
    o().health
      ? { label: t("overview.stat.runners"), icon: "lucide-server", value: `${o().health?.runnersOnline ?? 0} / ${o().health?.runnersTotal ?? 0}`, hint: t("overview.stat.runners.hint") }
      : { label: t("overview.stat.workspaces"), icon: "lucide-folder-git-2", value: o().workspaces.length, hint: t("overview.stat.workspaces.hint") },
  ];
  return (
    <div class="flex flex-col gap-6">
      <A href="/queue" class="inline-flex w-fit items-center gap-2 rounded-full border border-outline-gray-2 bg-surface-elevation-1 px-3 py-1.5 t-small text-ink hover:bg-surface-gray-2 focus-visible:focus-ring" aria-label={t("queue.chip.open")} data-testid="queue-chip">
        <Icon name="lucide-list-ordered" />{t("queue.chip", { running: sum(o().workspaces, (workspace) => workspace.attemptsRunning), waiting: sum(o().workspaces, (workspace) => workspace.attemptsWaiting) })}
      </A>
      <StatGrid stats={stats()} columns={4} class="md:grid-cols-5 lg:grid-cols-5 min-[360px]:max-md:[&>*:last-child]:col-span-2" />
      <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section title={t("today.needs")} description={waiting() > 0 ? tn("overview.needs.text", waiting()) : undefined} headingLevel={2}>
          <Show when={needs().length > 0} fallback={<EmptyState size="sm" icon="lucide-circle-check" title={t("overview.needs.none")} description={t("overview.needs.none.text")} bordered />}>
            <NeedsList items={shown()} showWorkspace />
            <Show when={needs().length > ROWS}><Button variant="ghost" size="md" class="mt-2" onClick={() => setAll(!all())}>{all() ? t("overview.needs.fewer") : t("overview.needs.all", { n: needs().length })}</Button></Show>
            <Show when={all() && waiting() > needs().length}><p class="mt-2 t-small text-ink-3">{t("overview.needs.more", { shown: needs().length, total: waiting() })}</p></Show>
          </Show>
        </Section>
        <Section title={t("overview.running")} description={t("overview.running.text")} headingLevel={2}><Running runs={o().running} workspaces={o().workspaces} /></Section>
      </div>
      <For each={[
        { title: t("nav.workspaces.mine"), list: o().workspaces.filter((workspace) => !workspace.viaPublic && workspace.role === "admin") },
        { title: t("nav.workspaces.shared"), list: o().workspaces.filter((workspace) => !workspace.viaPublic && workspace.role !== "admin") },
        { title: t("nav.workspaces.public"), list: o().workspaces.filter((workspace) => workspace.viaPublic) },
      ].filter((group) => group.list.length > 0)}>
        {(group) => <Section title={group.title} description={tn("overview.workspaces.text", group.list.length)} headingLevel={2}><WorkspacesTable workspaces={group.list} /></Section>}
      </For>
      <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <Section title={t("overview.chart")} description={t("overview.chart.text")} headingLevel={2}>
          <Suspense fallback={<Loading />}><Charts workspaces={o().workspaces} /></Suspense>
        </Section>
        <Show when={o().health}>{(health) => <Section title={t("overview.health")} headingLevel={2} actions={<A href={`/w/${o().workspaces[0]?.slug ?? ""}/health`} class="link t-small">{t("overview.health.open")}</A>}><HealthStrip health={health()} /></Section>}</Show>
      </div>
    </div>
  );
}

/** Overview: everything Brain is doing across the workspaces the person can see. */
export default function OverviewScreen(): JSX.Element {
  const session = useSession();
  const overview = session.overview;
  return (
    <>
      <Head title={t("nav.overview")} text={t("nav.overview")} description={tn("overview.text", session.workspaces().filter((workspace) => workspace.status === "active").length)}
        actions={session.user().instanceAdmin ? <Button variant="outline" size="md" iconLeft="lucide-plus" route="/new">{t("nav.newWorkspace")}</Button> : undefined} />
      <Ready shape="cards" data={overview.data()} error={overview.error()} retry={overview.refetch}>
        {(loaded) => (
          <Show when={loaded().workspaces.length > 0} fallback={
            <EmptyState icon="lucide-folder-git-2" size="lg" bordered title={t("overview.none")} description={session.user().instanceAdmin ? t("overview.none.text.admin") : t("overview.none.text")}
              action={session.user().instanceAdmin ? <Button variant="solid" theme="blue" size="md" route="/new">{t("nav.newWorkspace")}</Button> : undefined} />
          }>
            <Content overview={loaded()} />
          </Show>
        )}
      </Ready>
    </>
  );
}
