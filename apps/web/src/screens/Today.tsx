import { createMemo, createSignal, Show, type JSX } from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { Button, TextInput } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import { NumberCard } from "@talelk/newui-charts";
import type { Approval, TaskSummary, Today as TodayData, Workspace } from "@brain/contracts";
import { command, useAction } from "../data/api";
import { usePlace, useSession } from "../data/session";
import { t, tn } from "../i18n";
import { brainOf, brainToml, paths } from "../lib/files";
import { money } from "../lib/format";
import { GoalBox } from "../components/GoalBox";
import { NeedsList, type NeedsItem } from "../components/Needs";
import { WorkspaceActions } from "../components/Share";
import { Head } from "../components/Shell";
import { Failure, Icon, Keyed, Ready, TaskRow } from "../components/bits";

/** First run, step one: where the model is. Writes the `[[model]]` entry of `brain.toml` and stores the key as a secret. */
function ConnectModel(props: { workspace: Workspace }): JSX.Element {
  const place = usePlace();
  const [url, setUrl] = createSignal("");
  const [model, setModel] = createSignal("");
  const [key, setKey] = createSignal("");
  const connect = useAction(async () => {
    const address = url().trim();
    if (key() !== "") await command("secret.set", { workspaceId: place.id(), name: "model-main", value: key() });
    const brain = brainOf(props.workspace.snapshot);
    const entry = { name: "main", provider: address.includes("anthropic") ? "anthropic" as const : "openai-compatible" as const, url: address, model: model().trim(), ...(key() !== "" ? { key: "secret:model-main" } : {}) };
    await command("file.write", { workspaceId: place.id(), files: [{ path: paths.brain, content: brainToml({ ...brain, models: [...brain.models, entry] }) }], message: "Connect a model" });
    setKey("");
  });
  return (
    <Show when={place.can("admin")} fallback={<p class="t-text text-ink-2">{t("first.model.askAdmin")}</p>}>
      <form class="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void connect.run(); }}>
        <div class="grid gap-3 sm:grid-cols-2">
          <TextInput size="md" label={t("first.model.url")} placeholder="https://models.example/v1" type="url" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} required />
          <TextInput size="md" label={t("first.model.name")} placeholder="qwen3-coder" value={model()} onInput={(event) => setModel(event.currentTarget.value)} required />
        </div>
        <TextInput size="md" label={t("first.model.key")} description={t("first.model.key.help")} type="password" autocomplete="off" value={key()} onInput={(event) => setKey(event.currentTarget.value)} />
        <Failure error={connect.error()} />
        <div><Button type="submit" variant="solid" theme="blue" size="md" loading={connect.busy()}>{t("first.model.submit")}</Button></div>
      </form>
    </Show>
  );
}

/** A fresh workspace: connect a model, then run the base pack's sample goal. The two are a sequence, so they are numbered. */
function FirstRun(props: { workspace: Workspace }): JSX.Element {
  const place = usePlace();
  const connected = (): boolean => props.workspace.snapshot.models.length > 0;
  const hello = () => props.workspace.snapshot.plays["hello"];
  const navigate = useNavigate();
  const start = useAction(async () => {
    const { taskId } = await command("task.create", { workspaceId: place.id(), play: "hello", inputs: {} });
    navigate(place.to(`/tasks/${taskId}`));
  });
  const step = (n: number, done: boolean, title: string, body: JSX.Element): JSX.Element => (
    <li class="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 rounded-card border border-outline-gray-2 bg-surface-elevation-1 p-5">
      <span class={`flex size-8 items-center justify-center rounded-full font-display text-[0.9375rem] font-semibold ${done ? "bg-ok-soft text-ok" : "bg-lilac text-ink"}`}>{done ? <Icon name="lucide-check" /> : n}</span>
      <div class="min-w-0"><h3 class="t-head text-ink">{title}</h3><div class="mt-2">{body}</div></div>
    </li>
  );
  return (
    <ol class="flex flex-col gap-3">
      {step(1, connected(), connected() ? t("first.model.done", { name: props.workspace.snapshot.models[0]?.model ?? "" }) : t("first.model.title"),
        <Show when={!connected()} fallback={<p class="t-small text-ink-2">{t("first.model.done.text")}</p>}><p class="mb-4 t-text text-ink-2">{t("first.model.text")}</p><ConnectModel workspace={props.workspace} /></Show>)}
      {step(2, false, t("first.hello.title"),
        <Show when={hello()} fallback={<p class="t-text text-ink-2">{t("first.hello.missing")}</p>}>
          {(play) => (<>
            <p class="t-text text-ink-2">{play().description}</p>
            <Failure error={start.error()} class="mt-3" />
            <div class="mt-4"><Button variant={connected() ? "solid" : "outline"} theme="blue" size="md" loading={start.busy()} disabled={!connected() || !place.can("member")} onClick={() => void start.run()}>{t("first.hello.start", { title: play().title })}</Button></div>
          </>)}
        </Show>)}
    </ol>
  );
}


/** What the open workspace is doing: the goal box, what waits for the person, what runs, what came back, and the day's spend. */
function Lists(props: { today: TodayData }): JSX.Element {
  const place = usePlace();
  const session = useSession();
  const href = (task: TaskSummary): string => place.to(`/tasks/${task.id}`);
  const pending = (): readonly Approval[] => props.today.approvals.filter((approval) => approval.state === "pending");
  const needs = createMemo((): NeedsItem[] => {
    const shared = { workspaceId: place.id(), slug: place.summary().slug, workspaceName: place.summary().name, role: place.summary().role };
    const waiting = props.today.needsYou.map((task): NeedsItem => ({ ...shared, task, approval: task.needs?.kind === "approval" ? (pending().find((approval) => task.needs?.kind === "approval" && approval.id === task.needs.approvalId) ?? null) : null }));
    // A call whose task is not listed (it is still being asked) is shown by its own task row.
    return waiting;
  });
  const days = (): readonly number[] => session.overview.data()?.workspaces.find((workspace) => workspace.id === place.id())?.days.map((day) => day.microUsd / 1_000_000) ?? [];
  const mine = () => session.overview.data()?.workspaces.find((workspace) => workspace.id === place.id());
  const goals = (): readonly number[] => mine()?.days.map((day) => day.done) ?? [];
  const doneToday = (): number => mine()?.doneToday ?? 0;
  const spend = (): TodayData["spend"] => props.today.spend;
  return (
    <div class="grid items-start gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div class="flex min-w-0 flex-col gap-6">
        <Show when={needs().length > 0}>
          <Section title={t("today.needs")} description={tn("today.needs.count", needs().length)} headingLevel={2}><NeedsList items={needs()} /></Section>
        </Show>
        <Show when={props.today.running.length > 0}>
          <Section title={t("today.running")} headingLevel={2}>
            <ul class="divide-y divide-outline-gray-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1"><Keyed each={props.today.running} by={(task) => task.id}>{(task) => <li><TaskRow task={task()} href={href(task())} /></li>}</Keyed></ul>
          </Section>
        </Show>
        <Show when={props.today.recent.length > 0}>
          <Section title={t("today.recent")} headingLevel={2} actions={<A href={place.to("/tasks")} class="link t-small">{t("today.all")}</A>}>
            <ul class="divide-y divide-outline-gray-1 rounded-card border border-outline-gray-1 bg-surface-elevation-1"><Keyed each={props.today.recent.slice(0, 8)} by={(task) => task.id}>{(task) => <li><TaskRow task={task()} href={href(task())} /></li>}</Keyed></ul>
          </Section>
        </Show>
      </div>
      <aside class="flex flex-col gap-4" aria-label={t("today.spend.title")}>
        <NumberCard title={t("today.spend.title")} value={spend().todayMicroUsd / 1_000_000} format={(value) => money(value * 1_000_000)} {...(spend().capMicroUsd > 0 ? { target: spend().capMicroUsd / 1_000_000 } : {})} negativeIsBetter
          {...trend(days())} />
        <NumberCard title={t("overview.stat.done")} value={doneToday()} {...trend(goals())} />
        <p class="px-1 t-small text-ink-3">{spend().capMicroUsd > 0 ? t("today.spend.cap", { spent: money(spend().todayMicroUsd), cap: money(spend().capMicroUsd) }) : t("today.spend", { spent: money(spend().todayMicroUsd) })}</p>
      </aside>
    </div>
  );
}

/** A week of bars, unless every day is nothing: bars scale from the smallest day, so a flat run of zeros would be drawn as a wall. */
const trend = (days: readonly number[]): { sparkline?: { data: number[]; type: "bar" } } => (days.some((day) => day > 0) ? { sparkline: { data: [...days], type: "bar" } } : {});

/** Today: what do you want done, what waits for you, what is running, what came back. */
export default function TodayScreen(): JSX.Element {
  const place = usePlace();
  const [search] = useSearchParams<{ play?: string; new?: string }>();
  const fresh = (today: TodayData | undefined): boolean => today !== undefined && today.needsYou.length + today.running.length + today.recent.length + today.approvals.length === 0;
  return (
    <>
      <Head title={place.summary().name} text={place.summary().name} description={place.summary().description || undefined} breadcrumbs={[{ label: t("nav.overview"), route: "/" }, { label: place.summary().name }]} actions={<WorkspaceActions />} />
      <Ready shape="form" data={place.workspace.data()} error={place.workspace.error()} retry={place.workspace.refetch}>
        {(workspace) => (
          <div class="flex flex-col gap-6">
            <GoalBox plays={workspace().snapshot.plays} play={search.play} autofocus={search.new !== undefined} />
            <Show when={workspace().snapshot.models.length === 0 || fresh(place.today.data())}><FirstRun workspace={workspace()} /></Show>
          </div>
        )}
      </Ready>
      <div class="mt-6">
        <Show when={place.today.data()} fallback={<Failure error={place.today.error()} retry={place.today.refetch} />}>{(today) => <Lists today={today()} />}</Show>
      </div>
    </>
  );
}
