import { createEffect, createSignal, For, on, Show, type Accessor, type JSX } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { Button, Switch, Textarea, TextInput } from "@talelk/newui-atoms";
import { Select, toast } from "@talelk/newui-molecules";
import type { AgentFile, InputSpec, PlayFile, Problem, SnapshotManifest, StepSpec, ToolFile } from "@brain/contracts";
import { ApiFailure, command, useAction, useQuery, type Action } from "../data/api";
import { usePlace, useSession } from "../data/session";
import { said } from "../lib/said";
import { t } from "../i18n";
import { agentToml, brainOf, brainToml, paths, playToml, toolToml, type Brain, type Model, type Project } from "../lib/files";
import { EFFECTS, ENGINES, NATIVE_LEVELS, slugify } from "../lib/model";
import { onGithub, projectNameOf } from "../lib/repo";
import { CodeEditor } from "./CodeEditor";
import { Choice, ListField, NumberField, PickMany, Rows } from "./fields";
import { Markdown } from "./Markdown";
import { Details, Failure, PushStatus } from "./bits";
import { ScheduleEditor } from "./Schedule";

/** The forms of the Workspace screen. Each starts from the active snapshot, and saving writes whole files through `file.write`. */

export interface FileDraft { readonly path: string; readonly content: string }
export type Write = Action<[files: readonly FileDraft[], message: string]>;

/** Saving files: one commit, a short confirmation, or the refusal with each problem. */
export function useWrite(done?: () => void): Write {
  const place = usePlace();
  return useAction(async (files: readonly FileDraft[], message: string) => {
    await command("file.write", { workspaceId: place.id(), files: [...files], message });
    toast.success({ title: t("workspace.saved") });
    done?.();
  });
}

/** The problems of a refused save that are not about `shown`, each with the file it names. */
const elsewhere = (problems: readonly Problem[], shown: readonly string[]): Problem[] => problems.filter((problem) => !shown.includes(problem.path));
export const problemsOf = (write: Write, path: string): Problem[] => (write.error()?.problems ?? []).filter((problem) => problem.path === path);

export function SaveBar(props: { write: Write; onSave: () => void; shown?: readonly string[]; disabled?: boolean; label?: string }): JSX.Element {
  return (
    <div class="mt-6 flex flex-col gap-3 border-t border-rule pt-5">
      <Failure error={props.write.error()} problems={elsewhere(props.write.error()?.problems ?? [], props.shown ?? [])} />
      <div><Button variant="solid" theme="blue" size="md" loading={props.write.busy()} disabled={props.disabled} onClick={props.onSave}>{props.label ?? t("action.save")}</Button></div>
    </div>
  );
}

const Group = (props: { title: string; text?: string; children: JSX.Element }): JSX.Element => (
  <section class="border-t border-rule py-6 first:border-t-0 first:pt-0">
    <h3 class="t-head text-ink">{props.title}</h3>
    <Show when={props.text}><p class="mt-1 max-w-[62ch] t-small text-ink-2">{props.text}</p></Show>
    <div class="mt-4 flex flex-col gap-4">{props.children}</div>
  </section>
);
const Problems = (props: { items: readonly Problem[] }): JSX.Element => <Show when={props.items.length > 0}><ul class="flex flex-col gap-1 rounded-xl bg-bad-soft px-4 py-3 t-small text-bad" role="alert"><For each={props.items}>{(problem) => <li>{said(problem.message)}</li>}</For></ul></Show>;

/** Markdown with a preview: a prompt, a memory entry. */
export function MarkdownEditor(props: { value: string; onChange: (value: string) => void; label: string; problems?: readonly Problem[]; readOnly?: boolean }): JSX.Element {
  const [preview, setPreview] = createSignal(false);
  return (
    <div>
      <div class="mb-2 flex items-center justify-between gap-3">
        <span class="t-small font-medium text-ink-2">{props.label}</span>
        <button type="button" class="link t-small" aria-pressed={preview()} onClick={() => setPreview(!preview())}>{preview() ? t("editor.write") : t("editor.preview")}</button>
      </div>
      <Show when={preview()} fallback={<CodeEditor value={props.value} onChange={props.onChange} label={props.label} problems={props.problems} readOnly={props.readOnly} rows={14} wrap />}>
        <div class="rounded-xl border border-rule-2 bg-sheet p-5"><Markdown text={props.value} /></div>
      </Show>
    </div>
  );
}

/** A file's text, read once, then the person's own draft of it. */
function useFileText(path: Accessor<string>, fallback: string, skip: boolean): [Accessor<string | undefined>, (text: string) => void, Accessor<ApiFailure | undefined>] {
  const place = usePlace();
  const [text, setText] = createSignal<string | undefined>(skip ? fallback : undefined);
  const read = useQuery("file.read", () => (skip ? undefined : { workspaceId: place.id(), path: path() }));
  createEffect(on(() => read.data() ?? (read.error()?.code === "NOT_FOUND" ? { content: fallback } : undefined), (file) => { if (file && text() === undefined) setText(file.content); }));
  /** A read that failed for a reason other than "no such file yet": shown instead of a loading line that never ends. */
  const failed = (): ApiFailure | undefined => (text() === undefined && read.error()?.code !== "NOT_FOUND" ? read.error() : undefined);
  return [text, setText, failed];
}

type Sourced<T> = T & { readonly source?: string };
const strip = <T extends object>(value: Sourced<T>): T => { const { source: _source, ...rest } = unwrap(value) as Sourced<T> & Record<string, unknown>; return rest as unknown as T; };
const names = (record: Readonly<Record<string, unknown>>): { label: string; value: string }[] => Object.keys(record).map((name) => ({ label: name, value: name }));

export function AgentForm(props: { name: string; initial: AgentFile; isNew: boolean; snapshot: SnapshotManifest; readOnly: boolean; onSaved: () => void }): JSX.Element {
  const [agent, setAgent] = createStore<AgentFile>(structuredClone(strip(props.initial)));
  const [prompt, setPrompt, promptError] = useFileText(() => paths.prompt(props.name), `# ${props.name}\n\n`, props.isNew);
  const write = useWrite(props.onSaved);
  const save = (): void => { const text = prompt(); if (text === undefined) return; void write.run([{ path: paths.agent(props.name), content: agentToml(unwrap(agent)) }, { path: paths.prompt(props.name), content: text }], `${props.isNew ? "Add" : "Change"} the agent ${props.name}`); };
  const engines = (): string[] => [...new Set([...ENGINES, ...agent.engine])];
  return (
    <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <Group title={t("agent.what")}>
        <Problems items={problemsOf(write, paths.agent(props.name))} />
        <Textarea size="md" label={t("field.description")} description={t("agent.description.help")} rows={2} value={agent.description} onInput={(event) => setAgent("description", event.currentTarget.value)} required disabled={props.readOnly} />
        <PickMany label={t("agent.engines")} description={t("agent.engines.help")} options={engines().map((name) => ({ value: name, label: name }))} value={agent.engine} onChange={(value) => setAgent("engine", value)} disabled={props.readOnly} />
        <Show when={props.snapshot.models.length > 1}>
          <Select size="md" label={t("agent.model")} description={t("agent.model.help")} options={[{ label: t("agent.model.default"), value: "" }, ...props.snapshot.models.map((model) => ({ label: `${model.name} (${model.model})`, value: model.name }))]} value={agent.model ?? ""} onValueChange={(value) => setAgent("model", value || undefined)} disabled={props.readOnly} />
        </Show>
      </Group>
      <Group title={t("agent.tools")} text={t("agent.tools.text")}>
        <Choice label={t("agent.native")} value={agent.native} onChange={(value) => setAgent("native", value)} disabled={props.readOnly} options={NATIVE_LEVELS.map((level) => ({ value: level, label: t(`agent.native.${level}`), help: t(`agent.native.${level}.help`) }))} />
        <PickMany label={t("agent.workspaceTools")} options={Object.entries(props.snapshot.tools).map(([name, tool]) => ({ value: name, label: name, help: t(`effect.${tool.effect}`) }))} value={agent.tools} onChange={(value) => setAgent("tools", value)} disabled={props.readOnly} />
      </Group>
      <Group title={t("agent.limits")} text={t("agent.limits.text")}>
        <div class="grid gap-4 sm:grid-cols-3">
          <NumberField label={t("agent.limits.turns")} description={t("field.zeroNoCap")} min={0} step={1} value={agent.limits.turns} onChange={(value) => setAgent("limits", "turns", value ?? 0)} disabled={props.readOnly} />
          <NumberField label={t("agent.limits.tokens")} description={t("field.zeroNoCap")} min={0} step={1000} value={agent.limits.tokens} onChange={(value) => setAgent("limits", "tokens", value ?? 0)} disabled={props.readOnly} />
          <NumberField label={t("agent.limits.spend")} description={t("field.zeroNoCap")} min={0} value={agent.limits.spend_usd} onChange={(value) => setAgent("limits", "spend_usd", value ?? 0)} disabled={props.readOnly} />
        </div>
      </Group>
      <Group title={t("agent.prompt")} text={t("agent.prompt.text")}>
        <Show when={prompt() !== undefined} fallback={<Show when={promptError()} fallback={<p class="t-small text-ink-3">{t("common.loading")}</p>}><Failure error={promptError()} /></Show>}>
          <MarkdownEditor label={paths.prompt(props.name)} value={prompt() ?? ""} onChange={setPrompt} problems={problemsOf(write, paths.prompt(props.name))} readOnly={props.readOnly} />
        </Show>
      </Group>
      <Show when={!props.readOnly}><SaveBar write={write} onSave={save} shown={[paths.agent(props.name), paths.prompt(props.name)]} disabled={prompt() === undefined} /></Show>
    </form>
  );
}

interface InputRow { name: string; spec: InputSpec }
const INPUT_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;
const toRows = (inputs: Readonly<Record<string, InputSpec>>): InputRow[] => Object.entries(inputs).map(([name, spec]) => ({ name, spec }));
const fromRows = (rows: readonly InputRow[]): Record<string, InputSpec> => Object.fromEntries(rows.filter((row) => row.name !== "").map((row) => [row.name, row.spec]));

function InputRows(props: { label: string; rows: readonly InputRow[]; onChange: (rows: InputRow[]) => void; readOnly: boolean }): JSX.Element {
  return (
    <Rows label={props.label} items={props.rows} onChange={props.onChange} add={t("inputs.add")} disabled={props.readOnly} blank={(): InputRow => ({ name: "", spec: { type: "string", description: "", required: true } })}>
      {(row, change) => (
        <div class="grid gap-3 sm:grid-cols-[10rem_8rem_minmax(0,1fr)]">
          <TextInput size="md" label={t("inputs.name")} class="t-code" value={row().name} onInput={(event) => change({ ...row(), name: event.currentTarget.value })} />
          <Select size="md" label={t("inputs.type")} options={INPUT_TYPES.map((type) => ({ label: type, value: type }))} value={row().spec.type} onValueChange={(type) => { if (type) change({ ...row(), spec: { ...row().spec, type: type as InputSpec["type"] } }); }} />
          <TextInput size="md" label={t("field.description")} value={row().spec.description} onInput={(event) => change({ ...row(), spec: { ...row().spec, description: event.currentTarget.value } })} />
          <div class="sm:col-span-3"><Switch label={t("inputs.required")} checked={row().spec.required} onCheckedChange={(required) => change({ ...row(), spec: { ...row().spec, required } })} /></div>
        </div>
      )}
    </Rows>
  );
}

export function ToolForm(props: { name: string; initial: ToolFile; isNew: boolean; readOnly: boolean; onSaved: () => void }): JSX.Element {
  const [tool, setTool] = createStore<ToolFile>(structuredClone(strip(props.initial)));
  const [inputs, setInputs] = createSignal(toRows(props.initial.inputs));
  const scripted = (): boolean => tool.runs === undefined && tool.host_command === undefined;
  const [script, setScript, scriptError] = useFileText(() => paths.script(props.name), "#!/bin/sh\nset -eu\n\n# The call's input arrives as JSON on standard input; print the result as JSON.\n", props.isNew || !scripted());
  const write = useWrite(props.onSaved);
  const file = (): ToolFile => ({ ...unwrap(tool), inputs: fromRows(inputs()) });
  const save = (): void => { const text = script(); if (scripted() && text === undefined) return; void write.run([{ path: paths.tool(props.name), content: toolToml(file()) }, ...(scripted() ? [{ path: paths.script(props.name), content: text ?? "" }] : [])], `${props.isNew ? "Add" : "Change"} the tool ${props.name}`); };
  return (
    <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <Group title={t("tool.what")}>
        <Problems items={problemsOf(write, paths.tool(props.name))} />
        <Textarea size="md" label={t("field.description")} description={t("tool.description.help")} rows={4} value={tool.description} onInput={(event) => setTool("description", event.currentTarget.value)} required disabled={props.readOnly} />
        <Choice label={t("tool.effect")} value={tool.effect} onChange={(value) => setTool("effect", value)} disabled={props.readOnly} options={EFFECTS.map((effect) => ({ value: effect, label: t(`effect.${effect}`), help: t(`effect.${effect}.help`) }))} />
        <p class="t-small text-ink-2">{tool.runs === "brain" ? t("tool.runs.brain") : tool.host_command !== undefined ? t("tool.runs.host", { command: tool.host_command }) : t("tool.runs.script")}</p>
      </Group>
      <Group title={t("tool.inputs")} text={t("tool.inputs.text")}>
        <InputRows label={t("tool.inputs")} rows={inputs()} onChange={setInputs} readOnly={props.readOnly} />
      </Group>
      <Show when={tool.runs === undefined}>
        <Group title={t("tool.sandbox")} text={t("tool.sandbox.text")}>
          <div class="grid gap-4 sm:grid-cols-2">
            <NumberField label={t("tool.timeout")} min={1} max={3600} step={1} value={tool.timeout_seconds} onChange={(value) => setTool("timeout_seconds", value ?? 60)} disabled={props.readOnly} />
            <Show when={scripted()}><ListField label={t("tool.needs")} description={t("tool.needs.help")} value={tool.needs} onChange={(value) => setTool("needs", value)} disabled={props.readOnly} /></Show>
          </div>
          <Show when={scripted()}>
            <div class="grid gap-4 sm:grid-cols-2">
              <ListField label={t("tool.network")} description={t("tool.network.help")} value={tool.network} onChange={(value) => setTool("network", value)} disabled={props.readOnly} />
              <ListField label={t("tool.secrets")} description={t("tool.secrets.help")} value={tool.secrets} onChange={(value) => setTool("secrets", value)} disabled={props.readOnly} />
            </div>
          </Show>
        </Group>
      </Show>
      <Show when={scripted()}>
        <Group title={t("tool.script")} text={t("tool.script.text")}>
          <Show when={script() !== undefined} fallback={<Show when={scriptError()} fallback={<p class="t-small text-ink-3">{t("common.loading")}</p>}><Failure error={scriptError()} /></Show>}>
            <CodeEditor label={paths.script(props.name)} value={script() ?? ""} onChange={setScript} problems={problemsOf(write, paths.script(props.name))} readOnly={props.readOnly} />
          </Show>
        </Group>
      </Show>
      <Show when={!props.readOnly}><SaveBar write={write} onSave={save} shown={[paths.tool(props.name), paths.script(props.name)]} disabled={scripted() && script() === undefined} /></Show>
    </form>
  );
}

const blankStep = (agent: string): StepSpec => ({ id: "", agent, goal: "", after: [], max_rounds: 2, approve: false });

export function PlayForm(props: { name: string; initial: PlayFile; isNew: boolean; snapshot: SnapshotManifest; readOnly: boolean; onSaved: () => void }): JSX.Element {
  const [play, setPlay] = createStore<PlayFile>(structuredClone(strip(props.initial)));
  const [inputs, setInputs] = createSignal(toRows(props.initial.inputs));
  const [trigger, setTrigger] = createSignal<"none" | "schedule" | "webhook">(props.initial.trigger?.schedule ? "schedule" : props.initial.trigger?.webhook ? "webhook" : "none");
  const [when, setWhen] = createSignal(props.initial.trigger?.schedule ?? props.initial.trigger?.webhook ?? "");
  const [paused, setPaused] = createSignal(props.initial.trigger?.paused === true);
  const write = useWrite(props.onSaved);
  const agents = (): { label: string; value: string }[] => names(props.snapshot.agents);
  const file = (): PlayFile => ({ ...unwrap(play), inputs: fromRows(inputs()), trigger: trigger() === "none" ? undefined : trigger() === "schedule" ? { schedule: when(), ...(paused() ? { paused: true } : {}) } : { webhook: when() } });
  const save = (): void => void write.run([{ path: paths.play(props.name), content: playToml(file()) }], `${props.isNew ? "Add" : "Change"} the Play ${props.name}`);
  const step = (index: number, patch: Partial<StepSpec>): void => setPlay("step", index, patch);
  /** A step's id is made from its agent (`developer`, then `developer-2`) until the person names it. A step already saved keeps its id: other steps and goals refer to it. */
  const saved = new Set(props.isNew ? [] : props.initial.step.map((one) => one.id));
  const [named, setNamed] = createSignal<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = createSignal<ReadonlySet<number>>(new Set());
  const unique = (base: string, index: number): string => {
    const used = new Set(unwrap(play).step.filter((_, at) => at !== index).map((other) => other.id));
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    return id;
  };
  const inferred = (index: number): boolean => { const id = (play.step[index] as StepSpec).id; return id === "" || (!saved.has(id) && !named().has(id)); };
  /** Gives the step the id its agent suggests, and the steps that wait for it follow the new id. */
  const infer = (index: number, agent: string | undefined): void => {
    const before = (play.step[index] as StepSpec).id;
    const id = unique(slugify(agent ?? "") || "step", index);
    setPlay("step", index, { agent, id });
    if (before !== "" && before !== id) setPlay("step", (_, at) => at !== index, "after", (list) => list.map((one) => (one === before ? id : one)));
  };
  const rename = (index: number, id: string): void => {
    const before = (play.step[index] as StepSpec).id;
    setNamed(new Set([...named(), id]));
    setPlay("step", index, { id });
    setPlay("step", (_, at) => at !== index, "after", (list) => list.map((one) => (one === before ? id : one)));
  };
  const move = (index: number, by: number): void => { const steps = [...unwrap(play).step]; const [moved] = steps.splice(index, 1); if (moved) { steps.splice(index + by, 0, moved); setPlay("step", steps); } };
  return (
    <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <Group title={t("play.what")}>
        <Problems items={problemsOf(write, paths.play(props.name))} />
        <TextInput size="md" label={t("field.title")} value={play.title} onInput={(event) => setPlay("title", event.currentTarget.value)} required maxlength={200} disabled={props.readOnly} />
        <Textarea size="md" label={t("field.description")} rows={2} value={play.description} onInput={(event) => setPlay("description", event.currentTarget.value)} disabled={props.readOnly} />
      </Group>
      <Group title={t("play.steps")} text={t("play.steps.text")}>
        <ol class="chain chain-plain">
          <For each={play.step.map((_, index) => index)}>
            {(index) => {
              const current = (): StepSpec => play.step[index] as StepSpec;
              const earlier = (): string[] => play.step.slice(0, index).map((other) => other.id).filter((id) => id !== "");
              return (
                <li class="chain-item">
                  <span class="chain-link" aria-hidden="true"><svg viewBox="0 0 28 44"><rect class="ring" x="2.5" y="2.5" width="23" height="39" rx="11.5" /></svg></span>
                  <div class="min-w-0 pb-5 ps-2">
                    <div class="flex flex-wrap items-end gap-3">
                      <div class="w-48"><Select size="md" label={t("play.step.agent", { n: index + 1 })} options={agents()} value={current().agent ?? null} onValueChange={(value) => { if (inferred(index)) infer(index, value ?? undefined); else step(index, { agent: value ?? undefined }); }} disabled={props.readOnly} /></div>
                      <Show when={renaming().has(index) && !saved.has(current().id)} fallback={
                        <p class="pb-2 t-small text-ink-2" data-testid="step-id">{t("play.step.idAuto")} <code class="t-code code-ltr text-ink">{current().id}</code>
                          <Show when={!props.readOnly && !saved.has(current().id)}> <button type="button" class="link" onClick={() => setRenaming(new Set([...renaming(), index]))}>{t("play.step.rename")}</button></Show>
                        </p>
                      }>
                        <div class="w-40"><TextInput size="md" label={t("play.step.id", { n: index + 1 })} class="t-code" value={current().id} onInput={(event) => rename(index, event.currentTarget.value)} required /></div>
                      </Show>
                      <Show when={!props.readOnly}>
                        <div class="ms-auto flex">
                          <Button variant="ghost" size="md" icon="lucide-arrow-up" aria-label={t("plan.earlier")} disabled={index === 0} onClick={() => move(index, -1)} />
                          <Button variant="ghost" size="md" icon="lucide-arrow-down" aria-label={t("plan.later")} disabled={index === play.step.length - 1} onClick={() => move(index, 1)} />
                          <Button variant="ghost" size="md" icon="lucide-trash-2" aria-label={t("action.remove")} disabled={play.step.length === 1} onClick={() => setPlay("step", play.step.filter((_, at) => at !== index))} />
                        </div>
                      </Show>
                    </div>
                    <div class="mt-3"><Textarea size="md" label={t("play.step.goal")} description={index === 0 ? t("play.step.goal.help") : undefined} rows={3} value={current().goal ?? ""} onInput={(event) => step(index, { goal: event.currentTarget.value })} disabled={props.readOnly} /></div>
                    <Show when={earlier().length > 0}>
                      <div class="mt-3"><PickMany label={t("play.step.after")} options={earlier().map((id) => ({ value: id, label: id }))} value={current().after} onChange={(after) => step(index, { after })} disabled={props.readOnly} /></div>
                    </Show>
                    <Details class="mt-3" summary={<span>{t("play.step.more")}{[current().review_by && t("play.step.tag.review", { agent: current().review_by ?? "" }), current().approve && t("play.step.tag.approve"), current().when && t("play.step.tag.when"), current().for_each && t("play.step.tag.forEach"), current().candidates !== undefined && t("play.step.tag.candidates")].filter(Boolean).map((tag) => ` (${tag})`).join("")}</span>}>
                      <div class="grid gap-4 pt-1 sm:grid-cols-2">
                        <Select size="md" label={t("play.step.reviewBy")} description={t("play.step.reviewBy.help")} options={[{ label: t("play.step.reviewBy.default"), value: "" }, ...agents().filter((agent) => agent.value !== current().agent)]} value={current().review_by ?? ""} onValueChange={(value) => step(index, { review_by: value || undefined })} disabled={props.readOnly} />
                        <NumberField label={t("play.step.maxRounds")} min={1} max={10} step={1} value={current().max_rounds} onChange={(value) => step(index, { max_rounds: value ?? 2 })} disabled={props.readOnly} />
                        <NumberField label={t("play.step.targetScore")} description={t("play.step.targetScore.help")} min={0} max={1} step={0.05} value={current().target_score} onChange={(value) => step(index, { target_score: value })} disabled={props.readOnly} />
                        <TextInput size="md" label={t("play.step.when")} description={t("play.step.when.help")} class="t-code" value={current().when ?? ""} onInput={(event) => step(index, { when: event.currentTarget.value || undefined })} disabled={props.readOnly} />
                        <TextInput size="md" label={t("play.step.forEach")} description={t("play.step.forEach.help")} class="t-code" value={current().for_each ?? ""} onInput={(event) => step(index, { for_each: event.currentTarget.value || undefined })} disabled={props.readOnly} />
                        <ListField label={t("play.step.candidates")} description={t("play.step.candidates.help")} value={Array.isArray(current().candidates) ? (current().candidates as string[]) : current().candidates !== undefined ? [String(current().candidates)] : []}
                          onChange={(value) => step(index, { candidates: value.length === 0 ? undefined : value.length === 1 && /^\d+$/u.test(value[0] ?? "") ? Number(value[0]) : value })} disabled={props.readOnly} />
                        <TextInput size="md" label={t("play.step.judge")} description={t("play.step.judge.help")} value={current().judge ?? ""} onInput={(event) => step(index, { judge: event.currentTarget.value || undefined })} disabled={props.readOnly} />
                        <div class="self-end"><Switch label={t("play.step.approve")} description={t("play.step.approve.help")} checked={current().approve} onCheckedChange={(approve) => step(index, { approve })} disabled={props.readOnly} /></div>
                      </div>
                    </Details>
                  </div>
                </li>
              );
            }}
          </For>
        </ol>
        <Show when={!props.readOnly}><div><Button variant="ghost" size="md" iconLeft="lucide-plus" onClick={() => { const agent = agents()[0]?.value ?? ""; setPlay("step", [...play.step, { ...blankStep(agent), id: unique(slugify(agent) || "step", play.step.length), after: play.step.at(-1)?.id ? [play.step.at(-1)?.id ?? ""] : [] }]); }}>{t("play.step.add")}</Button></div></Show>
      </Group>
      <Group title={t("play.inputs")} text={t("play.inputs.text")}>
        <InputRows label={t("play.inputs")} rows={inputs()} onChange={setInputs} readOnly={props.readOnly} />
      </Group>
      <Group title={t("play.trigger")} text={t("play.trigger.text")}>
        <Choice label={t("play.trigger")} value={trigger()} onChange={setTrigger} disabled={props.readOnly} options={[{ value: "none", label: t("play.trigger.none"), help: t("play.trigger.none.help") }, { value: "schedule", label: t("play.trigger.schedule"), help: t("play.trigger.schedule.help") }, { value: "webhook", label: t("play.trigger.webhook"), help: t("play.trigger.webhook.help") }]} />
        <Show when={trigger() === "schedule"}>
          <ScheduleEditor timezone={props.snapshot.timezone} value={when()} onChange={setWhen} disabled={props.readOnly} />
          <Switch label={t("schedule.pause")} description={t("schedule.pause.help")} checked={paused()} onCheckedChange={setPaused} disabled={props.readOnly} />
        </Show>
        <Show when={trigger() === "webhook"}>
          <div class="max-w-sm"><TextInput size="md" class="t-code" label={t("play.trigger.event")} placeholder="github.issues.opened" value={when()} onInput={(event) => setWhen(event.currentTarget.value)} required disabled={props.readOnly} /></div>
        </Show>
      </Group>
      <Show when={!props.readOnly}><SaveBar write={write} onSave={save} shown={[paths.play(props.name)]} /></Show>
    </form>
  );
}

const ref = (name: string | undefined): string | undefined => (name ? `secret:${name.replace(/^secret:/u, "")}` : undefined);
const bare = (value: string | undefined): string => (value ?? "").replace(/^secret:/u, "");
function SecretField(props: { label: string; description?: string; value: string | undefined; onChange: (value: string | undefined) => void; disabled: boolean }): JSX.Element {
  return <TextInput size="md" class="t-code" label={props.label} description={props.description ?? t("field.secret.help")} value={bare(props.value)} onChange={(event) => props.onChange(ref(event.currentTarget.value.trim()))} disabled={props.disabled} />;
}

function useBrain(snapshot: SnapshotManifest): { brain: Brain; set: ReturnType<typeof createStore<Brain>>[1]; write: Write; save: (message: string) => void } {
  const [brain, set] = createStore<Brain>(structuredClone(brainOf(snapshot)));
  const write = useWrite();
  return { brain, set, write, save: (message) => void write.run([{ path: paths.brain, content: brainToml(unwrap(brain)) }], message) };
}

export function ProjectsForm(props: { snapshot: SnapshotManifest; readOnly: boolean }): JSX.Element {
  const place = usePlace();
  const { brain, set, write, save } = useBrain(props.snapshot);
  const secrets = useQuery("secrets.list", () => (props.readOnly ? undefined : { workspaceId: place.id() }));
  const hasGithubSecret = (): boolean => (secrets.data()?.secrets ?? []).some((secret) => secret.name === "github");
  /** Typing the address fills what follows from it, until the person writes their own: the name, and the GitHub credential when this workspace has one. */
  const typed = (project: Project, repo: string): Project => {
    const inferred = project.name === "" || project.name === projectNameOf(project.repo);
    return { ...project, repo, ...(inferred ? { name: repo.trim() === "" ? "" : projectNameOf(repo) } : {}), ...(project.credential === undefined && onGithub(repo) && hasGithubSecret() ? { credential: "secret:github" } : {}) };
  };
  return (
    <form onSubmit={(event) => { event.preventDefault(); save("Change the projects"); }}>
      <Problems items={problemsOf(write, paths.brain)} />
      <Rows<Project> label={t("projects.list")} items={brain.projects} onChange={(projects) => set("projects", projects)} add={t("projects.add")} disabled={props.readOnly} blank={() => ({ name: "", repo: "", branch: "main", access: "read", network: [] })}>
        {(project, change) => (
          <div class="flex flex-col gap-4">
            <TextInput size="md" class="t-code" label={t("projects.repo")} placeholder="https://github.com/acme/shop.git" value={project().repo} onInput={(event) => change(typed(project(), event.currentTarget.value))} required disabled={props.readOnly} />
            <Switch label={t("new.repo.write")} description={t("new.repo.write.help")} checked={project().access === "write"} onCheckedChange={(on) => change({ ...project(), access: on ? "write" : "read" })} disabled={props.readOnly} />
            <Details summary={<span>{t("form.more")} <span class="t-small font-normal text-ink-2">({t("projects.inferred", { name: project().name || "…", branch: project().branch, credential: project().credential ?? t("fields.none") })})</span></span>}>
              <div class="grid gap-4 sm:grid-cols-2">
                <TextInput size="md" class="t-code" label={t("field.name")} placeholder={projectNameOf(project().repo)} value={project().name} onInput={(event) => change({ ...project(), name: event.currentTarget.value })} required disabled={props.readOnly} />
                <TextInput size="md" class="t-code" label={t("projects.branch")} value={project().branch} onInput={(event) => change({ ...project(), branch: event.currentTarget.value })} required disabled={props.readOnly} />
                <SecretField label={t("projects.credential")} description={t("projects.credential.help")} value={project().credential} onChange={(credential) => change({ ...project(), credential })} disabled={props.readOnly} />
                <TextInput size="md" class="t-code" label={t("projects.setup")} description={t("projects.setup.help")} placeholder="pnpm install --frozen-lockfile" value={project().setup ?? ""} onInput={(event) => change({ ...project(), setup: event.currentTarget.value || undefined })} disabled={props.readOnly} />
              </div>
              <ListField label={t("projects.network")} description={t("projects.network.help")} placeholder="registry.npmjs.org" value={project().network} onChange={(network) => change({ ...project(), network })} disabled={props.readOnly} />
            </Details>
          </div>
        )}
      </Rows>
      <Show when={!props.readOnly}><SaveBar write={write} onSave={() => save("Change the projects")} shown={[paths.brain]} /></Show>
    </form>
  );
}

/** The time zone this browser is in: what a workspace's clock is most likely to be. */
const browserZone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

export function SettingsForm(props: { snapshot: SnapshotManifest; readOnly: boolean }): JSX.Element {
  const session = useSession();
  const place = usePlace();
  const { brain, set, write, save } = useBrain(props.snapshot);
  const approvals = (): Array<{ tool: string; targets: string[]; per_day: number; until: string }> => Object.entries(brain.approvals).map(([tool, rule]) => ({ tool, ...rule, targets: [...rule.targets] }));
  const effectTools = (): { label: string; value: string }[] => Object.entries(props.snapshot.tools).filter(([, tool]) => tool.effect !== "read").map(([name]) => ({ label: name, value: name }));
  return (
    <form onSubmit={(event) => { event.preventDefault(); save("Change the settings"); }}>
      <Group title={t("settings.about")}>
        <Problems items={problemsOf(write, paths.brain)} />
        <TextInput size="md" label={t("field.name")} value={brain.name} onInput={(event) => set("name", event.currentTarget.value)} required maxlength={100} disabled={props.readOnly} />
        <Textarea size="md" label={t("field.description")} description={t("settings.description.help")} rows={2} value={brain.description} onInput={(event) => set("description", event.currentTarget.value)} disabled={props.readOnly} />
        <div class="max-w-sm">
          <TextInput size="md" label={t("settings.timezone")} description={t("settings.timezone.help")} placeholder={browserZone()} value={brain.timezone ?? ""} onInput={(event) => set("timezone", event.currentTarget.value || undefined)} disabled={props.readOnly} />
          <Show when={!props.readOnly && (brain.timezone ?? "") === "" && browserZone() !== "UTC"}><button type="button" class="link mt-1 t-small" onClick={() => set("timezone", browserZone())}>{t("settings.timezone.use", { zone: browserZone() })}</button></Show>
        </div>
        <Choice label={t("visibility.title")} value={brain.visibility ?? "private"} onChange={(value) => set("visibility", value)} disabled={props.readOnly}
          options={[{ value: "private", label: t("visibility.private"), help: t("visibility.private.help") }, { value: "public", label: t("visibility.public"), help: t("visibility.public.help") }]} />
        <Show when={session.user().instanceAdmin}>
          <Choice label={t("settings.platform")} value={brain.platform ?? ""} onChange={(value) => set("platform", value === "" ? undefined : value)} disabled={props.readOnly}
            options={[{ value: "", label: t("new.platform.none"), help: t("new.platform.none.help") }, { value: "read", label: t("new.platform.read"), help: t("new.platform.read.help") }, { value: "admin", label: t("new.platform.admin"), help: t("new.platform.admin.help") }]} />
        </Show>
        <p class="t-small text-ink-2">{t("settings.packs", { packs: brain.packs.join(", ") || t("fields.none") })}</p>
      </Group>
      <Group title={t("settings.limits")}>
        <div class="grid gap-4 sm:grid-cols-2">
          <NumberField label={t("settings.limits.spend")} description={t("field.zeroNoCap")} min={0} value={brain.limits.daily_spend_usd} onChange={(value) => set("limits", "daily_spend_usd", value ?? 0)} disabled={props.readOnly} />
          <NumberField label={t("settings.limits.running")} description={t("settings.limits.running.help")} min={0} max={64} step={1} value={brain.limits.running_tasks} onChange={(value) => set("limits", "running_tasks", value ?? 0)} disabled={props.readOnly} />
        </div>
        <Choice label={t("settings.limits.plans")} value={brain.limits.confirm_plans} onChange={(value) => set("limits", "confirm_plans", value)} disabled={props.readOnly} options={[{ value: "person", label: t("settings.limits.plans.person"), help: t("settings.limits.plans.person.help") }, { value: "auto", label: t("settings.limits.plans.auto"), help: t("settings.limits.plans.auto.help") }]} />
      </Group>
      <Group title={t("settings.healing")} text={t("settings.healing.text")}>
        <div class="grid gap-4 sm:grid-cols-2">
          <Choice label={t("settings.healing.mode")} value={brain.healing.mode} onChange={(value) => set("healing", "mode", value)} disabled={props.readOnly} options={[{ value: "auto", label: t("settings.healing.auto"), help: t("settings.healing.auto.help") }, { value: "off", label: t("settings.healing.off"), help: t("settings.healing.off.help") }]} />
          <NumberField label={t("settings.healing.perDay")} description={t("field.zeroNoCap")} min={0} step={1} value={brain.healing.per_day} onChange={(value) => set("healing", "per_day", value ?? 0)} disabled={props.readOnly} />
        </div>
      </Group>
      <Group title={t("settings.cleanup")} text={t("settings.cleanup.text")}>
        <NumberField label={t("settings.cleanup.hours")} description={t("settings.cleanup.never")} min={0} step={1} value={brain.cleanup.superseded_after_hours} onChange={(value) => set("cleanup", "superseded_after_hours", value ?? 0)} disabled={props.readOnly} />
      </Group>
      <Group title={t("settings.models")} text={t("settings.models.text")}>
        <Rows<Model> label={t("settings.models")} items={brain.models} onChange={(models) => set("models", models)} add={t("settings.models.add")} disabled={props.readOnly} blank={() => ({ name: brain.models.length === 0 ? "main" : "", provider: "openai-compatible", url: "", model: "" })}>
          {(model, change) => (
            <div class="grid gap-4 sm:grid-cols-2">
              <TextInput size="md" class="t-code" label={t("field.name")} value={model().name} onInput={(event) => change({ ...model(), name: event.currentTarget.value })} required />
              <Select size="md" label={t("settings.models.provider")} options={[{ label: t("settings.models.provider.openai"), value: "openai-compatible" }, { label: "Anthropic", value: "anthropic" }]} value={model().provider} onValueChange={(provider) => { if (provider) change({ ...model(), provider: provider as Model["provider"] }); }} />
              <TextInput size="md" class="t-code" type="url" label={t("first.model.url")} placeholder="https://models.example/v1" value={model().url} onInput={(event) => change({ ...model(), url: event.currentTarget.value })} required />
              <TextInput size="md" class="t-code" label={t("first.model.name")} value={model().model} onInput={(event) => change({ ...model(), model: event.currentTarget.value })} required />
              <SecretField label={t("settings.models.key")} value={model().key} onChange={(key) => change({ ...model(), key })} disabled={props.readOnly} />
              <div class="grid grid-cols-2 gap-3">
                <NumberField label={t("settings.models.inputPrice")} min={0} value={model().input_usd_per_mtok} onChange={(value) => change({ ...model(), input_usd_per_mtok: value })} />
                <NumberField label={t("settings.models.outputPrice")} min={0} value={model().output_usd_per_mtok} onChange={(value) => change({ ...model(), output_usd_per_mtok: value })} />
              </div>
            </div>
          )}
        </Rows>
      </Group>
      <Group title={t("settings.github")} text={t("settings.github.text")}>
        <div class="grid gap-4 sm:grid-cols-2">
          <SecretField label={t("settings.github.credential")} value={brain.github?.credential} onChange={(credential) => set("github", credential ? { ...brain.github, credential } : undefined)} disabled={props.readOnly} />
          <SecretField label={t("settings.github.webhook")} description={t("settings.github.webhook.help")} value={brain.github?.webhook_secret} onChange={(secret) => { if (brain.github) set("github", { credential: brain.github.credential, ...(secret ? { webhook_secret: secret } : {}) }); }} disabled={props.readOnly || !brain.github} />
        </div>
      </Group>
      <Group title={t("settings.git")} text={t("settings.git.text")}>
        <div class="grid gap-4 sm:grid-cols-2">
          <TextInput size="md" class="t-code" type="url" label={t("settings.git.remote")} placeholder="https://github.com/acme/workspace-files.git" value={brain.git?.remote ?? ""} onInput={(event) => set("git", event.currentTarget.value.trim() === "" ? undefined : { ...brain.git, remote: event.currentTarget.value.trim() })} disabled={props.readOnly} />
          <SecretField label={t("settings.git.credential")} description={t("settings.git.credential.help")} value={brain.git?.credential} onChange={(credential) => { if (brain.git) set("git", { remote: brain.git.remote, ...(credential ? { credential } : {}) }); }} disabled={props.readOnly || !brain.git} />
        </div>
        <Show when={props.snapshot.git}><PushStatus push={place.workspace.data()?.folderPush} /></Show>
      </Group>
      <Group title={t("settings.teams")} text={t("settings.teams.text")}>
        <div class="max-w-sm"><SecretField label={t("settings.teams.webhook")} value={brain.teams?.webhook} onChange={(webhook) => set("teams", webhook ? { webhook } : undefined)} disabled={props.readOnly} /></div>
      </Group>
      <Group title={t("settings.approvals")} text={t("settings.approvals.text")}>
        <Rows label={t("settings.approvals")} items={approvals()} add={t("settings.approvals.add")} disabled={props.readOnly} blank={() => ({ tool: "", targets: [], per_day: 1, until: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) })}
          onChange={(rows) => set("approvals", Object.fromEntries(rows.map((row) => [row.tool, { targets: row.targets, per_day: row.per_day, until: row.until }])))}>
          {(rule, change) => (
            <div class="grid gap-4 sm:grid-cols-2">
              <Select size="md" label={t("settings.approvals.tool")} options={effectTools()} value={rule().tool || null} onValueChange={(tool) => { if (tool) change({ ...rule(), tool }); }} />
              <ListField label={t("settings.approvals.targets")} description={t("settings.approvals.targets.help")} value={rule().targets} onChange={(targets) => change({ ...rule(), targets })} />
              <NumberField label={t("settings.approvals.perDay")} min={1} step={1} value={rule().per_day} onChange={(value) => change({ ...rule(), per_day: value ?? 1 })} />
              <TextInput size="md" type="date" label={t("settings.approvals.until")} value={rule().until} onInput={(event) => change({ ...rule(), until: event.currentTarget.value })} />
            </div>
          )}
        </Rows>
      </Group>
      <Show when={!props.readOnly}><SaveBar write={write} onSave={() => save("Change the settings")} shown={[paths.brain]} /></Show>
    </form>
  );
}
