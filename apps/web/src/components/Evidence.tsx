import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js";
import type { Attempt, AttemptEvent, Task, ToolCall } from "@brain/contracts";
import { artifactUrl, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { t, tn } from "../i18n";
import { dateTime, show } from "../lib/format";
import { ArtifactDiff } from "./Diff";
import { tableOf, viewOf, type View } from "../lib/toolview";
import { Code, Details, Failure, Grid, Keyed, Loading } from "./bits";
import { Outputs } from "./Outputs";

const OUTCOME_TONE: Record<ToolCall["outcome"], string> = { succeeded: "text-ok", failed: "text-bad", rejected: "text-bad", held: "text-needs-text", pending: "text-needs-text" };

/** A value inside a card: short text stays inline, a list of objects is a table, a long or multi-line text or anything else nested is a block. */
function Value(props: { value: unknown }): JSX.Element {
  const text = (): string => (typeof props.value === "string" ? props.value : props.value === null || props.value === undefined ? "" : typeof props.value === "object" ? JSON.stringify(props.value, null, 2) : String(props.value));
  const grid = () => { const view = Array.isArray(props.value) ? tableOf(props.value) : null; return view?.kind === "table" ? view : null; };
  return (
    <Show when={grid()} fallback={
      <Show when={text().length > 120 || text().includes("\n") || typeof props.value === "object"} fallback={<span class="break-words">{text()}</span>}>
        <pre class="t-code code-ltr max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-lilac px-2.5 py-2 text-ink">{text()}</pre>
      </Show>}>
      {(view) => <Grid header={view().header} rows={view().rows} />}
    </Show>
  );
}

function Fields(props: { fields: readonly (readonly [string, unknown])[] }): JSX.Element {
  return (
    <dl class="grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-rule px-3.5 py-3 t-small">
      <For each={props.fields}>{([key, value]) => <><dt class="font-medium text-ink-3 code-ltr">{key}</dt><dd class="min-w-0 text-ink"><Value value={value} /></dd></>}</For>
    </dl>
  );
}

/** A tool's output as a person wants to read it: a failure called out, an object as a card, a list as a table; the raw text stays one click away. */
function Output(props: { text: string }): JSX.Element {
  const [raw, setRaw] = createSignal(false);
  const view = createMemo(() => viewOf(props.text));
  return (
    <div class="flex flex-col gap-2">
      <Show when={!raw()} fallback={<Code text={props.text} />}>
        <Switch fallback={<Code text={props.text} />}>
          <Match when={view().kind === "error" ? (view() as Extract<View, { kind: "error" }>) : null}>
            {(v) => <div class="flex flex-col gap-2"><p class="rounded-xl bg-bad-soft px-3.5 py-2.5 t-small font-medium text-bad">{v().message}</p><Show when={v().rest.length > 0}><Fields fields={v().rest} /></Show></div>}
          </Match>
          <Match when={view().kind === "fields" ? (view() as Extract<View, { kind: "fields" }>) : null}>{(v) => <Fields fields={v().fields} />}</Match>
          <Match when={view().kind === "table" ? (view() as Extract<View, { kind: "table" }>) : null}>{(v) => <Grid header={v().header} rows={v().rows} />}</Match>
        </Switch>
      </Show>
      <Show when={view().kind !== "text"}><button type="button" class="self-start t-small text-ink-3 underline-offset-2 hover:text-ink hover:underline" aria-pressed={raw()} onClick={() => setRaw(!raw())}>{raw() ? t("evidence.formatted") : t("evidence.raw")}</button></Show>
    </div>
  );
}

function Call(props: { name: string; meta: string; outcome: string; tone: string; input: string; output: string | null }): JSX.Element {
  return (
    <Details class="border-b border-rule py-2 last:border-b-0"
      summary={<><code class="t-code code-ltr shrink-0 font-medium text-ink">{props.name}</code><span class="min-w-0 truncate font-normal text-ink-3 max-sm:hidden">{props.meta}</span><span class={`ms-auto whitespace-nowrap ps-2 ${props.tone}`}>{props.outcome}</span></>}>
      <div class="flex flex-col gap-2 pb-1">
        <div><p class="mb-1 t-small text-ink-3">{t("evidence.input")}</p><Output text={props.input} /></div>
        <Show when={props.output !== null}><div><p class="mb-1 t-small text-ink-3">{t("evidence.output")}</p><Output text={props.output ?? ""} /></div></Show>
      </div>
    </Details>
  );
}

/** What the engine's own tools did during one run: read, search, edit, shell. Loaded when the person opens it. */
function Activity(props: { attempt: Attempt }): JSX.Element {
  const place = usePlace();
  const events = useQuery("task.events", () => ({ workspaceId: place.id(), taskId: props.attempt.taskId, attemptId: props.attempt.id, limit: 1000 }));
  const calls = createMemo(() => {
    const all = events.data()?.events ?? [];
    const results = new Map(all.flatMap((event) => (event.kind === "native.result" ? [[event.callId, event] as const] : [])));
    return all.flatMap((event: AttemptEvent) => (event.kind === "native.call" ? [{ call: event, result: results.get(event.callId) }] : []));
  });
  return (
    <Show when={events.data()} fallback={<Show when={events.error()} fallback={<Loading />}><Failure error={events.error()} /></Show>}>
      <Show when={calls().length > 0} fallback={<p class="t-small text-ink-3">{t("evidence.native.none")}</p>}>
        <For each={calls()}>
          {(entry) => <Call name={entry.call.name} meta={show(entry.call.input).replace(/\s+/gu, " ").slice(0, 80)} tone={entry.result ? (entry.result.ok ? "text-ok" : "text-bad") : "text-ink-3"}
            outcome={entry.result ? (entry.result.ok ? t("outcome.succeeded") : t("outcome.failed")) : t("outcome.pending")} input={show(entry.call.input)} output={entry.result ? entry.result.output : null} />}
        </For>
      </Show>
    </Show>
  );
}

/** The evidence of a task: every tool call with its input and output, what the native tools did, the files produced and the diff. */
export function Evidence(props: { task: Task }): JSX.Element {
  const [opened, setOpened] = createSignal<readonly string[]>([]);
  const runs = (): Attempt[] => props.task.attempts.filter((attempt) => attempt.kind === "work" || attempt.kind === "plan");
  const files = () => props.task.artifacts.filter((artifact) => artifact.kind === "output");
  const patch = () => props.task.artifacts.filter((artifact) => artifact.kind === "patch").at(-1);
  const empty = (): boolean => props.task.toolCalls.length === 0 && runs().length === 0 && files().length === 0 && !patch();
  return (
    <Show when={!empty()} fallback={<p class="t-small text-ink-3">{t("evidence.none")}</p>}>
      <div class="flex flex-col gap-5">
        <Show when={props.task.toolCalls.length > 0}>
          <div>
            <h4 class="mb-1 t-small font-semibold text-ink-2">{tn("evidence.calls", props.task.toolCalls.length)}</h4>
            <Keyed each={props.task.toolCalls} by={(call) => call.id}>
              {(call) => <Call name={call().tool} meta={`${t(`effect.${call().effect}`)}, ${dateTime(call().at)}`} outcome={t(`outcome.${call().outcome}`)} tone={OUTCOME_TONE[call().outcome]} input={show(call().input)} output={call().output === null ? null : show(call().output)} />}
            </Keyed>
          </div>
        </Show>
        <Show when={runs().length > 0}>
          <div>
            <h4 class="mb-1 t-small font-semibold text-ink-2">{t("evidence.native")}</h4>
            <Keyed each={runs()} by={(attempt) => attempt.id}>
              {(attempt) => (
                <Details class="border-b border-rule py-2 last:border-b-0" open={attempt().state === "running"} onOpen={() => setOpened([...opened(), attempt().id])} summary={<span class="font-normal text-ink">{t("evidence.native.run", { n: runs().indexOf(attempt()) + 1, agent: attempt().agent })}</span>}>
                  <Show when={opened().includes(attempt().id)}><Activity attempt={attempt()} /></Show>
                </Details>
              )}
            </Keyed>
          </div>
        </Show>
        <Show when={files().length > 0}>
          <div>
            <h4 class="mb-1 t-small font-semibold text-ink-2">{t("evidence.files")}</h4>
            <Outputs files={files().map((file) => ({ name: file.name, bytes: file.bytes, url: artifactUrl(file.digest) }))} />
          </div>
        </Show>
        <Show when={files().length === 0 && !patch() && props.task.attempts.some((attempt) => attempt.kind === "work" && attempt.state === "succeeded")}>
          <p class="t-small text-ink-3">{t("evidence.nothingKept")}</p>
        </Show>
        <Show when={patch()}>
          {(artifact) => <div><h4 class="mb-2 t-small font-semibold text-ink-2">{t("evidence.diff")}</h4><ArtifactDiff digest={artifact().digest} /></div>}
        </Show>
      </div>
    </Show>
  );
}
