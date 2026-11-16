import { createSignal, Show, type JSX } from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { Button, TextInput } from "@talelk/newui-atoms";
import type { Approval, TaskNeed, TaskSummary, Today as TodayData, Workspace } from "@brain/contracts";
import { command, useAction } from "../data/api";
import { usePlace } from "../data/session";
import { t, tn } from "../i18n";
import { brainOf, brainToml, paths } from "../lib/files";
import { money, titleOf } from "../lib/format";
import { ApprovalView } from "../components/ApprovalView";
import { GoalBox } from "../components/GoalBox";
import { Failure, Icon, Keyed, needText, Ready, Section, TaskRow } from "../components/bits";

/** A card for one thing waiting for the person. Orange means exactly this, here and everywhere. */
function NeedCard(props: { kind: string; goal: string; step?: string; href: string; children: JSX.Element }): JSX.Element {
  return (
    <li class="rounded-[20px] border border-(--needs-line) bg-sheet p-5">
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="inline-flex items-center gap-2 t-small font-semibold text-needs-text"><span class="h-[1.0625rem] w-[0.6875rem] rounded-full border-[2.5px] border-needs-mark" aria-hidden="true" />{props.kind}</span>
        <A href={props.href} class="min-w-0 truncate t-small font-medium text-ink underline-offset-2 hover:underline" dir="auto">{props.goal}</A>
        <Show when={props.step}><span class="t-small text-ink-3">{props.step}</span></Show>
      </div>
      {props.children}
    </li>
  );
}

/** A task that waits for something other than an approval: the question is answered here, the rest opens the task. */
function NeedTask(props: { task: TaskSummary }): JSX.Element {
  const place = usePlace();
  const [answer, setAnswer] = createSignal("");
  const send = useAction(() => command("task.answer", { workspaceId: place.id(), taskId: props.task.id, answer: answer() }));
  const href = (): string => place.to(`/tasks/${props.task.rootId}?link=${props.task.id}`);
  const need = () => props.task.needs;
  /** An approval has its own card, so what is left opens the task. */
  const kind = (): Exclude<TaskNeed["kind"], "approval"> => { const value = need()?.kind; return value === undefined || value === "approval" ? "check" : value; };
  return (
    <NeedCard kind={need() ? needText(need()!) : ""} goal={props.task.goalTitle} step={props.task.id === props.task.rootId ? undefined : titleOf(props.task)} href={href()}>
      <Show when={need()?.kind === "answer" && need()} keyed fallback={
        <div class="flex flex-col items-start gap-3">
          <p class="min-w-0 t-text text-ink">{t(`need.${kind()}.text`)}</p>
          <Button variant="solid" theme="blue" size="md" route={href()}>{t(`need.${kind()}.open`)}</Button>
        </div>
      }>
        {(asked) => (
          <form class="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void send.run(); }}>
            <p class="t-text text-ink" dir="auto">{asked.kind === "answer" ? asked.question : ""}</p>
            <Show when={place.can("member")}>
              <div class="flex flex-wrap items-end gap-2">
                <div class="min-w-48 flex-1"><TextInput size="md" aria-label={t("need.answer.label")} placeholder={t("need.answer.placeholder")} value={answer()} onInput={(event) => setAnswer(event.currentTarget.value)} /></div>
                <Button type="submit" variant="solid" theme="blue" size="md" loading={send.busy()} disabled={answer().trim() === ""}>{t("need.answer.send")}</Button>
              </div>
            </Show>
            <Failure error={send.error()} />
          </form>
        )}
      </Show>
    </NeedCard>
  );
}

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
    <li class="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 rounded-[20px] border border-rule-2 bg-sheet p-5">
      <span class={`flex size-8 items-center justify-center rounded-full font-display text-[0.9375rem] font-semibold ${done ? "bg-ok-soft text-ok" : "bg-lilac text-ink"}`}>{done ? <Icon name="lucide-check" /> : n}</span>
      <div class="min-w-0"><h3 class="t-head text-ink">{title}</h3><div class="mt-2">{body}</div></div>
    </li>
  );
  return (
    <ol class="mt-10 flex flex-col gap-3">
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

function Lists(props: { today: TodayData }): JSX.Element {
  const place = usePlace();
  const href = (task: TaskSummary): string => place.to(`/tasks/${task.id}`);
  const pending = (): readonly Approval[] => props.today.approvals.filter((approval) => approval.state === "pending");
  const others = (): readonly TaskSummary[] => props.today.needsYou.filter((task) => task.needs?.kind !== "approval");
  const waiting = (): number => pending().length + others().length;
  const cap = (): number => props.today.spend.capMicroUsd;
  /** The task an approval is asked on, for the step's name; people know their goals by title, not the steps inside them. */
  const asking = (approval: Approval): TaskSummary | undefined => props.today.needsYou.find((task) => task.id === approval.taskId);
  const approvalHref = (approval: Approval): string => place.to(`/tasks/${approval.rootTaskId}?link=${approval.taskId}`);
  return (
    <>
      <Show when={waiting() > 0}>
        <Section title={t("today.needs")} aside={tn("today.needs.count", waiting())}>
          <ul class="flex flex-col gap-3">
            <Keyed each={pending()} by={(approval) => approval.id}>{(approval) => <NeedCard kind={t("need.approval")} goal={approval().goalTitle} step={asking(approval()) ? titleOf(asking(approval())!) : undefined} href={approvalHref(approval())}><ApprovalView approval={approval()} diff="link" href={approvalHref(approval())} /></NeedCard>}</Keyed>
            <Keyed each={others()} by={(task) => task.id}>{(task) => <NeedTask task={task()} />}</Keyed>
          </ul>
        </Section>
      </Show>
      <Show when={props.today.running.length > 0}>
        <Section title={t("today.running")}>
          <ul class="-mx-3"><Keyed each={props.today.running} by={(task) => task.id}>{(task) => <li><TaskRow task={task()} href={href(task())} /></li>}</Keyed></ul>
        </Section>
      </Show>
      <Show when={props.today.recent.length > 0}>
        <Section title={t("today.recent")} aside={cap() > 0 ? t("today.spend.cap", { spent: money(props.today.spend.todayMicroUsd), cap: money(cap()) }) : t("today.spend", { spent: money(props.today.spend.todayMicroUsd) })}>
          <ul class="-mx-3"><Keyed each={props.today.recent} by={(task) => task.id}>{(task) => <li><TaskRow task={task()} href={href(task())} /></li>}</Keyed></ul>
          <A href={place.to("/tasks")} class="link mt-3 inline-block t-small">{t("today.all")}</A>
        </Section>
      </Show>
    </>
  );
}

/** Today: what do you want done, what waits for you, what is running, what came back. */
export function Today(): JSX.Element {
  const place = usePlace();
  const [search] = useSearchParams<{ play?: string; new?: string }>();
  const fresh = (today: TodayData | undefined): boolean => today !== undefined && today.needsYou.length + today.running.length + today.recent.length + today.approvals.length === 0;
  return (
    <div class="mx-auto max-w-[46rem]">
      <h1 class="mb-6 mt-2 t-hero text-ink md:mt-8">{t("today.title")}</h1>
      <Ready data={place.workspace.data()} error={place.workspace.error()} retry={place.workspace.refetch}>
        {(workspace) => (
          <>
            <GoalBox plays={workspace().snapshot.plays} play={search.play} autofocus={search.new !== undefined} />
            <Show when={workspace().snapshot.models.length === 0 || fresh(place.today.data())}><FirstRun workspace={workspace()} /></Show>
          </>
        )}
      </Ready>
      <Show when={place.today.data()} fallback={<Failure error={place.today.error()} retry={place.today.refetch} class="mt-8" />}>{(today) => <Lists today={today()} />}</Show>
    </div>
  );
}
