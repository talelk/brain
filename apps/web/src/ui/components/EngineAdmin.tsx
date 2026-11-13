import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { workspaceChoices, effectSettingsRead, engineSettingsRead, lessonsRead, runnerGroupsRead, type EffectSettings, type EngineSettings, type Lesson, type RunnerGroupRow } from "../../data/engine";
import { DateText, ScreenRegion } from "../screen-region";
import { PageStack } from "./PageLayout";
import { WorkspaceSection } from "./Domain";
import { failureSentence } from "./TaskFailure";
import { t, type MessageKey } from "../../i18n";

/** One command's busy flag and the sentence the person reads afterwards (the Governor's own words when it refuses). */
function createSaver(after: () => Promise<unknown>) {
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | undefined>();
  const save = async (command: () => Promise<{ accepted: boolean; detail: string }>, done: string): Promise<boolean> => {
    if (busy()) return false;
    setBusy(true); setResult(undefined);
    try {
      const receipt = await command();
      if (!receipt.accepted) throw new Error(receipt.detail);
      setResult({ ok: true, text: done });
      await after();
      return true;
    } catch (cause) { setResult({ ok: false, text: cause instanceof Error ? cause.message : t("decision.refused") }); return false; }
    finally { setBusy(false); }
  };
  return { busy, result, save };
}

function Outcome(props: { result?: { ok: boolean; text: string } | undefined }): JSX.Element {
  return <Show when={props.result}>{(result) => <p role={result().ok ? "status" : "alert"} class={`m-0 text-interface ${result().ok ? "text-ink-green-8" : "text-ink-red-8"}`}>{result().text}</p>}</Show>;
}

/** A field only goes to the Governor when it has text: an empty vendor, model or address is "not chosen", not an empty choice. */
const given = <K extends string>(key: K, value: string): Partial<Record<K, string>> => (value.trim() ? ({ [key]: value.trim() } as Record<K, string>) : {});
const lines = (text: string): string[] => [...new Set(text.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean))];

/** The way of working a workspace starts its tasks with, and the tools each task must observe by default. */
function WayOfWorking(props: { settings: EngineSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const [workflow, setWorkflow] = createSignal<string | undefined>();
  const [tools, setTools] = createSignal<string[] | undefined>();
  const chosen = () => workflow() ?? props.settings.wayOfWorking?.workflowId ?? "";
  const available = () => props.settings.workflows.find((entry) => entry.workflowId === chosen())?.tools ?? [];
  const required = () => (tools() ?? props.settings.wayOfWorking?.requiredTools ?? []).filter((tool) => available().includes(tool));
  const saver = createSaver(async () => { setWorkflow(undefined); setTools(undefined); await props.reload(); });
  return <WorkspaceSection title={t("work.way.title")} description={t("work.way.description")}>
    <Show when={props.settings.workflows.length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7">{t("work.way.none")}</p>}>
      <div class="flex min-w-0 flex-col gap-3" data-work-way>
        <p class="m-0 text-interface text-ink-gray-8" data-work-way-current>{props.settings.wayOfWorking ? t("work.way.current", { workflow: props.settings.wayOfWorking.workflowId, tools: props.settings.wayOfWorking.requiredTools.join(", ") || t("work.way.noTools") }) : t("work.way.unset")}</p>
        <Select label={t("work.way.workflow")} value={chosen() || null} onValueChange={(value) => { setWorkflow(value ?? undefined); setTools([]); }}
          options={props.settings.workflows.map((entry) => ({ value: entry.workflowId, label: entry.workflowId }))} />
        <Show when={available().length > 0}>
          <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"><legend class="mb-1 text-interface font-medium text-ink-gray-8">{t("work.way.tools")}</legend>
            <p class="m-0 text-caption text-ink-gray-6">{t("work.way.toolsHint")}</p>
            <For each={available()}>{(tool) => <Checkbox checked={required().includes(tool)} label={tool}
              onCheckedChange={(checked) => setTools(checked === true ? [...new Set([...required(), tool])] : required().filter((entry) => entry !== tool))} />}</For>
          </fieldset>
        </Show>
        <div><Button variant="solid" theme="blue" size="sm" loading={saver.busy()} disabled={saver.busy() || !chosen() || !app.canAdminister()}
          onClick={() => void saver.save(() => app.run("workspace.wayOfWorking.set", { workflowId: chosen(), requiredTools: required() }), t("work.way.saved"))}>{t("work.save")}</Button></div>
        <Outcome result={saver.result()} />
      </div>
    </Show>
  </WorkspaceSection>;
}

const HOSTED_STATUS: Readonly<Record<EngineSettings["hostedModel"]["status"], MessageKey>> = { off: "work.hosted.status.off", up: "work.hosted.status.up", down: "work.hosted.status.down", unknown: "work.hosted.status.unknown" };

/** A hosted model for checks and second attempts. Off unless an owner turns it on; the API key lives on the runner host and is never typed here. */
function HostedModel(props: { settings: EngineSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const hosted = () => props.settings.hostedModel;
  const [enabled, setEnabled] = createSignal<boolean | undefined>();
  const [vendor, setVendor] = createSignal<string | undefined>();
  const [model, setModel] = createSignal<string | undefined>();
  const [baseUrl, setBaseUrl] = createSignal<string | undefined>();
  const saver = createSaver(async () => { setEnabled(undefined); setVendor(undefined); setModel(undefined); setBaseUrl(undefined); await props.reload(); });
  const on = () => enabled() ?? hosted().enabled;
  return <WorkspaceSection title={t("work.hosted.title")} description={t("work.hosted.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-hosted>
      <p class="m-0 flex flex-wrap items-center gap-2 text-interface text-ink-gray-8"><span>{t("work.hosted.status")}</span>
        <Badge variant="outline" theme={hosted().status === "up" ? "green" : hosted().status === "down" ? "red" : "gray"} label={t(HOSTED_STATUS[hosted().status])} /></p>
      <Checkbox checked={on()} onCheckedChange={(checked) => setEnabled(checked === true)} label={t("work.hosted.enable")} />
      <p class="m-0 text-caption text-ink-gray-6">{t("work.hosted.roles")}</p>
      <div class="grid min-w-0 gap-3 sm:grid-cols-2">
        <TextInput label={t("work.hosted.vendor")} value={vendor() ?? hosted().vendor} onInput={(event) => setVendor(event.currentTarget.value)} />
        <TextInput label={t("work.hosted.model")} value={model() ?? hosted().model} onInput={(event) => setModel(event.currentTarget.value)} />
      </div>
      <TextInput label={t("work.hosted.address")} description={t("work.hosted.addressHint")} value={baseUrl() ?? hosted().baseUrl} placeholder="https://" onInput={(event) => setBaseUrl(event.currentTarget.value)} />
      <div><Button variant="solid" theme="blue" size="sm" loading={saver.busy()} disabled={saver.busy() || !app.canAdminister()}
        onClick={() => void saver.save(() => app.run("workspace.hostedModel.set", { enabled: on(), ...given("vendor", vendor() ?? hosted().vendor), ...given("model", model() ?? hosted().model), ...given("baseUrl", baseUrl() ?? hosted().baseUrl) }), t("work.hosted.saved"))}>{t("work.save")}</Button></div>
      <Outcome result={saver.result()} />
    </div>
  </WorkspaceSection>;
}

/** What this workspace's effect tools may touch, and how long an approval waits. */
function Effects(props: { effects: EffectSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const [containers, setContainers] = createSignal<string | undefined>();
  const [services, setServices] = createSignal<string | undefined>();
  const [minutes, setMinutes] = createSignal<string | undefined>();
  const saver = createSaver(async () => { setContainers(undefined); setServices(undefined); setMinutes(undefined); await props.reload(); });
  const wait = () => Number.parseInt(minutes() ?? String(props.effects.approvalMinutes), 10);
  return <WorkspaceSection title={t("work.effects.title")} description={t("work.effects.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-effects>
      <Textarea label={t("work.effects.containers")} description={t("work.effects.listHint")} rows={3} value={containers() ?? props.effects.containers.join("\n")} onInput={(event) => setContainers(event.currentTarget.value)} />
      <Textarea label={t("work.effects.services")} description={t("work.effects.listHint")} rows={3} value={services() ?? props.effects.services.join("\n")} onInput={(event) => setServices(event.currentTarget.value)} />
      <TextInput label={t("work.effects.minutes")} description={t("work.effects.minutesHint")} type="number" min={1} max={1440} inputmode="numeric" value={minutes() ?? String(props.effects.approvalMinutes)} onInput={(event) => setMinutes(event.currentTarget.value)} />
      <p class="m-0 text-caption text-ink-gray-6">{props.effects.runnerGroups.length ? t("work.effects.groups", { groups: props.effects.runnerGroups.map((group) => group.groupId).join(", ") }) : t("work.effects.noGroups")}</p>
      <div><Button variant="solid" theme="blue" size="sm" loading={saver.busy()} disabled={saver.busy() || !app.canAdminister() || !(wait() >= 1 && wait() <= 1440)}
        onClick={() => void saver.save(() => app.run("workspace.effects.set", { containers: lines(containers() ?? props.effects.containers.join("\n")), services: lines(services() ?? props.effects.services.join("\n")), approvalMinutes: wait() }), t("work.effects.saved"))}>{t("work.save")}</Button></div>
      <Outcome result={saver.result()} />
    </div>
  </WorkspaceSection>;
}

/** Runner groups: which workspaces a group of runners serves and whether it may run tools that touch hosts. */
function RunnerGroups(props: { groups: RunnerGroupRow[]; workspaces: { workspaceId: string; displayName: string }[]; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const [groupId, setGroupId] = createSignal("");
  const [hostTools, setHostTools] = createSignal(false);
  const [chosen, setChosen] = createSignal<string[]>([]);
  const saver = createSaver(async () => { setGroupId(""); setHostTools(false); setChosen([]); await props.reload(); });
  const name = (id: string) => props.workspaces.find((entry) => entry.workspaceId === id)?.displayName ?? id;
  const edit = (group: RunnerGroupRow) => { setGroupId(group.groupId); setHostTools(group.hostTools); setChosen([...group.workspaceIds]); };
  const valid = () => /^[a-z][a-z0-9.-]*$/u.test(groupId()) && groupId().length <= 64;
  return <WorkspaceSection title={t("work.groups.title")} description={t("work.groups.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-groups>
      <Show when={props.groups.length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7">{t("work.groups.none")}</p>}>
        <ul class="m-0 flex list-none flex-col gap-2 p-0"><For each={props.groups}>{(group) => <li class="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-control border border-outline-gray-1 p-3" data-runner-group={group.groupId}>
          <div class="min-w-0"><p class="m-0 break-words text-interface font-medium text-ink-gray-9">{group.groupId}</p>
            <p class="m-0 break-words text-caption text-ink-gray-6">{group.workspaceIds.length ? group.workspaceIds.map(name).join(", ") : t("work.groups.noWorkspaces")}</p></div>
          <div class="flex flex-wrap items-center gap-2"><Badge variant="outline" theme={group.hostTools ? "amber" : "gray"} label={group.hostTools ? t("work.groups.hostTools") : t("work.groups.noHostTools")} />
            <Button size="sm" variant="outline" disabled={!app.canAdminister()} onClick={() => edit(group)}>{t("work.groups.edit")}</Button></div>
        </li>}</For></ul>
      </Show>
      <TextInput label={t("work.groups.id")} description={t("work.groups.idHint")} value={groupId()} onInput={(event) => setGroupId(event.currentTarget.value.trim())} />
      <Checkbox checked={hostTools()} onCheckedChange={(checked) => setHostTools(checked === true)} label={t("work.groups.allowHost")} />
      <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"><legend class="mb-1 text-interface font-medium text-ink-gray-8">{t("work.groups.workspaces")}</legend>
        <For each={props.workspaces}>{(entry) => <Checkbox checked={chosen().includes(entry.workspaceId)} label={entry.displayName}
          onCheckedChange={(checked) => setChosen(checked === true ? [...new Set([...chosen(), entry.workspaceId])] : chosen().filter((id) => id !== entry.workspaceId))} />}</For>
      </fieldset>
      <p class="m-0 text-caption text-ink-gray-6">{t("work.groups.removeHint")}</p>
      <div><Button variant="solid" theme="blue" size="sm" loading={saver.busy()} disabled={saver.busy() || !valid() || !app.canAdminister() || (hostTools() && chosen().length === 0)}
        onClick={() => void saver.save(() => app.run("runnerGroup.set", { groupId: groupId(), hostTools: hostTools(), workspaceIds: chosen() }), t("work.groups.saved"))}>{t("work.save")}</Button></div>
      <Outcome result={saver.result()} />
    </div>
  </WorkspaceSection>;
}

/** Drain: new work waits, running work finishes, so a deploy interrupts nothing. */
function Drain(props: { settings: EngineSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const drain = () => props.settings.drain;
  const saver = createSaver(props.reload);
  return <WorkspaceSection title={t("work.drain.title")} description={t("work.drain.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-drain={drain().draining ? "on" : "off"}>
      <Alert theme={drain().draining ? "amber" : "gray"} variant="outline" title={drain().draining ? t("work.drain.on") : t("work.drain.off")}
        description={t("work.drain.counts", { running: drain().runningAttempts, queued: drain().queuedJobs })} />
      <div><Button variant={drain().draining ? "solid" : "outline"} theme={drain().draining ? "blue" : "gray"} size="sm" loading={saver.busy()} disabled={saver.busy() || !app.canAdminister()}
        onClick={() => void saver.save(() => app.run("platform.drain.set", { draining: !drain().draining }), drain().draining ? t("work.drain.resumed") : t("work.drain.started"))}>{drain().draining ? t("work.drain.resume") : t("work.drain.start")}</Button></div>
      <Outcome result={saver.result()} />
    </div>
  </WorkspaceSection>;
}

/** What Brain learned from failures, kept for a while and given to the planner. */
function Lessons(props: { items: Lesson[] }): JSX.Element {
  return <WorkspaceSection title={t("work.lessons.title")} description={t("work.lessons.description")}>
    <Show when={props.items.length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7" data-work-lessons-empty>{t("work.lessons.empty")}</p>}>
      <ul class="m-0 flex list-none flex-col gap-2 p-0" data-work-lessons><For each={props.items}>{(lesson) => <li class="flex min-w-0 flex-col gap-0.5 rounded-control border border-outline-gray-1 p-3" data-lesson={lesson.failureClass}>
        <p class="m-0 break-words text-interface font-medium text-ink-gray-9">{lesson.taskTitle}</p>
        <p class="m-0 break-words text-caption text-ink-gray-7">{failureSentence(lesson.failureClass)} · {lesson.outcome === "healed" ? t("work.lessons.healed") : t("work.lessons.parked")}</p>
        <p class="m-0 break-words text-interface text-ink-gray-8">{lesson.lesson}</p>
        <p class="m-0 text-caption text-ink-gray-6">{t("work.lessons.expires")} <DateText value={lesson.expiresAt} /></p>
      </li>}</For></ul>
    </Show>
  </WorkspaceSection>;
}

/** Withdraw the write-ups that no successful tool call backs (an entry published before that rule existed). */
function Withdraw(): JSX.Element {
  const app = useApp();
  const [confirming, setConfirming] = createSignal(false);
  const saver = createSaver(async () => setConfirming(false));
  return <WorkspaceSection title={t("work.withdraw.title")} description={t("work.withdraw.description")}>
    <div class="flex min-w-0 flex-wrap items-center gap-2" data-work-withdraw>
      <Show when={confirming()} fallback={<Button size="sm" variant="outline" disabled={!app.canAdminister()} onClick={() => setConfirming(true)}>{t("work.withdraw.start")}</Button>}>
        <Button size="sm" variant="solid" theme="red" loading={saver.busy()} disabled={saver.busy()} onClick={() => void saver.save(() => app.run("knowledge.withdrawUnobserved", {}), t("work.withdraw.done"))}>{t("work.withdraw.confirm")}</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t("decision.cancel")}</Button>
      </Show>
    </div>
    <Outcome result={saver.result()} />
  </WorkspaceSection>;
}

/**
 * "How work runs" (Administration): which way of working a workspace uses, where its model runs, what its tools may touch, which runner
 * groups may use host tools, pausing new work for a deploy, and the lessons Brain keeps. Each part saves on its own through one command.
 */
export function WorkSettings(): JSX.Element {
  const app = useApp();
  const settings = createScopedRead<EngineSettings>({ scope: app.scope, live: true, load: (scope, signal) => engineSettingsRead(scope.workspaceId, signal) });
  const effects = createScopedRead<EffectSettings>({ scope: app.scope, live: true, load: (scope, signal) => effectSettingsRead(scope.workspaceId, signal) });
  const groups = createScopedRead<RunnerGroupRow[]>({ scope: app.scope, live: true, load: async (_scope, signal) => { const loaded = await runnerGroupsRead(signal); return { ...loaded, snapshot: loaded.snapshot.items }; } });
  const lessons = createScopedRead<Lesson[]>({ scope: app.scope, live: true, load: async (scope, signal) => { const loaded = await lessonsRead(scope.workspaceId, signal); return { ...loaded, snapshot: loaded.snapshot.items }; } });
  const workspaces = createScopedRead<{ workspaceId: string; displayName: string }[]>({ scope: app.scope, load: (_scope, signal) => workspaceChoices(signal) });
  // A plain re-read keeps the sections mounted (a forced one would show the skeleton and drop what each section just said).
  const reload = async () => { await Promise.all([settings.refresh(), effects.refresh(), groups.refresh(), lessons.refresh()]); };
  return <PageStack>
    <p class="m-0 text-interface text-ink-gray-7">{t("work.scope", { workspace: app.workspaceId() })}</p>
    <ScreenRegion state={settings.state()} onRetry={() => void settings.refresh({ force: true })} emptyTitle={t("work.empty.title")} emptyDescription={t("work.empty.description")}>
      <Show when={settings.state().data}>{(data) => <>
        <WayOfWorking settings={data()} reload={reload} />
        <HostedModel settings={data()} reload={reload} />
      </>}</Show>
    </ScreenRegion>
    <ScreenRegion state={effects.state()} onRetry={() => void effects.refresh({ force: true })} emptyTitle={t("work.empty.title")} emptyDescription={t("work.empty.description")}>
      <Show when={effects.state().data}>{(data) => <Effects effects={data()} reload={reload} />}</Show>
    </ScreenRegion>
    <ScreenRegion state={groups.state()} onRetry={() => void groups.refresh({ force: true })} emptyTitle={t("work.groups.title")} emptyDescription={t("work.groups.none")}>
      <Show when={groups.state().data}>{(data) => <RunnerGroups groups={data()} workspaces={workspaces.state().data ?? []} reload={reload} />}</Show>
    </ScreenRegion>
    <Show when={settings.state().data}>{(data) => <Drain settings={data()} reload={reload} />}</Show>
    <Withdraw />
    <ScreenRegion state={lessons.state()} onRetry={() => void lessons.refresh({ force: true })} emptyTitle={t("work.lessons.title")} emptyDescription={t("work.lessons.empty")}>
      <Lessons items={lessons.state().data ?? []} />
    </ScreenRegion>
  </PageStack>;
}
