import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { Attempt, AttemptEvent, Task, ToolCall } from "@brain/contracts";
import { artifactUrl, useQuery } from "../data/api";
import { usePlace } from "../data/session";
import { t, tn } from "../i18n";
import { bytes, dateTime, show } from "../lib/format";
import { ArtifactDiff } from "./Diff";
import { Code, Details, Failure, Icon, Keyed, Loading } from "./bits";

const OUTCOME_TONE: Record<ToolCall["outcome"], string> = { succeeded: "text-ok", failed: "text-bad", rejected: "text-bad", held: "text-needs-text", pending: "text-needs-text" };

function Call(props: { name: string; meta: string; outcome: string; tone: string; input: string; output: string | null }): JSX.Element {
  return (
    <Details class="border-b border-rule py-2 last:border-b-0"
      summary={<><code class="t-code code-ltr shrink-0 font-medium text-ink">{props.name}</code><span class="min-w-0 truncate font-normal text-ink-3 max-sm:hidden">{props.meta}</span><span class={`ms-auto whitespace-nowrap ps-2 ${props.tone}`}>{props.outcome}</span></>}>
      <div class="flex flex-col gap-2 pb-1">
        <div><p class="mb-1 t-small text-ink-3">{t("evidence.input")}</p><Code text={props.input} /></div>
        <Show when={props.output !== null}><div><p class="mb-1 t-small text-ink-3">{t("evidence.output")}</p><Code text={props.output ?? ""} /></div></Show>
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
            <ul>
              <For each={files()}>
                {(file) => <li class="flex items-center gap-2 border-b border-rule py-2 last:border-b-0"><Icon name="lucide-file-text" class="size-4 text-ink-3" /><a class="link t-code code-ltr min-w-0 truncate" href={artifactUrl(file.digest)} target="_blank" rel="noreferrer">{file.name}</a><span class="ms-auto t-small text-ink-3">{bytes(file.bytes)}</span></li>}
              </For>
            </ul>
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
