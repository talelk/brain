import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Switch, TextInput } from "@talelk/newui-atoms";
import type { CommandRequest, InputSpec, JsonValue, PlayFile } from "@brain/contracts";
import { command, useAction } from "../data/api";
import { usePlace } from "../data/session";
import { t } from "../i18n";
import { Failure, Icon } from "./bits";

type Plays = Readonly<Record<string, PlayFile>>;

/** A typed value as the Play input it is for: text stays text, a number becomes a number, a list or an object is read as JSON. */
function inputValue(spec: InputSpec, text: string): JsonValue {
  if (spec.type === "string") return text;
  if (spec.type === "number" || spec.type === "integer") return Number(text);
  if (spec.type === "boolean") return text === "true";
  return JSON.parse(text) as JsonValue;
}

/**
 * The goal box: type what you want done and start it. Picking a Play turns the box into that Play's inputs; a Play with one text input
 * uses the big field for it, so starting "Fix an issue" is still just typing the issue.
 */
export function GoalBox(props: { plays: Plays; play?: string; autofocus?: boolean }): JSX.Element {
  const place = usePlace();
  const navigate = useNavigate();
  const [goal, setGoal] = createSignal("");
  const [play, setPlay] = createSignal<string | undefined>(props.play);
  const [values, setValues] = createSignal<Record<string, string>>({});
  let field: HTMLTextAreaElement | undefined;
  createEffect(() => { if (props.autofocus) field?.focus(); });

  const chosen = (): PlayFile | undefined => { const name = play(); return name ? props.plays[name] : undefined; };
  const inputs = (): Array<[string, InputSpec]> => Object.entries(chosen()?.inputs ?? {});
  /** The one text input the big field stands for, if the Play has exactly one. */
  const main = (): string | undefined => { const all = inputs(); return all.length === 1 && all[0]?.[1].type === "string" ? all[0][0] : undefined; };
  const ready = (): boolean => {
    if (!chosen()) return goal().trim() !== "";
    if (main()) return goal().trim() !== "" || !inputs()[0]?.[1].required;
    return inputs().every(([name, spec]) => !spec.required || (values()[name] ?? "").trim() !== "" || spec.type === "boolean");
  };
  const start = useAction(async () => {
    const name = play();
    const single = main();
    const playInputs: Record<string, JsonValue> = {};
    if (name && single) playInputs[single] = goal().trim();
    else if (name) for (const [input, spec] of inputs()) { const text = (values()[input] ?? "").trim(); if (text !== "" || spec.type === "boolean") playInputs[input] = inputValue(spec, text); }
    const { taskId } = await command("task.create", name ? { workspaceId: place.id(), play: name, inputs: playInputs as CommandRequest<"task.create">["inputs"] } : { workspaceId: place.id(), goal: goal().trim() });
    navigate(place.to(`/tasks/${taskId}`));
  });
  const submit = (): void => { if (ready() && place.can("member")) void start.run(); };
  const pick = (name: string | undefined): void => { setPlay(name); setValues({}); start.clear(); field?.focus(); };

  return (
    <div>
      <form class="goal-box px-5 pb-4 pt-5 sm:px-7 sm:pt-6" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Show when={chosen()}>
          {(file) => (
            <div class="mb-3 flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <p class="t-text font-semibold text-ink">{file().title}</p>
                <p class="t-small text-ink-2">{file().description}</p>
              </div>
              <button type="button" class="rounded-full p-1.5 text-ink-3 hover:bg-lilac hover:text-ink" aria-label={t("goal.play.clear")} onClick={() => pick(undefined)}><Icon name="lucide-x" /></button>
            </div>
          )}
        </Show>
        <Show when={!chosen() || main()} fallback={
          <div class="flex flex-col gap-3 pb-2">
            <For each={inputs()}>
              {([name, spec]) => (
                <Show when={spec.type === "boolean"} fallback={
                  <TextInput size="md" label={name} description={spec.description || (spec.type === "array" || spec.type === "object" ? t("goal.input.json") : undefined)} required={spec.required} type={spec.type === "number" || spec.type === "integer" ? "number" : "text"}
                    value={values()[name] ?? ""} onInput={(event) => setValues({ ...values(), [name]: event.currentTarget.value })} />
                }>
                  <Switch label={name} description={spec.description} checked={values()[name] === "true"} onCheckedChange={(on) => setValues({ ...values(), [name]: String(on) })} />
                </Show>
              )}
            </For>
            <Show when={inputs().length === 0}><p class="t-small text-ink-2">{t("goal.play.noInputs")}</p></Show>
          </div>
        }>
          <textarea ref={field} class="t-goal block w-full bg-transparent text-ink" rows={2} dir={goal() === "" ? undefined : "auto"} value={goal()} disabled={!place.can("member")}
            aria-label={main() ?? t("goal.label")} placeholder={main() ? inputs()[0]?.[1].description || t("goal.play.placeholder", { name: main() ?? "" }) : t("goal.placeholder")}
            onInput={(event) => setGoal(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} />
        </Show>
        <div class="mt-2 flex items-center justify-between gap-3">
          <p class="t-small text-ink-3">{place.can("member") ? (chosen() ? t("goal.hint.play") : t("goal.hint")) : t("goal.viewer")}</p>
          <Button type="submit" variant="solid" theme="blue" size="lg" class="rounded-full! px-6!" loading={start.busy()} disabled={!ready() || !place.can("member")}>{t("goal.start")}</Button>
        </div>
      </form>
      <Failure error={start.error()} class="mt-3" />
      <Show when={!chosen() && Object.keys(props.plays).length > 0}>
        <div class="-mx-4 mt-4 flex items-center gap-2 overflow-x-auto px-4 py-1 sm:mx-0 sm:flex-wrap sm:px-0">
          <span class="me-1 shrink-0 t-small text-ink-3">{t("goal.plays")}</span>
          <For each={Object.entries(props.plays)}>
            {([name, file]) => <button type="button" title={file.description} class="shrink-0 rounded-full border border-rule-2 bg-sheet px-3.5 py-1.5 t-small font-medium text-ink hover:border-violet hover:text-violet-text" onClick={() => pick(name)}>{file.title}</button>}
          </For>
        </div>
      </Show>
    </div>
  );
}
