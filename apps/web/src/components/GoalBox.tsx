import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, Switch, TextInput } from "@talelk/newui-atoms";
import type { CommandRequest, InputSpec, JsonValue, PlayFile } from "@brain/contracts";
import { command, useAction } from "../data/api";
import { usePlace } from "../data/session";
import { human, t } from "../i18n";
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
export function GoalBox(props: { plays: Plays; play?: string; autofocus?: boolean; noModel?: boolean }): JSX.Element {
  const place = usePlace();
  const navigate = useNavigate();
  const [goal, setGoal] = createSignal("");
  const [play, setPlay] = createSignal<string | undefined>(props.play);
  const [values, setValues] = createSignal<Record<string, string>>({});
  let field: HTMLTextAreaElement | undefined;
  createEffect(() => { if (props.autofocus) field?.focus(); });

  const chosen = (): PlayFile | undefined => { const name = play(); return name ? props.plays[name] : undefined; };
  const inputs = (): Array<[string, InputSpec]> => Object.entries(chosen()?.inputs ?? {});
  const inputText = (name: string, spec: InputSpec): string => human(chosen()?.translations, ["inputs", name, "description"], spec.description);
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
    <section aria-labelledby="goal-title">
      <h2 id="goal-title" class="mb-3 t-title text-ink">{t("today.title")}</h2>
      <form class="goal-box px-5 pb-4 pt-4 sm:px-6 sm:pt-5" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Show when={chosen()}>
          {(file) => (
            <div class="mb-3 flex items-start gap-3">
              <div class="min-w-0 flex-1">
                <p class="t-text font-semibold text-ink" dir="auto">{human(file().translations, ["title"], file().title)}</p>
                <p class="t-small text-ink-2" dir="auto">{human(file().translations, ["description"], file().description)}</p>
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
                  <TextInput size="md" label={name} description={inputText(name, spec) || (spec.type === "array" || spec.type === "object" ? t("goal.input.json") : undefined)} required={spec.required} type={spec.type === "number" || spec.type === "integer" ? "number" : "text"}
                    value={values()[name] ?? ""} onInput={(event) => setValues({ ...values(), [name]: event.currentTarget.value })} />
                }>
                  <Switch label={name} description={inputText(name, spec)} checked={values()[name] === "true"} onCheckedChange={(on) => setValues({ ...values(), [name]: String(on) })} />
                </Show>
              )}
            </For>
            <Show when={inputs().length === 0}><p class="t-small text-ink-2">{t("goal.play.noInputs")}</p></Show>
          </div>
        }>
          <textarea ref={field} class="t-goal block w-full bg-transparent text-ink" rows={2} dir={goal() === "" ? undefined : "auto"} value={goal()} disabled={!place.can("member")}
            aria-label={main() ?? t("goal.label")} placeholder={main() ? inputText(inputs()[0]?.[0] ?? "", inputs()[0]?.[1] as InputSpec) || t("goal.play.placeholder", { name: main() ?? "" }) : t("goal.placeholder")}
            onInput={(event) => setGoal(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} />
        </Show>
        <Show when={props.noModel && place.can("member")}>
          <p class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control bg-needs-soft px-3 py-2 t-small text-needs-text" role="status" data-testid="goal-nomodel">
            <Icon name="lucide-plug-zap" /><span>{t("goal.nomodel")}</span>
            <button type="button" class="font-medium underline" onClick={() => document.getElementById("first-run")?.scrollIntoView({ behavior: "smooth", block: "start" })}>{t("goal.nomodel.action")}</button>
          </p>
        </Show>
        <div class="mt-2 flex items-center justify-between gap-3">
          <p class="t-small text-ink-3">{place.can("member") ? (chosen() ? t("goal.hint.play") : t("goal.hint")) : t("goal.viewer")}</p>
          <Button type="submit" variant="solid" theme="blue" size="lg" loading={start.busy()} disabled={!ready() || !place.can("member")}>{t("goal.start")}</Button>
        </div>
      </form>
      <Failure error={start.error()} class="mt-3" />
      <Show when={!chosen() && Object.keys(props.plays).length > 0}>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <span class="me-1 shrink-0 t-small text-ink-3">{t("goal.plays")}</span>
          <For each={Object.entries(props.plays)}>
            {([name, file]) => <Button variant="outline" size="md" iconLeft="lucide-play" title={human(file.translations, ["description"], file.description)} onClick={() => pick(name)}><bdi>{human(file.translations, ["title"], file.title)}</bdi></Button>}
          </For>
        </div>
      </Show>
    </section>
  );
}
