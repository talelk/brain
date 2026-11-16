import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import { Button, Icon as GlyphIcon, Skeleton } from "@talelk/newui-atoms";
import { Alert, Dialog, ItemListRow } from "@talelk/newui-molecules";
import type { Problem, TaskNeed, TaskState, TaskSummary } from "@brain/contracts";
import type { ApiFailure } from "../data/api";
import { t, tKey } from "../i18n";
import { ago, money, shownState, stateLabel } from "../lib/format";

/** The small pieces every screen is made of. An icon is named by its full `lucide-*` class so the stylesheet build can see it. */

export const Icon = (props: { name: string; class?: string }): JSX.Element => <GlyphIcon icon={props.name} class={`shrink-0 ${props.class ?? "size-4"}`} />;

/** What went wrong, in the interface's words, then the Governor's own sentence when it sent one. */
export function failureText(failure: ApiFailure): string {
  const known = tKey(`error.${failure.code}`, "");
  // For these the interface's sentence says it all; the Governor's would repeat it.
  const enough = failure.code === "INVALID_WORKSPACE" || failure.code === "STALE_VERSION";
  return [known, enough && known !== "" ? "" : failure.message].filter((part) => part !== "").join(" ") || t("error.unknown");
}

/** Each thing to fix, with the file or the field it names. */
export function Problems(props: { problems: readonly Problem[] }): JSX.Element {
  return (
    <Show when={props.problems.length > 0}>
      <ul class="mt-1 flex flex-col gap-1 t-small">
        <For each={props.problems}>{(problem) => <li><Show when={problem.path}><code class="t-code code-ltr me-2 font-medium">{problem.path}</code></Show>{problem.message}</li>}</For>
      </ul>
    </Show>
  );
}

/** A refusal shown where it happened. `problems` replaces the refusal's own list when the screen shows some of them elsewhere. */
export function Failure(props: { error: ApiFailure | undefined; retry?: () => void; class?: string; problems?: readonly Problem[] }): JSX.Element {
  return (
    <Show when={props.error}>
      {(error) => (
        <Alert theme="red" class={props.class} title={failureText(error())} {...(props.retry ? { action: { label: t("action.retry"), onClick: () => props.retry?.() } } : {})}>
          <Problems problems={props.problems ?? error().problems} />
        </Alert>
      )}
    </Show>
  );
}

export const Loading = (): JSX.Element => <div role="status" aria-label={t("common.loading")} class="flex flex-col gap-2 py-4"><Skeleton lines={3} /></div>;

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
export function StateWord(props: { state: TaskState; class?: string; iconOnlyOnPhone?: boolean }): JSX.Element {
  return (
    <span class={`inline-flex items-center gap-1.5 whitespace-nowrap t-small font-medium ${STATE_TONE[props.state]} ${props.class ?? ""}`}>
      <Icon name={STATE_ICON[props.state]} />
      <span class={props.iconOnlyOnPhone ? "max-sm:sr-only" : ""}>{stateLabel(props.state)}</span>
    </span>
  );
}

/** The orange mark of "needs you": the open link of the chain. Orange means exactly this, everywhere. */
export const NeedsMark = (props: { class?: string }): JSX.Element => <span class={`inline-block h-[1.0625rem] w-[0.6875rem] shrink-0 rounded-full border-[2.5px] border-needs-mark ${props.class ?? ""}`} aria-hidden="true" />;

/** A count of what waits for the person, as a small orange pill. Zero shows nothing. */
export function NeedsCount(props: { n: number; class?: string }): JSX.Element {
  return <Show when={props.n > 0}><span class={`inline-flex min-w-5 items-center justify-center rounded-full bg-needs px-1.5 text-[0.6875rem] font-semibold leading-[1.125rem] text-(--on-needs) ${props.class ?? ""}`}><span class="sr-only">{t("nav.needsYou")} </span>{props.n}</span></Show>;
}

/** Why a task needs a person, as the action it asks for. */
export const needText = (need: TaskNeed): string => t(`need.${need.kind}`);

/** One goal in a list: its state, its title, who is on it, when, and what it cost. */
export function TaskRow(props: { task: TaskSummary; href: string; where?: string }): JSX.Element {
  const line = (): JSX.Element | undefined => (props.task.needs ? <span class="text-needs-text">{needText(props.task.needs)}</span> : props.task.waitingForYou > 0 ? <span class="text-needs-text">{t("link.needsYou")}</span> : (props.task.createdByName ? t("tasks.by", { name: props.task.createdByName }) : (props.task.agent ?? undefined)));
  return (
    <ItemListRow as="a" href={props.href} size="lg" class="gap-3 hover:bg-surface-gray-2"
      prefix={<span class="w-28 max-sm:w-5"><StateWord state={shownState(props.task)} iconOnlyOnPhone /></span>}
      suffix={<span class="flex items-center gap-4 t-small text-ink-3"><span class="max-sm:hidden">{ago(props.task.finishedAt ?? props.task.updatedAt)}</span><span class="w-16 text-end tabular-nums text-ink-2">{money(props.task.microUsd)}</span></span>}>
      <span class="block truncate t-text font-medium text-ink" dir="auto">{props.task.title}</span>
      <Show when={line() ?? props.where}><span class="block truncate t-small text-ink-3">{props.where ? <>{props.where}<Show when={line()}> · </Show></> : null}{line()}</span></Show>
    </ItemListRow>
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

/** A confirm-and-cancel dialog for something that cannot be undone. */
export function ConfirmButton(props: { label: string; confirm: string; busy?: boolean; onConfirm: () => void; icon?: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <Button variant="ghost" theme="red" size="md" iconLeft={props.icon} loading={props.busy} onClick={() => setOpen(true)}>{props.label}</Button>
      <Dialog.Root open={open()} onOpenChange={setOpen}>
        <Dialog.Content size="sm">
          <Dialog.Header><Dialog.Title>{props.label}</Dialog.Title><Dialog.Description>{props.confirm}</Dialog.Description></Dialog.Header>
          <Dialog.Footer actions={[{ label: t("action.cancel"), variant: "ghost" }, { label: props.label, variant: "solid", theme: "red", onClick: ({ close }) => { close(); props.onConfirm(); } }]} />
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
