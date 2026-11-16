import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import type { CommandRequest, Task } from "@brain/contracts";
import { command, query, useAction, useLive } from "../data/api";
import { usePlace } from "../data/session";
import { t } from "../i18n";
import { Details, Failure, Icon, Keyed, Loading } from "./bits";

type Change = CommandRequest<"task.edit">["changes"][number];
const editable = (task: Task): boolean => task.state === "waiting" || task.state === "ready";

/** The sub-tasks in the order they will run: each after the ones it waits for, otherwise as the plan listed them. */
export function planOrder(tasks: readonly Task[]): Task[] {
  const placed = new Set<string>();
  const order: Task[] = [];
  const rest = [...tasks];
  while (rest.length > 0) {
    const next = rest.findIndex((task) => task.waitsFor.every((id) => placed.has(id) || !tasks.some((other) => other.id === id)));
    const [task] = rest.splice(Math.max(next, 0), 1);
    if (task) { placed.add(task.id); order.push(task); }
  }
  return order;
}

/**
 * The plan of a goal as a list a person can change before it runs: the agent of a sub-task, its wording, its place in the order,
 * whether it is there at all. Every change is sent at once; only sub-tasks that have not started can change.
 */
export function PlanEditor(props: { root: Task; onOrder?: (ids: readonly string[]) => void }): JSX.Element {
  const place = usePlace();
  const ids = (): string[] => props.root.subtasks.filter((task) => task.parentId === props.root.id).map((task) => task.id);
  const loaded = useLive(() => `${props.root.id}:${ids().join(",")}:${props.root.version}`, () => Promise.all(ids().map((taskId) => query("task.get", { workspaceId: place.id(), taskId }))));
  const tasks = createMemo(() => planOrder(loaded.data() ?? []));
  createEffect(() => props.onOrder?.(tasks().map((task) => task.id)));
  const agents = (): { label: string; value: string }[] => Object.keys(place.workspace.data()?.snapshot.agents ?? {}).map((name) => ({ label: name, value: name }));
  const edit = useAction((changes: Change[]) => command("task.edit", { workspaceId: place.id(), taskId: props.root.id, changes }));
  const titleOf = (id: string): string => tasks().find((task) => task.id === id)?.title ?? id;

  /**
   * Swaps two neighbours in the order: each takes the other's place in every "waits for". The later one is changed first, so that no
   * step of the edit has the two waiting for each other.
   */
  const swap = (a: Task, b: Task): void => {
    const other = (id: string): string => (id === a.id ? b.id : id === b.id ? a.id : id);
    const rest = tasks().filter((task) => task.id !== a.id && task.id !== b.id);
    const changes = [b, a, ...rest].filter(editable).flatMap((task): Change[] => {
      const source = task.id === a.id ? b : task.id === b.id ? a : task;
      const after = source.waitsFor.map(other).filter((id) => id !== task.id);
      return after.join() === task.waitsFor.join() ? [] : [{ op: "change", id: task.id, after }];
    });
    if (changes.length > 0) void edit.run(changes);
  };

  const [adding, setAdding] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [goal, setGoal] = createSignal("");
  const [agent, setAgent] = createSignal<string | null>(null);
  const add = async (): Promise<void> => {
    const last = tasks().at(-1);
    if (await edit.run([{ op: "add", title: title(), goal: goal(), agent: agent() ?? "", after: last ? [last.id] : [] }])) { setTitle(""); setGoal(""); setAdding(false); }
  };

  return (
    <Show when={loaded.data()} fallback={<Show when={loaded.error()} fallback={<Loading />}><Failure error={loaded.error()} /></Show>}>
      <ol class="flex flex-col">
        <Keyed each={tasks()} by={(task) => task.id}>
          {(task) => {
            const index = (): number => tasks().findIndex((other) => other.id === task().id);
            const [draftTitle, setDraftTitle] = createSignal<string>();
            const [draftGoal, setDraftGoal] = createSignal<string>();
            const save = (): void => { void edit.run([{ op: "change", id: task().id, ...(draftTitle() !== undefined ? { title: draftTitle() } : {}), ...(draftGoal() !== undefined ? { goal: draftGoal() } : {}) }]).then((ok) => { if (ok) { setDraftTitle(undefined); setDraftGoal(undefined); } }); };
            return (
              <li class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 border-b border-rule py-3 last:border-b-0">
                <span class="pt-0.5 font-display text-[0.9375rem] font-semibold text-ink-3">{index() + 1}</span>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p class="min-w-0 flex-1 basis-48 t-text font-semibold text-ink" dir="auto">{task().title}</p>
                    <Show when={editable(task())} fallback={<span class="t-small text-ink-3">{task().agent} ({t(`state.${task().state}`)})</span>}>
                      <div class="w-44"><Select size="sm" aria-label={t("plan.agent")} options={agents()} value={task().agent} onValueChange={(value) => { if (value && value !== task().agent) void edit.run([{ op: "change", id: task().id, agent: value }]); }} /></div>
                      <div class="flex items-center">
                        <Button variant="ghost" size="sm" icon="lucide-arrow-up" aria-label={t("plan.earlier")} disabled={index() === 0 || edit.busy()} onClick={() => { const before = tasks()[index() - 1]; if (before) swap(before, task()); }} />
                        <Button variant="ghost" size="sm" icon="lucide-arrow-down" aria-label={t("plan.later")} disabled={index() === tasks().length - 1 || edit.busy()} onClick={() => { const next = tasks()[index() + 1]; if (next) swap(task(), next); }} />
                        <Button variant="ghost" size="sm" icon="lucide-trash-2" aria-label={t("plan.remove")} disabled={edit.busy()} onClick={() => void edit.run([{ op: "remove", id: task().id }])} />
                      </div>
                    </Show>
                  </div>
                  <Show when={task().waitsFor.length > 0}><p class="t-small text-ink-3">{t("plan.after", { names: task().waitsFor.map(titleOf).join(", ") })}</p></Show>
                  <Details class="mt-1" summary={editable(task()) ? t("plan.wording.edit") : t("plan.wording")}>
                    <Show when={editable(task())} fallback={<p class="whitespace-pre-wrap t-small text-ink-2" dir="auto">{task().goal}</p>}>
                      <div class="flex flex-col gap-2">
                        <TextInput size="md" label={t("plan.title")} value={draftTitle() ?? task().title} onInput={(event) => setDraftTitle(event.currentTarget.value)} maxlength={200} />
                        <Textarea size="md" label={t("plan.goal")} rows={4} value={draftGoal() ?? task().goal} onInput={(event) => setDraftGoal(event.currentTarget.value)} />
                        <div><Button variant="outline" size="sm" disabled={(draftTitle() === undefined && draftGoal() === undefined) || edit.busy()} onClick={save}>{t("action.save")}</Button></div>
                      </div>
                    </Show>
                  </Details>
                </div>
              </li>
            );
          }}
        </Keyed>
      </ol>
      <Failure error={edit.error()} class="mt-3" />
      <Show when={adding()} fallback={<Button variant="ghost" size="md" class="mt-2" iconLeft="lucide-plus" onClick={() => setAdding(true)}>{t("plan.add")}</Button>}>
        <form class="mt-3 flex flex-col gap-3 rounded-xl bg-paper p-4" onSubmit={(event) => { event.preventDefault(); void add(); }}>
          <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <TextInput size="md" label={t("plan.title")} value={title()} onInput={(event) => setTitle(event.currentTarget.value)} required maxlength={200} autofocus />
            <Select size="md" label={t("plan.agent")} options={agents()} value={agent()} onValueChange={setAgent} />
          </div>
          <Textarea size="md" label={t("plan.goal")} description={t("plan.goal.help")} rows={3} value={goal()} onInput={(event) => setGoal(event.currentTarget.value)} required />
          <div class="flex gap-2">
            <Button type="submit" variant="outline" size="md" loading={edit.busy()} disabled={title().trim() === "" || goal().trim() === "" || !agent()}>{t("plan.add.submit")}</Button>
            <Button variant="ghost" size="md" onClick={() => setAdding(false)}>{t("action.cancel")}</Button>
          </div>
        </form>
      </Show>
      <Show when={tasks().length === 0}><p class="mt-2 flex items-center gap-2 t-small text-ink-3"><Icon name="lucide-info" />{t("plan.empty")}</p></Show>
    </Show>
  );
}
