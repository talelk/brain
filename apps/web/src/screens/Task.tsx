import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";
import { Button, Textarea } from "@talelk/newui-atoms";
import { DetailHeader, Section } from "@talelk/newui-organisms";
import { PaneLayout } from "@talelk/newui-templates";
import type { Attempt, Check, Task, TaskNeed, TaskSummary } from "@brain/contracts";
import { command, useAction, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { t } from "../i18n";
import { ago, dateTime, duration, money, shortHash, titleOf, tokens } from "../lib/format";
import { ApprovalView } from "../components/ApprovalView";
import { TaskGraph } from "../components/TaskGraph";
import { Evidence } from "../components/Evidence";
import { Markdown } from "../components/Markdown";
import { PlanEditor } from "../components/PlanEditor";
import { ConfirmButton, Details, Failure, Icon, Keyed, needText, NeedsMark, Ready, StateWord } from "../components/bits";
import { Head } from "../components/Shell";

const Part = (props: { title: string; aside?: JSX.Element; children: JSX.Element }): JSX.Element => <Section title={props.title} headingLevel={3} actions={props.aside ? <span class="t-small text-ink-3">{props.aside}</span> : undefined} class="border-t border-outline-gray-1 py-5 first:border-t-0 first:pt-0">{props.children}</Section>;

/** A person's own check or sign-off: pass it, or send it back with what to fix. */
function Verdict(props: { task: Task; passLabel: string }): JSX.Element {
  const place = usePlace();
  const [findings, setFindings] = createSignal("");
  const check = useAction((pass: boolean) => command("task.check", { workspaceId: place.id(), taskId: props.task.id, pass, findings: findings() }));
  return (
    <div class="flex flex-col gap-3">
      <Textarea size="md" label={t("verdict.findings")} description={t("verdict.findings.help")} rows={3} value={findings()} onInput={(event) => setFindings(event.currentTarget.value)} />
      <Failure error={check.error()} />
      <div class="flex flex-wrap gap-2">
        <Button variant="solid" theme="blue" size="md" loading={check.busy()} onClick={() => void check.run(true)}>{props.passLabel}</Button>
        <Button variant="outline" size="md" disabled={check.busy() || findings().trim() === ""} onClick={() => void check.run(false)}>{t("verdict.sendBack")}</Button>
      </div>
    </div>
  );
}

/** What the selected task waits for from a person, with the control that answers it. */
function Needs(props: { task: Task; need: TaskNeed; onSelect: (id: string) => void; onOrder: (ids: readonly string[]) => void }): JSX.Element {
  const place = usePlace();
  const [answer, setAnswer] = createSignal("");
  const confirm = useAction(() => command("task.confirm", { workspaceId: place.id(), taskId: props.task.id }));
  const send = useAction(() => command("task.answer", { workspaceId: place.id(), taskId: props.task.id, answer: answer() }));
  const keep = useAction((attemptId: string) => command("task.check", { workspaceId: place.id(), taskId: props.task.id, pass: true, keep: attemptId }));
  const retry = useAction(() => command("task.retry", { workspaceId: place.id(), taskId: props.need.kind === "failed-subtask" ? props.need.taskId : props.task.id }));
  const approval = () => props.task.approvals.find((entry) => props.need.kind === "approval" && entry.id === props.need.approvalId);
  const candidates = (): Attempt[] => (props.need.kind === "judge" ? props.task.attempts.filter((attempt) => (props.need as { attemptIds: readonly string[] }).attemptIds.includes(attempt.id)) : []);
  return (
    <section class="mb-6 rounded-card border border-(--needs-line) bg-surface-elevation-1 p-4" aria-label={t("state.needs_you")}>
      <p class="mb-3 inline-flex items-center gap-2 t-small font-semibold text-needs-text"><NeedsMark />{needText(props.need)}</p>
      <Show when={place.can("member") || props.need.kind === "approval"} fallback={<p class="t-text text-ink-2">{t("need.viewer")}</p>}>
        <Switch>
          <Match when={props.need.kind === "confirm-plan"}>
            <p class="mb-2 t-text text-ink-2">{t("need.confirm-plan.text")}</p>
            <PlanEditor root={props.task} onOrder={props.onOrder} />
            <Failure error={confirm.error()} class="mt-3" />
            <div class="mt-4"><Button variant="solid" theme="blue" size="lg" loading={confirm.busy()} onClick={() => void confirm.run()}>{t("plan.confirm")}</Button></div>
          </Match>
          <Match when={approval()}>{(entry) => <ApprovalView approval={entry()} workspaceId={place.id()} canDecide={place.can("member")} diff="show" />}</Match>
          <Match when={props.need.kind === "answer" && props.need}>
            {(asked) => (
              <form class="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void send.run(); }}>
                <p class="t-text text-ink" dir="auto">{asked().question}</p>
                <Textarea size="md" aria-label={t("need.answer.label")} placeholder={t("need.answer.placeholder")} rows={3} value={answer()} onInput={(event) => setAnswer(event.currentTarget.value)} />
                <Failure error={send.error()} />
                <div><Button type="submit" variant="solid" theme="blue" size="md" loading={send.busy()} disabled={answer().trim() === ""}>{t("need.answer.send")}</Button></div>
              </form>
            )}
          </Match>
          <Match when={props.need.kind === "check" && props.need}>
            {(failed) => (<>
              <p class="mb-2 t-text text-ink-2">{t("need.check.text")}</p>
              <Show when={failed().findings}><div class="mb-4 rounded-xl bg-paper px-4 py-3"><Markdown text={failed().findings} /></div></Show>
              <Verdict task={props.task} passLabel={t("verdict.pass")} />
            </>)}
          </Match>
          <Match when={props.need.kind === "sign-off"}>
            <p class="mb-3 t-text text-ink-2">{t("need.sign-off.text")}</p>
            <Verdict task={props.task} passLabel={t("verdict.signOff")} />
          </Match>
          <Match when={props.need.kind === "judge"}>
            <p class="mb-3 t-text text-ink-2">{t("need.judge.text")}</p>
            <Failure error={keep.error()} class="mb-3" />
            <ul class="flex flex-col gap-3">
              <For each={candidates()}>
                {(attempt) => (
                  <li class="rounded-xl bg-paper p-4">
                    <div class="mb-2 flex items-center justify-between gap-3"><p class="t-text font-semibold text-ink">{attempt.agent}</p><Button variant="outline" size="sm" loading={keep.busy()} onClick={() => void keep.run(attempt.id)}>{t("need.judge.keep")}</Button></div>
                    <Markdown text={attempt.result ?? ""} />
                  </li>
                )}
              </For>
            </ul>
          </Match>
          <Match when={props.need.kind === "failed-subtask" && props.need}>
            {(failed) => (<>
              <p class="mb-3 t-text text-ink-2">{t("need.failed-subtask.text")}</p>
              <Failure error={retry.error()} class="mb-3" />
              <div class="flex flex-wrap gap-2">
                <Button variant="solid" theme="blue" size="md" loading={retry.busy()} onClick={() => void retry.run()}>{t("need.failed-subtask.retry")}</Button>
                <Button variant="outline" size="md" onClick={() => props.onSelect(failed().taskId)}>{t("need.failed-subtask.open")}</Button>
              </div>
            </>)}
          </Match>
        </Switch>
      </Show>
    </section>
  );
}

function CheckRow(props: { check: Check }): JSX.Element {
  return (
    <li class="border-b border-rule py-3 last:border-b-0">
      <p class="flex flex-wrap items-center gap-x-2 t-text">
        <span class={`inline-flex items-center gap-1.5 font-semibold ${props.check.pass ? "text-ok" : "text-bad"}`}><Icon name={props.check.pass ? "lucide-circle-check" : "lucide-undo-2"} />{props.check.pass ? t("check.passed") : t("check.sentBack")}</span>
        <span class="text-ink-2">{t(props.check.by.kind === "agent" ? "check.byAgent" : "check.byPerson", { name: props.check.by.name, round: props.check.round })}</span>
        <Show when={props.check.score !== null}><span class="text-ink-2">{t("check.score", { score: Math.round((props.check.score ?? 0) * 100) })}</span></Show>
        <span class="ms-auto t-small text-ink-3">{dateTime(props.check.at)}</span>
      </p>
      <Show when={props.check.findings}><Markdown text={props.check.findings} class="mt-2" /></Show>
    </li>
  );
}

/** Everything recorded for the selected link: result, check, evidence, approvals, cost, pull request. */
function Detail(props: { task: Task; isGoal: boolean; onSelect: (id: string) => void; onOrder: (ids: readonly string[]) => void }): JSX.Element {
  const place = usePlace();
  const stop = useAction(() => command("task.stop", { workspaceId: place.id(), taskId: props.task.id }));
  const retry = useAction(() => command("task.retry", { workspaceId: place.id(), taskId: props.task.id }));
  const task = (): Task => props.task;
  const open = (): boolean => ["waiting", "ready", "running", "needs_you"].includes(task().state);
  const decided = () => task().approvals.filter((approval) => !(task().needs?.kind === "approval" && task().needs && approval.id === (task().needs as { approvalId: string }).approvalId));
  const runs = (): readonly Attempt[] => task().attempts;
  const children = (): TaskSummary[] => (props.isGoal ? [] : task().subtasks.filter((sub) => sub.parentId === task().id));
  const unstarted = (): boolean => props.isGoal && task().needs?.kind !== "confirm-plan" && task().subtasks.some((sub) => sub.parentId === task().id && (sub.state === "waiting" || sub.state === "ready"));
  const skipped = (): boolean => task().state === "done" && task().result === "skipped";
  return (
    <article aria-label={task().title}>
      <DetailHeader class="mb-5" headingLevel={2} title={<bdi>{props.isGoal ? t("graph.goal") : titleOf(task())}</bdi>}
        subtitle={<span class="flex flex-wrap items-center gap-x-3 gap-y-1"><StateWord state={task().state} /><Show when={task().agent}><span>{t("task.agent", { agent: task().agent ?? "" })}</span></Show></span>}>
        <Show when={place.can("member")}>
          <Show when={task().state === "failed" || task().state === "stopped"}><Button variant="outline" size="md" iconLeft="lucide-rotate-cw" loading={retry.busy()} onClick={() => void retry.run()}>{t("task.retry")}</Button></Show>
          <Show when={open()}><ConfirmButton label={props.isGoal ? t("task.stop.goal") : t("task.stop")} confirm={t("task.stop.confirm")} busy={stop.busy()} onConfirm={() => void stop.run()} icon="lucide-square" /></Show>
        </Show>
      </DetailHeader>
      <Failure error={stop.error() ?? retry.error()} class="mb-4" />
      <Show when={task().needs}>{(need) => <Needs task={task()} need={need()} onSelect={props.onSelect} onOrder={props.onOrder} />}</Show>

      <Show when={props.isGoal} fallback={
        <Details class="mb-6" summary={t("task.asked")}>
          <Markdown text={task().goal} class="rounded-xl bg-paper px-4 py-3" />
          <Show when={task().settings.when}><p class="mt-2 t-small text-ink-3">{t("task.when", { when: task().settings.when ?? "" })}</p></Show>
        </Details>
      }>
        <Part title={t("task.goal")}><Markdown text={task().goal} /></Part>
      </Show>
      <Show when={unstarted() && place.can("member")}>
        <Part title={t("plan.edit.title")}><Details summary={t("plan.edit.open")}><PlanEditor root={task()} /></Details></Part>
      </Show>
      <Show when={task().result !== null || task().state === "failed"}>
        <Part title={task().state === "failed" ? t("task.failed") : t("task.result")}>
          <Show when={!skipped()} fallback={<p class="t-text text-ink-2">{t("task.skipped")}</p>}>
            <Show when={task().state === "failed"} fallback={<Markdown text={task().result ?? ""} />}><p class="whitespace-pre-wrap rounded-xl bg-bad-soft px-4 py-3 t-text text-bad" dir="auto">{task().result ?? runs().at(-1)?.failure?.detail ?? t("task.failed.unknown")}</p></Show>
          </Show>
        </Part>
      </Show>
      <Show when={children().length > 0}>
        <Part title={t("task.subtasks")}>
          <ul><For each={children()}>{(sub) => <li><button type="button" class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-start hover:bg-lilac" onClick={() => props.onSelect(sub.id)}><StateWord state={sub.state} /><span class="min-w-0 truncate t-text text-ink">{titleOf(sub)}</span></button></li>}</For></ul>
        </Part>
      </Show>
      <Show when={task().checks.length > 0}>
        <Part title={t("task.check")} aside={task().settings.reviewBy ? t("task.check.by", { agent: task().settings.reviewBy ?? "", rounds: task().settings.maxRounds }) : undefined}>
          <ul><Keyed each={task().checks} by={(check) => check.id}>{(check) => <CheckRow check={check()} />}</Keyed></ul>
        </Part>
      </Show>
      <Show when={!skipped() && (runs().length > 0 || task().toolCalls.length > 0)}>
        <Part title={t("task.evidence")}><Evidence task={task()} /></Part>
      </Show>
      <Show when={decided().length > 0}>
        <Part title={t("task.approvals")}>
          <ul class="flex flex-col gap-5"><Keyed each={decided()} by={(approval) => approval.id}>{(approval) => <li><ApprovalView approval={approval()} workspaceId={place.id()} canDecide={place.can("member")} diff="show" /></li>}</Keyed></ul>
        </Part>
      </Show>
      <Show when={task().pullRequests.length > 0}>
        <Part title={t("task.pullRequests")}>
          <ul><For each={task().pullRequests}>{(pull) => <li class="flex flex-wrap items-center gap-x-3 gap-y-1 t-text"><Icon name="lucide-git-pull-request" class="size-4 text-ink-3" /><a class="link" href={pull.url} target="_blank" rel="noreferrer noopener">{t("task.pullRequest", { number: pull.number, project: pull.project })}</a><span class="t-small text-ink-3">{pull.state}, {ago(pull.at)}</span></li>}</For></ul>
        </Part>
      </Show>
      <Show when={props.isGoal && task().notes.length > 0}>
        <Part title={t("task.notes")} aside={t("task.notes.help")}>
          <ul class="flex flex-col gap-3"><For each={task().notes}>{(note) => <li class="t-text"><p class="t-small text-ink-3"><span class="font-semibold text-ink-2">{note.author}</span>, {ago(note.at)}</p><p class="whitespace-pre-wrap text-ink" dir="auto">{note.text}</p></li>}</For></ul>
        </Part>
      </Show>
      <Show when={runs().length > 0}>
        <Part title={t("task.cost")} aside={`${money(task().usage.microUsd)}, ${tokens(task().usage)}`}>
          <Show when={runs().some((attempt) => !attempt.priced)}><p class="mb-2 t-small text-ink-2">{t("task.cost.unpriced")}</p></Show>
          <Details summary={t("task.cost.runs", { n: runs().length })}>
            <div class="overflow-x-auto">
              <table class="w-full t-small">
                <tbody>
                  <For each={runs()}>
                    {(attempt, index) => (
                      <tr class="border-b border-rule last:border-b-0">
                        <td class="whitespace-nowrap py-1.5 pe-3 font-medium text-ink">{t("task.run", { n: index() + 1 })}</td>
                        <td class="whitespace-nowrap py-1.5 pe-3 text-ink-2">{t(`attempt.kind.${attempt.kind}`)}, {attempt.agent}</td>
                        <td class="whitespace-nowrap py-1.5 pe-3 text-ink-3">{[attempt.engine, attempt.model].filter(Boolean).join(", ")}</td>
                        <td class="whitespace-nowrap py-1.5 pe-3 text-ink-3">{t(`attempt.state.${attempt.state}`)}<Show when={attempt.startedAt && attempt.finishedAt}> ({duration((attempt.finishedAt ?? 0) - (attempt.startedAt ?? 0))})</Show></td>
                        <td class="whitespace-nowrap py-1.5 pe-3 text-ink-3">{tokens(attempt.usage)}</td>
                        <td class="whitespace-nowrap py-1.5 text-end tabular-nums text-ink">{attempt.priced ? money(attempt.usage.microUsd) : t("cost.unpriced")}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <p class="mt-2 t-small text-ink-3">{t("task.files", { hash: shortHash(task().snapshotDigest) })}</p>
          </Details>
        </Part>
      </Show>
    </article>
  );
}

/** One goal: its chain of sub-tasks in the start pane, and in the end pane what is recorded for the selected link. */
export default function TaskScreen(): JSX.Element {
  const place = usePlace();
  const params = useParams<{ taskId: string }>();
  const [search, setSearch] = useSearchParams<{ link?: string }>();
  const [order, setOrder] = createSignal<readonly string[]>();
  const [pane, setPane] = createSignal<"start" | "end">("end");
  const record = useQuery("task.get", () => ({ workspaceId: place.id(), taskId: params.taskId }));
  /** The link shown beside the chain: the one in the address, else the first that needs a person, else the one running, else the goal. */
  const selectedId = createMemo((): string => {
    const task = record.data();
    if (!task) return params.taskId;
    if (search.link && (search.link === task.id || task.subtasks.some((sub) => sub.id === search.link))) return search.link;
    const leaf = (sub: TaskSummary): boolean => !task.subtasks.some((other) => other.parentId === sub.id);
    return (task.needs ? task : task.subtasks.find((sub) => sub.state === "needs_you" && leaf(sub)) ?? task.subtasks.find((sub) => sub.state === "running" && leaf(sub)) ?? task).id;
  });
  const sub = useQuery("task.get", () => (selectedId() === params.taskId ? undefined : { workspaceId: place.id(), taskId: selectedId() }));
  const selected = (): Task | undefined => (selectedId() === params.taskId ? record.data() : sub.data());
  const select = (id: string): void => { setSearch({ link: id }, { replace: true }); setPane("end"); };
  return (
    <Ready data={record.data()} error={record.error()} retry={record.refetch}>
      {(task) => (
        <>
          <Head title={<bdi>{task().title}</bdi>} text={task().title}
            breadcrumbs={[{ label: t("nav.overview"), route: "/" }, { label: place.summary().name, route: place.to() }, { label: t("nav.tasks"), route: place.to("/tasks") }, ...(task().parentId ? [{ label: t("task.back.goal"), route: place.to(`/tasks/${task().rootId}?link=${task().id}`) }] : [])]}
            description={<>
              {task().createdByName ? t("task.started.by", { name: task().createdByName ?? "", when: ago(task().createdAt) }) : t("task.started", { when: ago(task().createdAt) })}
              <Show when={task().play}> {t("task.started.play", { play: place.workspace.data()?.snapshot.plays[task().play ?? ""]?.title ?? task().play ?? "" })}</Show>
              <Show when={task().usage.microUsd > 0}> {t(task().finishedAt ? "task.cost.total" : "task.cost.soFar", { cost: money(task().usage.microUsd) })}</Show>
            </>} />
          <PaneLayout active={pane()} defaultSize={52} minStartSize={30} maxStartSize={72} resizeLabel={t("task.resize")} class="gap-0"
            start={
              <div class="lg:sticky lg:top-3 lg:pe-5">
                <TaskGraph record={task()} order={task().needs?.kind === "confirm-plan" ? order() : undefined} selected={selectedId()} onSelect={select} />
                <Show when={task().subtasks.length === 0 && task().state === "running"}><p class="mt-3 t-small text-ink-3">{t("task.planning")}</p></Show>
              </div>
            }
            end={
              <div class="min-w-0 lg:ps-6">
                <Button variant="ghost" size="md" iconLeft="lucide-chevron-left" class="mb-3 lg:hidden" onClick={() => setPane("start")}>{t("graph.label")}</Button>
                <div class="rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-5 sm:p-6">
                  <Show when={selected()} fallback={<Failure error={sub.error()} retry={sub.refetch} />}>
                    {(current) => <Detail task={current()} isGoal={current().id === task().id} onSelect={select} onOrder={setOrder} />}
                  </Show>
                </div>
              </div>
            } />
        </>
      )}
    </Ready>
  );
}
