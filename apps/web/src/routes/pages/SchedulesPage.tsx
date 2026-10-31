import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Section } from "@talelk/newui-organisms";
import { Alert, Select } from "@talelk/newui-molecules";
import type { Automation, AutomationOccurrence } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { formatDateTime } from "../../ui/format";
import { RefreshButton } from "../../ui/components/primitives";

function triggerSummary(automation: Automation): string {
  if (automation.trigger.kind === "cron") return `${automation.trigger.cron} · ${automation.trigger.timezone}`;
  if (automation.trigger.kind === "once") return `Once at ${formatDateTime(automation.trigger.scheduledAt)}`;
  return "Manual (Run now)";
}

export default function SchedulesPage(): JSX.Element {
  const app = useApp();
  const [title, setTitle] = createSignal("");
  const [targetKind, setTargetKind] = createSignal("workflow");
  const [targetId, setTargetId] = createSignal("");
  const [triggerKind, setTriggerKind] = createSignal("cron");
  const [cron, setCron] = createSignal("");
  const [timezone, setTimezone] = createSignal("UTC");
  const [scheduledAt, setScheduledAt] = createSignal("");
  const [overlap, setOverlap] = createSignal("skip");
  const [misfire, setMisfire] = createSignal("skip");
  const [executionMode, setExecutionMode] = createSignal("managed");
  const [runnerId, setRunnerId] = createSignal("");
  const [offlinePolicy, setOfflinePolicy] = createSignal("wait");
  const [inputJson, setInputJson] = createSignal("");
  const [selectedId, setSelectedId] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const automations = createScopedRead<{ items: Automation[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: Automation[] }; asOf: string; sourceWatermark: number }>({ queryType: "automations.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
    refreshMs: 15_000,
  });
  const history = createScopedRead<{ items: AutomationOccurrence[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const id = selectedId();
      if (!id) return { snapshot: { items: [] }, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: AutomationOccurrence[] }; asOf: string; sourceWatermark: number }>({ queryType: "automations.occurrences", workspaceId: scope.workspaceId, resourceId: id }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
    refreshMs: 15_000,
  });

  async function control(automation: Automation, action: "pause" | "resume" | "runNow") {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const result = await app.run("automation.control", { automationId: automation.automationId, action }, { expectedVersion: automation.version });
      if (!result.accepted) throw new Error(result.detail);
      await Promise.all([automations.refresh({ force: true }), history.refresh({ force: true })]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The automation action was refused"); }
    finally { setBusy(false); }
  }

  async function create() {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      let input: unknown;
      if (inputJson().trim()) input = JSON.parse(inputJson());
      const created = await app.run("automation.upsert", {
        ...(title().trim() ? { title: title().trim() } : {}),
        target: { kind: targetKind() as "workflow" | "workItem", id: targetId().trim() },
        trigger: triggerKind() === "cron" ? { kind: "cron", cron: cron().trim(), timezone: timezone().trim() || "UTC" }
          : triggerKind() === "once" ? { kind: "once", scheduledAt: new Date(scheduledAt().trim()).toISOString() }
          : { kind: "manual" },
        overlap: overlap() as "skip" | "queue-one",
        misfire: misfire() as "skip" | "coalesce",
        execution: executionMode() === "personal-host" ? { mode: "personal-host", runnerId: runnerId().trim(), offlinePolicy: offlinePolicy() as "wait" | "fail" } : { mode: "managed" },
        ...(input !== undefined ? { input: input as never } : {}),
      });
      if (!created.accepted) throw new Error(created.detail);
      setTitle(""); setTargetId(""); setCron(""); setScheduledAt(""); setInputJson("");
      await automations.refresh({ force: true });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The automation was refused"); }
    finally { setBusy(false); }
  }

  return <BrainPage title="Schedules" description="One durable scheduler for work items and released workflows. Occurrences are computed and fired server-side."
    actions={<RefreshButton onClick={() => void automations.refresh({ force: true })} />}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Automation action failed" description={error()} /></Show>
      <Section title="New automation" description="A revision replaces the schedule going forward; past occurrences and their runs are never rewritten." surface="card">
        <div class="flex flex-col gap-4">
          <div class="brain-field-grid">
            <TextInput label="Title" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Nightly triage" />
            <Select label="Target kind" value={targetKind()} options={[{ value: "workflow", label: "Released workflow" }, { value: "workItem", label: "Work item scheduled start" }]} onValueChange={(value) => setTargetKind(value ?? "workflow")} />
            <TextInput label="Target id" value={targetId()} onInput={(event) => setTargetId(event.currentTarget.value)} description={targetKind() === "workflow" ? "Workflow id from the active release" : "Work item id from the board"} placeholder={targetKind() === "workflow" ? "operations-triage" : "work item id"} />
          </div>
          <div class="flex flex-col gap-3">
            <p class="text-2xs font-semibold uppercase tracking-wider text-ink-gray-5">Trigger</p>
            <div class="brain-field-grid">
              <Select label="Trigger" value={triggerKind()} options={[{ value: "cron", label: "Recurring (cron)" }, { value: "once", label: "One-off delayed" }, { value: "manual", label: "Manual (Run now)" }]} onValueChange={(value) => setTriggerKind(value ?? "cron")} />
              <Show when={triggerKind() === "cron"}>
                <TextInput label="Cron expression" value={cron()} onInput={(event) => setCron(event.currentTarget.value)} placeholder="*/15 * * * *" description="Five fields; minute granularity" />
                <TextInput label="Timezone" value={timezone()} onInput={(event) => setTimezone(event.currentTarget.value)} placeholder="Europe/Paris" description="IANA timezone; DST policies apply" />
              </Show>
              <Show when={triggerKind() === "once"}>
                <TextInput label="Run at" value={scheduledAt()} onInput={(event) => setScheduledAt(event.currentTarget.value)} placeholder={new Date(Date.now() + 3600_000).toISOString()} description="ISO 8601 instant, in the future" />
              </Show>
            </div>
          </div>
          <div class="flex flex-col gap-3">
            <p class="text-2xs font-semibold uppercase tracking-wider text-ink-gray-5">Policies</p>
            <div class="brain-field-grid">
              <Select label="Overlap" value={overlap()} options={[{ value: "skip", label: "Skip while the previous run is unfinished" }, { value: "queue-one", label: "Queue one more" }]} onValueChange={(value) => setOverlap(value ?? "skip")} />
              <Select label="Missed fires" value={misfire()} options={[{ value: "skip", label: "Skip and continue in the future" }, { value: "coalesce", label: "Coalesce into one fire" }]} onValueChange={(value) => setMisfire(value ?? "skip")} />
              <Select label="Execution host" value={executionMode()} options={[{ value: "managed", label: "Managed runners" }, { value: "personal-host", label: "Personal host only" }]} onValueChange={(value) => setExecutionMode(value ?? "managed")} />
              <Show when={executionMode() === "personal-host"}>
                <TextInput label="Personal runner id" value={runnerId()} onInput={(event) => setRunnerId(event.currentTarget.value)} placeholder="runner-agents-1" description="Scheduled jobs are pinned to this runner; no managed fallback" />
                <Select label="When the personal host is offline" value={offlinePolicy()} options={[{ value: "wait", label: "Wait and keep the occurrence pending" }, { value: "fail", label: "Fail the occurrence without starting a run" }]} onValueChange={(value) => setOfflinePolicy(value ?? "wait")} />
              </Show>
            </div>
          </div>
        </div>
        <Textarea label="Workflow input (JSON, optional)" value={inputJson()} onInput={(event) => setInputJson(event.currentTarget.value)} placeholder='{"situation": "Scheduled check"}' />
        <Button size="lg" theme="blue" loading={busy()} disabled={busy() || !targetId().trim() || (executionMode() === "personal-host" && !runnerId().trim()) || (triggerKind() === "cron" && !cron().trim()) || (triggerKind() === "once" && !scheduledAt().trim())} onClick={() => void create()}>Create automation</Button>
      </Section>

      <ScreenRegion state={automations.state()} onRetry={() => void automations.refresh()} emptyTitle="No automations yet" emptyDescription="Create a schedule above; occurrences and history appear here.">
        <div class="flex flex-col gap-3">
          <For each={automations.state().data?.items}>{(automation) => <article class="flex flex-col gap-3 rounded-card border border-outline-gray-2 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div><strong>{automation.title}</strong><span class="ms-2 text-caption text-ink-gray-6">rev {automation.revision} · record v{automation.version} · {automation.target.kind} {automation.target.id}</span></div>
              <StatusBadge kind="automation" status={automation.state} />
            </div>
            <p class="text-caption text-ink-gray-7">{triggerSummary(automation)} · overlap {automation.overlap} · missed fires {automation.misfire}</p>
            <p class="text-caption text-ink-gray-6">{automation.execution.mode === "personal-host" ? `Personal host ${automation.execution.runnerId} · offline ${automation.execution.offlinePolicy}` : "Managed runners"}</p>
            <Show when={automation.nextOccurrences?.length}>
              <p class="text-caption text-ink-gray-6">Next: <For each={automation.nextOccurrences}>{(at, index) => <>{index() > 0 && ", "}<DateText value={at} /></>}</For></p>
            </Show>
            <div class="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy() || automation.state !== "active"} onClick={() => void control(automation, "pause")}>Pause</Button>
              <Button size="sm" variant="outline" disabled={busy() || automation.state !== "paused"} onClick={() => void control(automation, "resume")}>Resume</Button>
              <Button size="sm" theme="blue" disabled={busy()} onClick={() => void control(automation, "runNow")}>Run now</Button>
              <Button size="sm" variant="ghost" onClick={() => { setSelectedId(automation.automationId === selectedId() ? "" : automation.automationId); void history.refresh({ force: true }); }}>{automation.automationId === selectedId() ? "Hide history" : "History"}</Button>
            </div>
            <Show when={automation.automationId === selectedId()}>
              <ScreenRegion state={history.state()} onRetry={() => void history.refresh()} emptyTitle="No occurrences yet" emptyDescription="Planned instants appear here with their run links.">
                <ul class="flex flex-col gap-1 text-caption text-ink-gray-7"><For each={history.state().data?.items}>{(occurrence) => <li>
                  <DateText value={occurrence.plannedAt} /> · <StatusBadge kind="occurrence" status={occurrence.state} />{occurrence.dispatchRef && <> · {occurrence.dispatchRef}</>}{occurrence.detail && <> · {occurrence.detail}</>}
                </li>}</For></ul>
              </ScreenRegion>
            </Show>
          </article>}</For>
        </div>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
