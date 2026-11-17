import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Button, Switch, TextInput } from "@talelk/newui-atoms";
import { Dialog, Select, toast } from "@talelk/newui-molecules";
import type { PlayFile, ScheduleItem } from "@brain/contracts";
import { command, query, useAction, useQuery } from "../data/api";
import { useSession } from "../data/session";
import { human, t, type MessageKey } from "../i18n";
import { paths, playToml } from "../lib/files";
import { clock, cronOf, inZone, isValidCron, presetOf, PRESETS, upcoming, weekday, words, type Preset } from "../lib/schedule";
import { Failure } from "./bits";
import { NumberField } from "./fields";

/** A schedule as a form: friendly presets or an advanced cron field, checked live, with the next three times in the workspace's time zone. */
export function ScheduleEditor(props: { timezone: string; value: string; onChange: (cron: string) => void; disabled?: boolean }): JSX.Element {
  const first = presetOf(props.value || "0 8 * * 1-5");
  const [kind, setKind] = createSignal<Preset["kind"]>(props.value ? first.kind : "weekdays");
  const [minute, setMinute] = createSignal(first.kind === "custom" ? 0 : first.minute);
  const [hour, setHour] = createSignal(first.kind === "custom" || first.kind === "hourly" ? 8 : first.hour);
  const [day, setDay] = createSignal(first.kind === "weekly" ? first.day : 1);
  const [date, setDate] = createSignal(first.kind === "monthly" ? first.date : 1);
  const [custom, setCustom] = createSignal(props.value || "0 8 * * 1-5");
  const cron = createMemo((): string => {
    const k = kind();
    if (k === "custom") return custom().trim();
    return cronOf(k === "hourly" ? { kind: k, minute: minute() } : k === "weekly" ? { kind: k, day: day(), hour: hour(), minute: minute() } : k === "monthly" ? { kind: k, date: date(), hour: hour(), minute: minute() } : { kind: k, hour: hour(), minute: minute() });
  });
  createEffect(() => props.onChange(cron()));
  const valid = (): boolean => isValidCron(cron(), props.timezone);
  const next = (): number[] => (valid() ? upcoming(cron(), props.timezone, 3) : []);
  const time = (): string => clock(hour(), minute());
  const setTime = (value: string): void => { const [h, m] = value.split(":").map(Number); if (h !== undefined && m !== undefined && !Number.isNaN(h) && !Number.isNaN(m)) { setHour(h); setMinute(m); } };
  return (
    <div class="flex flex-col gap-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <Select size="md" label={t("schedule.preset")} disabled={props.disabled} options={PRESETS.map((value) => ({ value, label: t(`schedule.preset.${value}` as MessageKey) }))} value={kind()}
          onValueChange={(value) => { if (value) { if (value === "custom") setCustom(cron()); setKind(value as Preset["kind"]); } }} />
        <Show when={kind() === "weekly"}>
          <Select size="md" label={t("schedule.day")} disabled={props.disabled} options={[1, 2, 3, 4, 5, 6, 0].map((value) => ({ value: String(value), label: weekday(value) }))} value={String(day())} onValueChange={(value) => { if (value) setDay(Number(value)); }} />
        </Show>
        <Show when={kind() === "monthly"}><NumberField label={t("schedule.date")} min={1} max={31} step={1} value={date()} onChange={(value) => setDate(value ?? 1)} disabled={props.disabled} /></Show>
        <Show when={kind() === "hourly"}><NumberField label={t("schedule.minute")} min={0} max={59} step={1} value={minute()} onChange={(value) => setMinute(value ?? 0)} disabled={props.disabled} /></Show>
        <Show when={kind() !== "hourly" && kind() !== "custom"}><TextInput size="md" type="time" label={t("schedule.time")} value={time()} onInput={(event) => setTime(event.currentTarget.value)} disabled={props.disabled} /></Show>
      </div>
      <Show when={kind() === "custom"}>
        <TextInput size="md" class="t-code" label={t("schedule.cron")} description={t("schedule.cron.help")} placeholder="0 8 * * 1" value={custom()} onInput={(event) => setCustom(event.currentTarget.value)} disabled={props.disabled} error={valid() ? undefined : t("schedule.invalid")} />
      </Show>
      <div class="rounded-control bg-surface-gray-2 px-4 py-3">
        <p class="t-text font-medium text-ink">{valid() ? words(cron(), props.timezone) : t("schedule.invalid")} <span class="t-small font-normal text-ink-2">· <code class="t-code code-ltr" dir="ltr">{cron()}</code></span></p>
        <Show when={next().length > 0}>
          <p class="mt-2 t-small font-medium text-ink-2">{t("schedule.next3", { zone: props.timezone })}</p>
          <ol class="mt-1 flex flex-col gap-0.5 t-small text-ink" aria-label={t("schedule.next3", { zone: props.timezone })}><For each={next()}>{(at) => <li>{inZone(at, props.timezone)}</li>}</For></ol>
        </Show>
      </div>
    </div>
  );
}

const withTrigger = (play: PlayFile & { source?: string }, trigger: PlayFile["trigger"]): PlayFile => {
  const { source: _source, ...rest } = play;
  return { ...rest, trigger };
};
/** Writes a Play's `[trigger]` into its workspace file (a copy over the pack's, when it comes from a pack); one commit. */
export async function saveTrigger(workspaceId: string, play: string, trigger: PlayFile["trigger"]): Promise<void> {
  const workspace = await query("workspace.get", { workspaceId });
  const current = workspace.snapshot.plays[play];
  if (!current) return;
  await command("file.write", { workspaceId, files: [{ path: paths.play(play), content: playToml(withTrigger(current, trigger)) }], message: trigger ? `Schedule the Play ${play}` : `Unschedule the Play ${play}` });
  toast.success({ title: t("workspace.saved") });
}

/** Schedule a Play, or change, pause or remove the schedule of one (an admin's job: it edits the Play's file). */
export function ScheduleDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; item?: ScheduleItem }): JSX.Element {
  const session = useSession();
  const admins = () => session.workspaces().filter((workspace) => workspace.status === "active" && workspace.role === "admin" && !workspace.viaPublic);
  const [chosen, setChosen] = createSignal<string>();
  const [play, setPlay] = createSignal<string>();
  const [cron, setCron] = createSignal("");
  const [paused, setPaused] = createSignal(false);
  const workspaceId = (): string | undefined => props.item?.workspaceId ?? chosen() ?? admins()[0]?.id;
  const loaded = useQuery("workspace.get", () => (props.open && workspaceId() ? { workspaceId: workspaceId() as string } : undefined));
  const plays = () => Object.entries(loaded.data()?.snapshot.plays ?? {}).filter(([, spec]) => spec.trigger?.webhook === undefined);
  const playName = (): string | undefined => props.item?.play ?? play() ?? plays()[0]?.[0];
  const timezone = (): string => props.item?.timezone ?? loaded.data()?.snapshot.timezone ?? "UTC";
  const current = () => loaded.data()?.snapshot.plays[playName() ?? ""];
  createEffect(() => { if (props.open) setPaused(props.item?.paused ?? false); });
  const save = useAction(async () => {
    const name = playName();
    const id = workspaceId();
    if (!name || !id) return;
    await saveTrigger(id, name, { schedule: cron(), ...(paused() ? { paused: true } : {}) });
    props.onOpenChange(false);
  });
  const remove = useAction(async () => {
    const name = playName();
    const id = workspaceId();
    if (name && id) await saveTrigger(id, name, undefined);
    props.onOpenChange(false);
  });
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content size="lg">
        <Dialog.Header><Dialog.Title>{props.item ? t("schedule.edit", { play: human(props.item.translations, ["title"], props.item.title) }) : t("schedule.add")}</Dialog.Title><Dialog.Description>{t("schedule.add.text")}</Dialog.Description></Dialog.Header>
        <form class="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save.run(); }}>
          <Show when={!props.item}>
            <div class="grid gap-4 sm:grid-cols-2">
              <Select size="md" label={t("schedule.workspace")} options={admins().map((workspace) => ({ value: workspace.id, label: workspace.name }))} value={workspaceId() ?? null} onValueChange={(value) => { if (value) { setChosen(value); setPlay(undefined); } }} />
              <Select size="md" label={t("schedule.play")} options={plays().map(([name, spec]) => ({ value: name, label: human(spec.translations, ["title"], spec.title) }))} value={playName() ?? null} onValueChange={(value) => { if (value) setPlay(value); }} />
            </div>
          </Show>
          <Show when={Boolean(playName() && loaded.data())} fallback={<p class="t-small text-ink-2">{t("schedule.noPlays")}</p>}>
            {(() => (
              <>
                <Show when={current()?.source !== "workspace" && current()?.source}><p class="rounded-control bg-surface-gray-2 px-4 py-3 t-small text-ink-2">{t("schedule.packNote", { pack: current()?.source ?? "" })}</p></Show>
                <Show when={props.item || playName()} keyed>
                  <ScheduleEditor timezone={timezone()} value={props.item?.kind === "schedule" ? props.item.spec : (current()?.trigger?.schedule ?? "")} onChange={setCron} />
                </Show>
                <Switch label={t("schedule.pause")} description={t("schedule.pause.help")} checked={paused()} onCheckedChange={setPaused} />
              </>
            ))()}
          </Show>
          <Failure error={save.error() ?? remove.error()} />
          <div class="flex flex-wrap justify-end gap-2">
            <Show when={props.item}><Button variant="ghost" theme="red" size="md" class="me-auto" loading={remove.busy()} onClick={() => void remove.run()}>{t("schedule.remove")}</Button></Show>
            <Button variant="ghost" size="md" onClick={() => props.onOpenChange(false)}>{t("action.cancel")}</Button>
            <Button type="submit" variant="solid" theme="blue" size="md" loading={save.busy()} disabled={!playName() || !isValidCron(cron(), timezone())}>{t("action.save")}</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
