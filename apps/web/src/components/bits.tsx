import { createMemo, For, Show, type Accessor, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { Problem, TaskNeed, TaskState, TaskSummary } from "@brain/contracts";
import type { ApiFailure } from "../data/api";
import { t, tKey } from "../i18n";
import { ago, money, shownState, stateLabel } from "../lib/format";

/** The small pieces every screen is made of. An icon is named by its full `lucide-*` class so the stylesheet build can see it. */

export const Icon = (props: { name: string; class?: string }): JSX.Element => <span class={`${props.name} inline-block shrink-0 ${props.class ?? "size-4"}`} aria-hidden="true" />;

/** What went wrong, in the interface's words, then the Governor's own sentence when it sent one. */
export function failureText(failure: ApiFailure): string {
  const known = tKey(`error.${failure.code}`, "");
  // For these the interface's sentence says it all; the Governor's would repeat it.
  const enough = failure.code === "INVALID_WORKSPACE" || failure.code === "STALE_VERSION";
  return [known, enough && known !== "" ? "" : failure.message].filter((part) => part !== "").join(" ") || t("error.unknown");
}

/** A refusal shown where it happened. `problems` replaces the refusal's own list when the screen shows some of them elsewhere. */
export function Failure(props: { error: ApiFailure | undefined; retry?: () => void; class?: string; problems?: readonly Problem[] }): JSX.Element {
  return (
    <Show when={props.error}>
      {(error) => (
        <div role="alert" class={`rounded-xl bg-bad-soft px-4 py-3 text-bad ${props.class ?? ""}`}>
          <p class="t-text font-medium">{failureText(error())}</p>
          <Problems problems={props.problems ?? error().problems} />
          <Show when={props.retry}>{(retry) => <button type="button" class="link mt-1 t-small" onClick={() => retry()()}>{t("action.retry")}</button>}</Show>
        </div>
      )}
    </Show>
  );
}

/** Each thing to fix, with the file or the field it names. */
export function Problems(props: { problems: readonly Problem[] }): JSX.Element {
  return (
    <Show when={props.problems.length > 0}>
      <ul class="mt-2 flex flex-col gap-1 t-small">
        <For each={props.problems}>{(problem) => <li><Show when={problem.path}><code class="t-code code-ltr me-2 font-medium">{problem.path}</code></Show>{problem.message}</li>}</For>
      </ul>
    </Show>
  );
}

/** A page's own heading: one line of title, one of explanation, the page's actions at the end. */
export function PageHead(props: { title: JSX.Element; text?: JSX.Element; actions?: JSX.Element; back?: { href: string; label: string } }): JSX.Element {
  return (
    <header class="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div class="min-w-0 max-w-[46rem]">
        <Show when={props.back}>{(back) => <A href={back().href} class="link mb-2 inline-flex items-center gap-1 t-small no-underline hover:underline"><Icon name="lucide-chevron-left" class="size-3.5 rtl:rotate-180" />{back().label}</A>}</Show>
        <h1 class="t-title text-ink">{props.title}</h1>
        <Show when={props.text}><p class="mt-1.5 t-text text-ink-2">{props.text}</p></Show>
      </div>
      <Show when={props.actions}><div class="flex flex-wrap items-center gap-2">{props.actions}</div></Show>
    </header>
  );
}

export function Section(props: { title: JSX.Element; aside?: JSX.Element; class?: string; children: JSX.Element }): JSX.Element {
  return (
    <section class={props.class ?? "mt-10"}>
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 class="t-head text-ink">{props.title}</h2>
        <Show when={props.aside}><div class="t-small text-ink-3">{props.aside}</div></Show>
      </div>
      {props.children}
    </section>
  );
}

/** An empty place says what belongs here and offers the next action. */
export function Empty(props: { title: string; text?: string; children?: JSX.Element }): JSX.Element {
  return (
    <div class="rounded-2xl border border-dashed border-rule-2 px-6 py-8 text-center">
      <p class="t-text font-medium text-ink">{props.title}</p>
      <Show when={props.text}><p class="mx-auto mt-1 max-w-md t-small text-ink-2">{props.text}</p></Show>
      <Show when={props.children}><div class="mt-4 flex justify-center gap-2">{props.children}</div></Show>
    </div>
  );
}

export const Loading = (): JSX.Element => <p role="status" class="py-10 text-center t-small text-ink-3">{t("common.loading")}</p>;

/** Shows `children` with the data once it is there; the refusal or a quiet wait until then. A newer answer updates the page in place. */
export function Ready<T>(props: { data: T | undefined; error: ApiFailure | undefined; retry?: () => void; children: (data: Accessor<T>) => JSX.Element }): JSX.Element {
  return (
    <Show when={props.data} fallback={<Show when={props.error} fallback={<Loading />}><Failure error={props.error} retry={props.retry} /></Show>}>
      {(data) => props.children(data as Accessor<T>)}
    </Show>
  );
}

/**
 * A list that live data refreshes: rows are kept by their key, so a row a person is typing in, or has focus on, stays the same row
 * when a newer answer arrives.
 */
export function Keyed<T>(props: { each: readonly T[]; by: (item: T) => string | number; children: (item: Accessor<T>) => JSX.Element }): JSX.Element {
  const keys = createMemo(() => props.each.map(props.by), undefined, { equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]) });
  const byKey = createMemo(() => new Map(props.each.map((item) => [props.by(item), item])));
  return (
    <For each={keys()}>
      {(key) => {
        let last = byKey().get(key) as T;
        return props.children(() => (last = byKey().get(key) ?? last));
      }}
    </For>
  );
}

const STATE_ICON: Record<TaskState, string> = { waiting: "lucide-circle-dashed", ready: "lucide-circle-dot-dashed", running: "lucide-loader-circle", needs_you: "lucide-circle-alert", done: "lucide-circle-check", failed: "lucide-circle-x", stopped: "lucide-circle-stop" };
const STATE_TONE: Record<TaskState, string> = { waiting: "text-ink-3", ready: "text-ink-2", running: "text-violet-text", needs_you: "text-needs-text", done: "text-ok", failed: "text-bad", stopped: "text-ink-3" };

/** A task's state as a word with its own shape, so colour is never the only sign. */
export function StateWord(props: { state: TaskState; class?: string }): JSX.Element {
  return (
    <span class={`inline-flex items-center gap-1.5 whitespace-nowrap t-small font-medium ${STATE_TONE[props.state]} ${props.class ?? ""}`}>
      <Icon name={STATE_ICON[props.state]} class="size-4" />
      {stateLabel(props.state)}
    </span>
  );
}

/** Why a task needs a person, as the action it asks for. */
export const needText = (need: TaskNeed): string => t(`need.${need.kind}`);

/** One goal in a list: its state, its title, who is on it, when, and what it cost. */
export function TaskRow(props: { task: TaskSummary; href: string }): JSX.Element {
  const line = (): JSX.Element | undefined => (props.task.needs ? <span class="text-needs-text">{needText(props.task.needs)}</span> : props.task.waitingForYou > 0 ? <span class="text-needs-text">{t("link.needsYou")}</span> : (props.task.createdByName ? t("tasks.by", { name: props.task.createdByName }) : (props.task.agent ?? undefined)));
  return (
    <A href={props.href} class="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 rounded-xl px-3 py-2.5 hover:bg-lilac focus-visible:bg-lilac sm:grid-cols-[7.5rem_minmax(0,1fr)_auto_4.5rem]">
      <StateWord state={shownState(props.task)} class="max-sm:col-span-2" />
      <span class="min-w-0">
        <span class="block truncate t-text font-medium text-ink">{props.task.title}</span>
        <Show when={line()}><span class="block truncate t-small text-ink-3">{line()}</span></Show>
      </span>
      <span class="t-small text-ink-3 max-sm:hidden">{ago(props.task.finishedAt ?? props.task.updatedAt)}</span>
      <span class="text-end t-small tabular-nums text-ink-2">{money(props.task.microUsd)}</span>
    </A>
  );
}

/** A `<details>` that reads as part of the page: used for what a person rarely needs (hashes, raw inputs). */
export function Details(props: { summary: JSX.Element; open?: boolean; class?: string; onOpen?: () => void; children: JSX.Element }): JSX.Element {
  return (
    <details class={props.class} open={props.open} onToggle={(event) => { if (event.currentTarget.open) props.onOpen?.(); }}>
      <summary class="flex cursor-pointer list-none items-center gap-1.5 rounded-md t-small font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <Icon name="lucide-chevron-right" class="details-mark size-3.5" />
        {props.summary}
      </summary>
      <div class="mt-2">{props.children}</div>
    </details>
  );
}

/** A block of real code or file content. */
export const Code = (props: { text: string; class?: string }): JSX.Element => <pre class={`t-code code-ltr max-h-80 overflow-auto rounded-xl bg-lilac px-3.5 py-3 text-ink ${props.class ?? ""}`}>{props.text}</pre>;

/** A confirm-and-cancel pair for something that cannot be undone. */
export function ConfirmButton(props: { label: string; confirm: string; busy?: boolean; onConfirm: () => void; icon?: string }): JSX.Element {
  let dialog: HTMLDialogElement | undefined;
  return (
    <>
      <Button variant="ghost" theme="red" size="md" iconLeft={props.icon} loading={props.busy} onClick={() => dialog?.showModal()}>{props.label}</Button>
      <dialog ref={dialog} class="m-auto max-w-sm rounded-2xl border border-rule bg-sheet p-6 text-ink backdrop:bg-surface-scrim">
        <p class="t-text">{props.confirm}</p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => dialog?.close()}>{t("action.cancel")}</Button>
          <Button variant="solid" theme="red" size="md" onClick={() => { dialog?.close(); props.onConfirm(); }}>{props.label}</Button>
        </div>
      </dialog>
    </>
  );
}
