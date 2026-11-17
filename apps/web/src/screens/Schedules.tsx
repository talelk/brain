import { createSignal, For, Show, type JSX } from "solid-js";
import { A, useParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { EmptyState } from "@talelk/newui-molecules";
import type { ScheduleItem } from "@brain/contracts";
import { useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { human, t, tn } from "../i18n";
import { ago } from "../lib/format";
import { inZone, webhookWords, words } from "../lib/schedule";
import { saveTrigger, ScheduleDialog } from "../components/Schedule";
import { Head } from "../components/Shell";
import { Failure, Icon, Ready, StateWord } from "../components/bits";

/** One scheduled or webhook Play: when it starts, what happened last, and what it will do. */
function Row(props: { item: ScheduleItem; onEdit: (item: ScheduleItem) => void }): JSX.Element {
  const item = (): ScheduleItem => props.item;
  const admin = (): boolean => item().role === "admin";
  const toggle = useAction(async () => {
    const trigger = item().kind === "schedule" ? { schedule: item().spec, ...(item().paused ? {} : { paused: true as const }) } : undefined;
    if (trigger) await saveTrigger(item().workspaceId, item().play, trigger);
  });
  const at = (): string => `/w/${item().workspaceSlug}`;
  return (
    <li class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-4 sm:p-5">
      <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div class="min-w-0">
          <h2 class="t-title text-ink"><A class="rounded-control hover:underline focus-visible:focus-ring" href={`${at()}/workspace/plays/${item().play}`}>{human(item().translations, ["title"], item().title)}</A></h2>
          <p class="mt-0.5 t-small text-ink-2"><A class="link" href={at()}>{item().workspaceName}</A> · <span class="t-code code-ltr" dir="ltr">{item().play}</span><Show when={item().source !== "workspace"}> · {t("workspace.source.pack", { pack: item().source })}</Show></p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={item().kind === "webhook"}><Badge theme="blue" size="md" prefix={<Icon name="lucide-webhook" class="size-3" />} label={t("schedule.kind.webhook")} /></Show>
          <Show when={item().kind === "schedule"}>
            <Badge theme={item().paused ? "gray" : "green"} size="md" prefix={<Icon name={item().paused ? "lucide-pause" : "lucide-clock"} class="size-3" />} label={t(item().paused ? "schedule.paused" : "schedule.active")} />
          </Show>
          <Show when={admin() && item().kind === "schedule"}>
            <Button variant="outline" size="md" iconLeft={item().paused ? "lucide-play" : "lucide-pause"} loading={toggle.busy()} onClick={() => void toggle.run()}>{t(item().paused ? "schedule.resume" : "schedule.pauseNow")}</Button>
            <Button variant="outline" size="md" iconLeft="lucide-pencil" onClick={() => props.onEdit(item())}>{t("schedule.change")}</Button>
          </Show>
        </div>
      </div>
      <Failure error={toggle.error()} class="mt-2" />
      <p class="mt-3 t-text font-medium text-ink">
        {item().kind === "schedule" ? words(item().spec, item().timezone) : webhookWords(item().spec)}
        <span class="t-small font-normal text-ink-2"> · <code class="t-code code-ltr" dir="ltr">{item().spec}</code></span>
      </p>
      <dl class="mt-3 grid gap-x-6 gap-y-3 t-small sm:grid-cols-3">
        <div><dt class="font-medium text-ink-2">{t("schedule.next")}</dt><dd class="mt-0.5 text-ink">
          <Show when={item().nextRunAt} fallback={item().kind === "webhook" ? t("schedule.next.webhook") : item().paused ? t("schedule.next.paused") : t("schedule.next.none")}>{(next) => <>{inZone(next(), item().timezone)} <span class="text-ink-2">({item().timezone})</span></>}</Show>
          <Show when={item().skipsNext}><span class="block text-needs-text">{t("schedule.skips")}</span></Show>
        </dd></div>
        <div><dt class="font-medium text-ink-2">{t("schedule.last")}</dt><dd class="mt-0.5 text-ink">
          <Show when={item().lastTask && item().lastRunAt} fallback={t("schedule.last.never")}>
            <A class="link" href={`${at()}/tasks/${item().lastTask?.id}`}>{ago(item().lastRunAt ?? 0)}</A> · <StateWord state={item().lastTask?.state ?? "done"} />
          </Show>
        </dd></div>
        <div><dt class="font-medium text-ink-2">{t("schedule.does")}</dt><dd class="mt-0.5 text-ink">
          <ol class="flex flex-col gap-0.5"><For each={item().steps}>{(step, index) => <li><span class="text-ink-2">{index() + 1}.</span> <span class="t-code" dir="ltr">{step.id}</span> <span class="text-ink-2">· {step.agent}</span></li>}</For></ol>
        </dd></div>
      </dl>
    </li>
  );
}

/** Every Play that starts by itself, across the workspaces the person can see (or one workspace, from its address). */
export default function SchedulesScreen(): JSX.Element {
  const session = useSession();
  const params = useParams<{ slug?: string }>();
  const schedules = useQuery("schedules.list", () => ({}));
  const [dialog, setDialog] = createSignal<{ item?: ScheduleItem }>();
  const canSchedule = (): boolean => session.workspaces().some((workspace) => workspace.status === "active" && workspace.role === "admin" && !workspace.viaPublic);
  const shown = (all: readonly ScheduleItem[]): ScheduleItem[] => (params.slug ? all.filter((item) => item.workspaceSlug === params.slug) : [...all]);
  return (
    <>
      <Head title={t("nav.schedules")} text={t("nav.schedules")} description={t("schedule.text")}
        actions={canSchedule() ? <Button variant="solid" theme="blue" size="md" iconLeft="lucide-calendar-plus" onClick={() => setDialog({})}>{t("schedule.add")}</Button> : undefined} />
      <Ready shape="table" data={schedules.data()} error={schedules.error()} retry={schedules.refetch}>
        {(loaded) => (
          <Show when={shown(loaded().schedules).length > 0} fallback={
            <EmptyState bordered icon="lucide-calendar-clock" size="lg" title={t("schedule.empty")} description={t("schedule.empty.text")}
              action={canSchedule() ? <Button variant="solid" theme="blue" size="md" onClick={() => setDialog({})}>{t("schedule.add")}</Button> : undefined} />
          }>
            <p class="mb-3 t-small text-ink-2">{tn("schedule.count", shown(loaded().schedules).length)}</p>
            <ul class="flex flex-col gap-3" aria-label={t("nav.schedules")}><For each={shown(loaded().schedules)}>{(item) => <Row item={item} onEdit={(it) => setDialog({ item: it })} />}</For></ul>
          </Show>
        )}
      </Ready>
      <ScheduleDialog open={dialog() !== undefined} onOpenChange={(open) => { if (!open) setDialog(undefined); }} item={dialog()?.item} />
    </>
  );
}
