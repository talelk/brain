import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, Checkbox, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, RadioGroup, Select } from "@talelk/newui-molecules";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { workspaceChoices, effectSettingsRead, engineSettingsRead, lessonsRead, runnerGroupsRead, type CostTier, type EffectSettings, type EngineSettings, type Lesson, type ModelRouteRow, type RunnerGroupRow } from "../../data/engine";
import { DateText, ScreenRegion } from "../screen-region";
import { PageStack } from "./PageLayout";
import { WorkspaceSection } from "./Domain";
import { StepUpDialog } from "./StepUpDialog";
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

/** Dollars per million tokens as typed, to the whole micro-dollars the command carries; nothing when it is empty or not a number. */
const microPrice = (usd: string): number | undefined => { const value = usd.trim() === "" ? Number.NaN : Number(usd); return Number.isFinite(value) && value > 0 ? Math.round(value * 1_000_000) : undefined; };
const usdPrice = (micro: number): string => (micro > 0 ? String(micro / 1_000_000) : "");
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

const ROUTE_STATUS: Readonly<Record<ModelRouteRow["status"], MessageKey>> = { off: "work.hosted.status.off", up: "work.hosted.status.up", down: "work.hosted.status.down", unknown: "work.hosted.status.unknown", quota: "work.routes.status.quota" };
const COST_TIERS: readonly CostTier[] = ["low", "standard", "premium"];
const TIER_LABEL: Readonly<Record<CostTier, MessageKey>> = { low: "work.routes.tier.low", standard: "work.routes.tier.standard", premium: "work.routes.tier.premium" };

/** One route as typed: prices stay text until saved, so a half-typed number is not rewritten under the cursor. */
interface RouteDraft { routeId: string; enabled: boolean; vendor: string; keyRef: string; model: string; baseUrl: string; costTier: CostTier; priceIn: string; priceOut: string }
const draftOf = (route: ModelRouteRow): RouteDraft => ({ routeId: route.routeId, enabled: route.enabled, vendor: route.vendor, keyRef: route.keyRef, model: route.model, baseUrl: route.baseUrl, costTier: route.costTier, priceIn: usdPrice(route.inputMicroUsdPerMTok), priceOut: usdPrice(route.outputMicroUsdPerMTok) });
const newDraft = (existing: readonly RouteDraft[]): RouteDraft => {
  let n = existing.length + 1;
  while (existing.some((route) => route.routeId === `route-${n}`)) n++;
  return { routeId: `route-${n}`, enabled: false, vendor: "", keyRef: "", model: "", baseUrl: "", costTier: "standard", priceIn: "", priceOut: "" };
};

const SLUG = /^[a-z][a-z0-9-]{0,31}$/u;
const httpsAddress = (raw: string): boolean => { try { const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } };
/** The first thing wrong with the routes as typed, in plain words, so a person is never shown a schema error; the Governor checks the same again. */
function routeProblem(routes: readonly RouteDraft[]): string | undefined {
  for (const [index, route] of routes.entries()) {
    const n = String(index + 1);
    if (!SLUG.test(route.routeId.trim())) return t("work.routes.problem.name", { n });
    if (routes.some((other, at) => at < index && other.routeId.trim() === route.routeId.trim())) return t("work.routes.problem.duplicate", { n });
    if (!SLUG.test(route.keyRef.trim()) || /^(?:sk|pk|key|token|secret|bearer)-|[0-9]{8,}/iu.test(route.keyRef.trim())) return t("work.routes.problem.key", { n });
    if (!httpsAddress(route.baseUrl.trim())) return t("work.routes.problem.address", { n });
    if (!route.vendor.trim() || !route.model.trim()) return t("work.routes.problem.model", { n });
    if (microPrice(route.priceIn) === undefined || microPrice(route.priceOut) === undefined) return t("work.routes.problem.prices", { n });
  }
  return undefined;
}

/**
 * The workspace's model routes, in the order they are tried (ADR 0055). A check, a second attempt or the model judge uses the first route that
 * is on and not out of quota; a quota refusal moves on to the next. Off unless an owner turns a route on; the API key lives on the runner and
 * Governor hosts and is only named here by reference.
 */
function ModelRoutes(props: { settings: EngineSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const [edited, setEdited] = createSignal<RouteDraft[] | undefined>();
  const saved = () => props.settings.modelRoutes;
  const list = (): RouteDraft[] => edited() ?? saved().map(draftOf);
  const [problem, setProblem] = createSignal<string | undefined>();
  const change = (next: RouteDraft[]): void => { setEdited(next); setProblem(undefined); };
  const patch = (index: number, fields: Partial<RouteDraft>): void => change(list().map((route, at) => (at === index ? { ...route, ...fields } : route)));
  const move = (index: number, by: -1 | 1): void => { const next = [...list()]; const [route] = next.splice(index, 1); next.splice(index + by, 0, route!); change(next); };
  const statusOf = (routeId: string): ModelRouteRow | undefined => saved().find((route) => route.routeId === routeId);
  const saver = createSaver(async () => { setEdited(undefined); await props.reload(); });
  const payload = () => list().map((route) => ({ routeId: route.routeId.trim(), enabled: route.enabled, vendor: route.vendor.trim(), keyRef: route.keyRef.trim(), model: route.model.trim(), baseUrl: route.baseUrl.trim(), costTier: route.costTier,
    inputMicroUsdPerMTok: microPrice(route.priceIn) ?? 0, outputMicroUsdPerMTok: microPrice(route.priceOut) ?? 0 }));
  return <WorkspaceSection title={t("work.routes.title")} description={t("work.routes.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-hosted>
      <p class="m-0 text-caption text-ink-gray-6">{t("work.hosted.roles")}</p>
      <Show when={list().length > 0} fallback={<p class="m-0 text-interface text-ink-gray-7" data-work-routes-empty>{t("work.routes.none")}</p>}>
        <ol class="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
          <For each={list()}>{(route, index) => {
            const label = (key: MessageKey): string => t("work.routes.label", { label: t(key), n: String(index() + 1) });
            const status = (): ModelRouteRow["status"] => statusOf(route.routeId)?.status ?? "off";
            return <li class="flex min-w-0 flex-col gap-3 rounded-md border border-outline-gray-2 p-3" data-work-route={String(index() + 1)}>
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <span class="text-interface font-medium text-ink-gray-9">{t("work.routes.position", { position: String(index() + 1), name: route.routeId })}</span>
                <Badge variant="outline" theme={status() === "up" ? "green" : status() === "down" || status() === "quota" ? "red" : "gray"} label={t(ROUTE_STATUS[status()])} />
                <Show when={statusOf(route.routeId)?.quotaUntil}>{(until) => <span class="text-caption text-ink-gray-6">{t("work.routes.quotaUntil", { time: new Date(until()).toLocaleTimeString() })}</span>}</Show>
              </div>
              <Checkbox checked={route.enabled} onCheckedChange={(checked) => patch(index(), { enabled: checked === true })} label={label("work.routes.enable")} />
              <div class="grid min-w-0 gap-3 sm:grid-cols-2">
                <TextInput label={label("work.routes.name")} description={t("work.routes.nameHint")} value={route.routeId} onInput={(event) => patch(index(), { routeId: event.currentTarget.value })} />
                <TextInput label={label("work.hosted.vendor")} value={route.vendor} onInput={(event) => patch(index(), { vendor: event.currentTarget.value })} />
                <TextInput label={label("work.hosted.model")} value={route.model} onInput={(event) => patch(index(), { model: event.currentTarget.value })} />
                <TextInput label={label("work.routes.keyRef")} description={t("work.routes.keyRefHint")} value={route.keyRef} onInput={(event) => patch(index(), { keyRef: event.currentTarget.value })} />
              </div>
              <TextInput label={label("work.hosted.address")} description={t("work.hosted.addressHint")} value={route.baseUrl} placeholder="https://" onInput={(event) => patch(index(), { baseUrl: event.currentTarget.value })} />
              <div class="grid min-w-0 gap-3 sm:grid-cols-3">
                <Select label={label("work.routes.tier")} value={route.costTier} onValueChange={(value) => patch(index(), { costTier: (value ?? "standard") as CostTier })} options={COST_TIERS.map((tier) => ({ value: tier, label: t(TIER_LABEL[tier]) }))} />
                <TextInput label={label("work.hosted.priceIn")} type="number" min={0} step="any" inputmode="decimal" value={route.priceIn} onInput={(event) => patch(index(), { priceIn: event.currentTarget.value })} />
                <TextInput label={label("work.hosted.priceOut")} type="number" min={0} step="any" inputmode="decimal" value={route.priceOut} onInput={(event) => patch(index(), { priceOut: event.currentTarget.value })} />
              </div>
              <div class="flex min-w-0 flex-wrap gap-2">
                <Button variant="subtle" theme="gray" size="sm" disabled={index() === 0} aria-label={label("work.routes.up")} onClick={() => move(index(), -1)}>{t("work.routes.up")}</Button>
                <Button variant="subtle" theme="gray" size="sm" disabled={index() === list().length - 1} aria-label={label("work.routes.down")} onClick={() => move(index(), 1)}>{t("work.routes.down")}</Button>
                <Button variant="subtle" theme="red" size="sm" aria-label={label("work.routes.remove")} onClick={() => change(list().filter((_, at) => at !== index()))}>{t("work.routes.remove")}</Button>
              </div>
            </li>;
          }}</For>
        </ol>
      </Show>
      <p class="m-0 text-caption text-ink-gray-6">{t("work.hosted.priceHint")}</p>
      <div class="flex min-w-0 flex-wrap gap-2">
        <Button variant="subtle" theme="gray" size="sm" disabled={list().length >= 8 || !app.canAdminister()} onClick={() => change([...list(), newDraft(list())])}>{t("work.routes.add")}</Button>
        <Button variant="solid" theme="blue" size="sm" loading={saver.busy()} disabled={saver.busy() || !app.canAdminister()}
          onClick={() => { const wrong = routeProblem(list()); setProblem(wrong); if (!wrong) void saver.save(() => app.run("workspace.modelRoutes.set", { routes: payload() }), t("work.routes.saved")); }}>{t("work.save")}</Button>
      </div>
      <Show when={problem()}>{(text) => <p role="alert" class="m-0 text-interface text-ink-red-8" data-work-routes-problem>{text()}</p>}</Show>
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

/** The hosts a sandboxed tool of this workspace may reach through the egress proxy; none means the tool has no network (ADR 0037). */
const egressEntryOk = (entry: string): boolean => {
  const colon = entry.lastIndexOf(":");
  const host = (colon < 0 ? entry : entry.slice(0, colon)).toLowerCase();
  const port = colon < 0 ? undefined : entry.slice(colon + 1);
  return host.length >= 1 && host.length <= 253 && /^[a-z0-9.-]+$/u.test(host) && /^[a-z0-9]/u.test(host) && /[a-z0-9]$/u.test(host) && !/\.\.|\.-|-\./u.test(host)
    && (port === undefined || (/^[0-9]{1,5}$/u.test(port) && Number(port) >= 1 && Number(port) <= 65535));
};
function EgressHosts(props: { effects: EffectSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const [hosts, setHosts] = createSignal<string | undefined>();
  const saver = createSaver(async () => { setHosts(undefined); await props.reload(); });
  const entries = () => lines(hosts() ?? props.effects.egressHosts.join("\n"));
  const invalid = () => entries().filter((entry) => !egressEntryOk(entry));
  return <WorkspaceSection title={t("work.egress.title")} description={t("work.egress.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-egress>
      <p class="m-0 break-words text-interface text-ink-gray-8" data-work-egress-current>{props.effects.egressHosts.length ? t("work.egress.summary", { hosts: props.effects.egressHosts.join(", ") }) : t("work.egress.none")}</p>
      <Textarea label={t("work.egress.hosts")} description={t("work.egress.hint")} rows={4} value={hosts() ?? props.effects.egressHosts.join("\n")} onInput={(event) => setHosts(event.currentTarget.value)} />
      <Show when={invalid().length > 0}><p role="alert" class="m-0 break-words text-interface text-ink-red-8">{t("work.egress.invalid", { entries: invalid().join(", ") })}</p></Show>
      <div><Button variant="solid" theme="blue" size="sm" loading={saver.busy()} disabled={saver.busy() || !app.canAdminister() || invalid().length > 0}
        onClick={() => void saver.save(() => app.run("workspace.effects.set", { egressHosts: entries() }), t("work.egress.saved"))}>{t("work.save")}</Button></div>
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

/** How many tasks of this workspace may wait for a runner before new work is refused with a reason (ADR 0040). */
function QueueLimit(props: { settings: EngineSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const limit = () => props.settings.queueLimit;
  const [typed, setTyped] = createSignal<string | undefined>();
  const saver = createSaver(async () => { setTyped(undefined); await props.reload(); });
  const value = () => Number.parseInt(typed() ?? String(limit().maxQueued), 10);
  return <WorkspaceSection title={t("work.queue.title")} description={t("work.queue.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-queue={limit().queued >= limit().maxQueued ? "full" : "open"}>
      <p class="m-0 break-words text-interface text-ink-gray-8" data-work-queue-current>{t("work.queue.current", { queued: limit().queued, max: limit().maxQueued })}{limit().isDefault ? ` ${t("work.queue.default")}` : ""}</p>
      <TextInput label={t("work.queue.max")} description={t("work.queue.hint")} type="number" min={1} max={10000} inputmode="numeric" value={typed() ?? String(limit().maxQueued)} onInput={(event) => setTyped(event.currentTarget.value)} />
      <div><Button variant="solid" theme="blue" size="sm" loading={saver.busy()} disabled={saver.busy() || !app.canAdminister() || !(value() >= 1 && value() <= 10000)}
        onClick={() => void saver.save(() => app.run("workspace.queueLimit.set", { maxQueued: value() }), t("work.queue.saved"))}>{t("work.save")}</Button></div>
      <Outcome result={saver.result()} />
    </div>
  </WorkspaceSection>;
}

type CeilingPreset = "supervised" | "standard" | "autonomous";
const CEILING_PRESETS: readonly CeilingPreset[] = ["supervised", "standard", "autonomous"];
const CEILING_LABEL: Readonly<Record<CeilingPreset, MessageKey>> = { supervised: "work.ceiling.supervised", standard: "work.ceiling.standard", autonomous: "work.ceiling.autonomous" };
const CEILING_HINT: Readonly<Record<CeilingPreset, MessageKey>> = { supervised: "work.ceiling.supervised.hint", standard: "work.ceiling.standard.hint", autonomous: "work.ceiling.autonomous.hint" };

/** The most autonomy any mission of this workspace may be given (the workspace autonomy ceiling): changing it needs a fresh step-up. */
function AutonomyCeiling(props: { settings: EngineSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const current = () => props.settings.autonomyCeiling;
  const [chosen, setChosen] = createSignal<CeilingPreset | undefined>();
  const [confirming, setConfirming] = createSignal(false);
  const [done, setDone] = createSignal<string | undefined>();
  const selected = (): CeilingPreset => chosen() ?? current().preset;
  const changed = () => current().preset !== selected();
  const mayChange = () => Boolean(app.identity()?.actor.scopes.includes("config:activate"));
  return <WorkspaceSection title={t("work.ceiling.title")} description={t("work.ceiling.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-ceiling={current().preset}>
      <p class="m-0 break-words text-interface text-ink-gray-8" data-work-ceiling-current>{current().isDefault ? t("work.ceiling.default") : t("work.ceiling.current", { preset: t(CEILING_LABEL[current().preset]) })}</p>
      <RadioGroup label={t("work.ceiling.choose")} value={selected()} disabled={!mayChange()} onValueChange={(value) => { setChosen(value as CeilingPreset); setDone(undefined); }}
        items={CEILING_PRESETS.map((preset) => ({ value: preset, label: t(CEILING_LABEL[preset]), description: t(CEILING_HINT[preset]) }))} />
      <div><Button variant="solid" theme="blue" size="sm" disabled={!mayChange() || !changed()} onClick={() => setConfirming(true)}>{t("work.ceiling.change")}</Button></div>
      <Show when={!mayChange()}><p class="m-0 text-caption text-ink-gray-6">{t("work.ceiling.needsAdmin")}</p></Show>
      <Show when={done()}>{(text) => <p role="status" class="m-0 text-interface text-ink-green-8">{text()}</p>}</Show>
    </div>
    <StepUpDialog open={confirming()} onClose={() => setConfirming(false)} command="workspace.autonomyCeiling.set" change={() => ({ preset: selected() })}
      title={t("work.ceiling.confirmTitle")} description={t("work.ceiling.confirmDescription", { preset: t(CEILING_LABEL[selected()]) })} confirmLabel={t("work.ceiling.confirm")}
      onDone={async () => { const preset = t(CEILING_LABEL[selected()]); setConfirming(false); setChosen(undefined); await props.reload(); setDone(t("work.ceiling.saved", { preset })); }}>
      <p class="m-0 break-words text-interface text-ink-gray-8">{t(CEILING_HINT[selected()])}</p>
    </StepUpDialog>
  </WorkspaceSection>;
}

/** The emergency stop: every running session of this workspace ends at once and every active mission pauses, with the reason. */
function StopAll(props: { settings: EngineSettings; reload: () => Promise<unknown> }): JSX.Element {
  const app = useApp();
  const live = () => props.settings.liveWork;
  const [confirming, setConfirming] = createSignal(false);
  const [reason, setReason] = createSignal("");
  const [done, setDone] = createSignal<string | undefined>();
  const mayStop = () => app.myRoles().includes("workspace-lead");
  return <WorkspaceSection title={t("work.stop.title")} description={t("work.stop.description")}>
    <div class="flex min-w-0 flex-col gap-3" data-work-stop>
      <p class="m-0 break-words text-interface text-ink-gray-8" data-work-stop-live>{live().sessions > 0 ? t("work.stop.live", { count: live().sessions }) : t("work.stop.idle")}</p>
      <div><Button variant="outline" theme="red" size="sm" disabled={!mayStop()} onClick={() => { setDone(undefined); setConfirming(true); }}>{t("work.stop.start")}</Button></div>
      <Show when={!mayStop()}><p class="m-0 text-caption text-ink-gray-6">{t("work.stop.needsAdmin")}</p></Show>
      <Show when={done()}>{(text) => <p role="status" class="m-0 text-interface text-ink-green-8" data-work-stop-done>{text()}</p>}</Show>
    </div>
    <StepUpDialog open={confirming()} onClose={() => setConfirming(false)} command="workspace.sessions.stopAll" tone="red" ready={reason().trim().length > 0} change={() => ({ reason: reason().trim() })}
      title={t("work.stop.confirmTitle")} description={t("work.stop.confirmDescription", { workspace: app.workspaceId() })} confirmLabel={t("work.stop.confirm")}
      onDone={async () => { const sessions = live().sessions; setConfirming(false); setReason(""); await props.reload(); setDone(t("work.stop.done", { count: sessions })); }}>
      <ul class="m-0 flex list-none flex-col gap-1 p-0 text-interface text-ink-gray-8" data-work-stop-names>
        <li>{live().sessions > 0 ? t("work.stop.confirm.sessions", { count: live().sessions }) : t("work.stop.confirm.none")}</li>
        <Show when={live().standalone > 0}><li>{t("work.stop.confirm.standalone", { count: live().standalone })}</li></Show>
        <Show when={live().waiting > 0}><li>{t("work.stop.confirm.waiting", { count: live().waiting })}</li></Show>
        <Show when={live().missions.length > 0}><li>{t("work.stop.confirm.missions")}
          <ul class="m-0 mt-1 flex list-none flex-col gap-0.5 ps-3" data-work-stop-missions><For each={live().missions}>{(mission) => <li class="break-words" data-stop-mission={mission.missionId}>{mission.title}{mission.sessions > 0 ? ` · ${t("work.stop.confirm.running", { count: mission.sessions })}` : ""}</li>}</For>
            <Show when={live().moreMissions > 0}><li>{t("work.stop.confirm.more", { count: live().moreMissions })}</li></Show></ul></li></Show>
      </ul>
      <p class="m-0 text-caption text-ink-gray-6">{t("work.stop.confirm.effects")}</p>
      <Textarea label={t("work.stop.reason")} description={t("work.stop.reasonHint")} rows={3} value={reason()} onInput={(event) => setReason(event.currentTarget.value)} />
    </StepUpDialog>
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
  // Withdrawing knowledge is a workspace lead's command (it needs memory:publish), which an organization administrator may not hold.
  const mayWithdraw = () => app.myRoles().includes("workspace-lead");
  return <WorkspaceSection title={t("work.withdraw.title")} description={t("work.withdraw.description")}>
    <div class="flex min-w-0 flex-wrap items-center gap-2" data-work-withdraw>
      <Show when={confirming()} fallback={<Button size="sm" variant="outline" disabled={!mayWithdraw()} onClick={() => setConfirming(true)}>{t("work.withdraw.start")}</Button>}>
        <Button size="sm" variant="solid" theme="red" loading={saver.busy()} disabled={saver.busy()} onClick={() => void saver.save(() => app.run("knowledge.withdrawUnobserved", {}), t("work.withdraw.done"))}>{t("work.withdraw.confirm")}</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t("decision.cancel")}</Button>
      </Show>
    </div>
    <Show when={!mayWithdraw()}><p class="m-0 text-caption text-ink-gray-6">{t("work.withdraw.needsLead")}</p></Show>
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
        <ModelRoutes settings={data()} reload={reload} />
        <AutonomyCeiling settings={data()} reload={reload} />
      </>}</Show>
    </ScreenRegion>
    <ScreenRegion state={effects.state()} onRetry={() => void effects.refresh({ force: true })} emptyTitle={t("work.empty.title")} emptyDescription={t("work.empty.description")}>
      <Show when={effects.state().data}>{(data) => <><Effects effects={data()} reload={reload} /><EgressHosts effects={data()} reload={reload} /></>}</Show>
    </ScreenRegion>
    <ScreenRegion state={groups.state()} onRetry={() => void groups.refresh({ force: true })} emptyTitle={t("work.groups.title")} emptyDescription={t("work.groups.none")}>
      <Show when={groups.state().data}>{(data) => <RunnerGroups groups={data()} workspaces={workspaces.state().data ?? []} reload={reload} />}</Show>
    </ScreenRegion>
    <Show when={settings.state().data}>{(data) => <><QueueLimit settings={data()} reload={reload} /><Drain settings={data()} reload={reload} /><StopAll settings={data()} reload={reload} /></>}</Show>
    <Withdraw />
    <ScreenRegion state={lessons.state()} onRetry={() => void lessons.refresh({ force: true })} emptyTitle={t("work.lessons.title")} emptyDescription={t("work.lessons.empty")}>
      <Lessons items={lessons.state().data ?? []} />
    </ScreenRegion>
  </PageStack>;
}
