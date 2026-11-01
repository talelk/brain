import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { WorkspaceSection } from "../../ui/components/Domain";
import type { Automation, AutomationOccurrence } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { formatDateTime } from "../../ui/format";
import { RefreshButton } from "../../ui/components/primitives";
import { ReasonDialog } from "../../ui/components/ReasonDialog";

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
  const [editing, setEditing] = createSignal<Automation>();
  const [editorMode, setEditorMode] = createSignal<"create" | "edit" | "duplicate">("create");
  const [retiring, setRetiring] = createSignal<Automation>();
  const [retireReason, setRetireReason] = createSignal("");
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

  function resetEditor() {
    setEditing(undefined); setEditorMode("create"); setTitle(""); setTargetKind("workflow"); setTargetId("");
    setTriggerKind("cron"); setCron(""); setTimezone("UTC"); setScheduledAt(""); setOverlap("skip"); setMisfire("skip");
    setExecutionMode("managed"); setRunnerId(""); setOfflinePolicy("wait"); setInputJson(""); setError("");
  }

  function loadEditor(automation: Automation, mode: "edit" | "duplicate") {
    setEditing(automation); setEditorMode(mode); setTitle(mode === "duplicate" ? `Copy of ${automation.title}` : automation.title);
    setTargetKind(automation.target.kind); setTargetId(automation.target.id); setTriggerKind(automation.trigger.kind);
    setCron(automation.trigger.kind === "cron" ? automation.trigger.cron : "");
    setTimezone(automation.trigger.kind === "cron" ? automation.trigger.timezone : "UTC");
    setScheduledAt(automation.trigger.kind === "once" ? automation.trigger.scheduledAt : "");
    setOverlap(automation.overlap); setMisfire(automation.misfire); setExecutionMode(automation.execution.mode);
    setRunnerId(automation.execution.mode === "personal-host" ? automation.execution.runnerId : "");
    setOfflinePolicy(automation.execution.mode === "personal-host" ? automation.execution.offlinePolicy : "wait");
    setInputJson(automation.input === undefined ? "" : JSON.stringify(automation.input, null, 2)); setError("");
  }

  async function control(automation: Automation, action: "pause" | "resume" | "runNow" | "retire", reason?: string) {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      const result = await app.run("automation.control", { automationId: automation.automationId, action, ...(reason ? { reason } : {}) }, { expectedVersion: automation.version });
      if (!result.accepted) throw new Error(result.detail);
      if (editing()?.automationId === automation.automationId) resetEditor();
      await Promise.all([automations.refresh({ force: true }), history.refresh({ force: true })]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The automation action was refused"); }
    finally { setBusy(false); }
  }

  async function save() {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      let input: unknown;
      if (inputJson().trim()) input = JSON.parse(inputJson());
      const current = editing();
      const saved = await app.run("automation.upsert", {
        ...(editorMode() === "edit" && current ? { automationId: current.automationId } : {}),
        ...(title().trim() ? { title: title().trim() } : {}),
        target: { kind: targetKind() as "workflow" | "workItem", id: targetId().trim() },
        trigger: triggerKind() === "cron" ? { kind: "cron", cron: cron().trim(), timezone: timezone().trim() || "UTC" }
          : triggerKind() === "once" ? { kind: "once", scheduledAt: new Date(scheduledAt().trim()).toISOString() }
          : { kind: "manual" },
        overlap: overlap() as "skip" | "queue-one",
        misfire: misfire() as "skip" | "coalesce",
        execution: executionMode() === "personal-host" ? { mode: "personal-host", runnerId: runnerId().trim(), offlinePolicy: offlinePolicy() as "wait" | "fail" } : { mode: "managed" },
        ...(input !== undefined ? { input: input as never } : {}),
      }, editorMode() === "edit" && current ? { expectedVersion: current.version } : {});
      if (!saved.accepted) throw new Error(saved.detail);
      resetEditor();
      await automations.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The automation was refused"); }
    finally { setBusy(false); }
  }

  return <BrainPage title="Schedules" description="Review durable automation and configure its target, trigger and failure policies with server-side occurrence semantics."
    actions={<RefreshButton onClick={() => void automations.refresh({ force: true })} />}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Automation action failed" description={error()} /></Show>
      <div class="brain-studio-layout">
        <WorkspaceSection title="Schedule library" description="Current state, target, timezone and actual next occurrences from Governor.">
          <ScreenRegion state={automations.state()} onRetry={() => void automations.refresh()} emptyTitle="No automations yet" emptyDescription="Configure the first schedule in the guided editor. It becomes active only after server confirmation.">
            <div class="flex flex-col gap-4">
              <For each={automations.state().data?.items}>{(automation) => <article class="border-y border-outline-gray-1 py-4">
                <div class="flex flex-wrap items-start justify-between gap-2"><div><h3 class="text-base-medium">{automation.title}</h3><p class="mt-1 break-words text-caption text-ink-gray-6">{automation.target.kind} · {automation.target.id} · revision {automation.revision}</p></div><StatusBadge kind="automation" status={automation.state} /></div>
                <dl class="mt-3 grid gap-3 text-interface sm:grid-cols-2"><div><dt class="text-caption text-ink-gray-6">Trigger / timezone</dt><dd class="mt-1">{triggerSummary(automation)}</dd></div><div><dt class="text-caption text-ink-gray-6">Execution</dt><dd class="mt-1">{automation.execution.mode === "personal-host" ? `Personal host ${automation.execution.runnerId} · offline ${automation.execution.offlinePolicy}` : "Managed runners"}</dd></div><div><dt class="text-caption text-ink-gray-6">Policies</dt><dd class="mt-1">Overlap {automation.overlap} · missed fires {automation.misfire}</dd></div><div><dt class="text-caption text-ink-gray-6">Next actual fire</dt><dd class="mt-1"><Show when={automation.nextOccurrences?.[0]} fallback="Not currently scheduled"><DateText value={automation.nextOccurrences?.[0]} /></Show></dd></div></dl>
                <Show when={(automation.nextOccurrences?.length ?? 0) > 1}><details class="mt-3 text-caption text-ink-gray-6"><summary class="cursor-pointer">Preview next {automation.nextOccurrences?.length} occurrences</summary><ul class="mt-2 flex flex-col gap-1"><For each={automation.nextOccurrences}>{(occurrence) => <li><DateText value={occurrence} /></li>}</For></ul></details></Show>
                <div class="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy() || automation.state === "retired"} onClick={() => loadEditor(automation, "edit")}>Edit</Button><Button size="sm" variant="outline" disabled={busy()} onClick={() => loadEditor(automation, "duplicate")}>Duplicate</Button><Button size="sm" variant="outline" disabled={busy() || automation.state !== "active"} onClick={() => void control(automation, "pause")}>Pause</Button><Button size="sm" variant="outline" disabled={busy() || automation.state !== "paused"} onClick={() => void control(automation, "resume")}>Resume</Button><Button size="sm" theme="blue" disabled={busy() || automation.state === "retired"} onClick={() => void control(automation, "runNow")}>Run now</Button><Button size="sm" variant="ghost" onClick={() => { setSelectedId(automation.automationId === selectedId() ? "" : automation.automationId); void history.refresh({ force: true }); }}>{automation.automationId === selectedId() ? "Hide history" : "History"}</Button><Button size="sm" variant="ghost" theme="red" disabled={busy() || automation.state === "retired"} onClick={() => setRetiring(automation)}>Retire</Button></div>
                <Show when={automation.automationId === selectedId()}><div class="mt-3 border-t border-outline-gray-1 pt-3"><ScreenRegion state={history.state()} onRetry={() => void history.refresh()} emptyTitle="No occurrences yet" emptyDescription="Planned instants appear here with their run links."><ul class="flex flex-col gap-2 text-caption text-ink-gray-7"><For each={history.state().data?.items}>{(occurrence) => <li><DateText value={occurrence.plannedAt} /> · <StatusBadge kind="occurrence" status={occurrence.state} />{occurrence.dispatchRef && <> · {occurrence.dispatchRef}</>}{occurrence.detail && <> · {occurrence.detail}</>}</li>}</For></ul></ScreenRegion></div></Show>
              </article>}</For>
            </div>
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection title={editorMode() === "edit" ? `Edit ${editing()?.title ?? "schedule"}` : editorMode() === "duplicate" ? "Duplicate schedule" : "Guided schedule editor"} description={editorMode() === "edit" ? "Saving creates a new revision for future occurrences. Existing occurrence history stays attached to this automation." : "The copied or new settings create a separate automation with its own identity and history."}>
          <div class="border-y border-outline-gray-1 py-4"><h3 class="mb-3 text-base-medium">1 · Target</h3><div class="brain-field-grid"><TextInput label="Title" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Nightly triage" /><Select label="Target kind" value={targetKind()} options={[{ value: "workflow", label: "Released workflow" }, { value: "workItem", label: "Work item scheduled start" }]} onValueChange={(value) => setTargetKind(value ?? "workflow")} /><TextInput label="Target id" value={targetId()} onInput={(event) => setTargetId(event.currentTarget.value)} description={targetKind() === "workflow" ? "Workflow id from the active release" : "Work item id from the board"} placeholder={targetKind() === "workflow" ? "operations-triage" : "work item id"} /></div></div>
          <div class="border-b border-outline-gray-1 py-4"><h3 class="mb-3 text-base-medium">2 · Trigger</h3><div class="brain-field-grid"><Select label="Trigger" value={triggerKind()} options={[{ value: "cron", label: "Recurring (cron)" }, { value: "once", label: "One-off delayed" }, { value: "manual", label: "Manual (Run now)" }]} onValueChange={(value) => setTriggerKind(value ?? "cron")} /><Show when={triggerKind() === "cron"}><TextInput label="Cron expression" value={cron()} onInput={(event) => setCron(event.currentTarget.value)} placeholder="*/15 * * * *" description="Five fields; interpreted by Governor at minute granularity" /><TextInput label="Timezone" value={timezone()} onInput={(event) => setTimezone(event.currentTarget.value)} placeholder="Europe/Paris" description="IANA timezone; server runtime handles DST" /></Show><Show when={triggerKind() === "once"}><TextInput label="Run at" value={scheduledAt()} onInput={(event) => setScheduledAt(event.currentTarget.value)} placeholder={new Date(Date.now() + 3600_000).toISOString()} description="ISO 8601 instant, in the future" /></Show></div></div>
          <div class="border-b border-outline-gray-1 py-4"><h3 class="mb-3 text-base-medium">3 · Misfire, overlap and host</h3><div class="brain-field-grid"><Select label="Overlap" value={overlap()} options={[{ value: "skip", label: "Skip while the previous run is unfinished" }, { value: "queue-one", label: "Queue one more" }]} onValueChange={(value) => setOverlap(value ?? "skip")} /><Select label="Missed fires" value={misfire()} options={[{ value: "skip", label: "Skip and continue in the future" }, { value: "coalesce", label: "Coalesce into one fire" }]} onValueChange={(value) => setMisfire(value ?? "skip")} /><Select label="Execution host" value={executionMode()} options={[{ value: "managed", label: "Managed runners" }, { value: "personal-host", label: "Personal host only" }]} onValueChange={(value) => setExecutionMode(value ?? "managed")} /><Show when={executionMode() === "personal-host"}><TextInput label="Personal runner id" value={runnerId()} onInput={(event) => setRunnerId(event.currentTarget.value)} placeholder="runner-agents-1" description="Scheduled jobs are pinned to this runner; no managed fallback" /><Select label="When the personal host is offline" value={offlinePolicy()} options={[{ value: "wait", label: "Wait and keep the occurrence pending" }, { value: "fail", label: "Fail the occurrence without starting a run" }]} onValueChange={(value) => setOfflinePolicy(value ?? "wait")} /></Show></div></div>
          <div class="py-4"><h3 class="mb-3 text-base-medium">4 · Typed input and review</h3><Textarea label="Workflow input (JSON, optional)" value={inputJson()} onInput={(event) => setInputJson(event.currentTarget.value)} placeholder='{"situation": "Scheduled check"}' /><p class="mt-3 text-interface text-ink-gray-7">{title().trim() || "Untitled schedule"} · {targetKind()} {targetId().trim() || "not selected"} · {triggerKind() === "cron" ? `${cron().trim() || "cron not entered"} · ${timezone().trim() || "UTC"}` : triggerKind()}</p><p class="mt-1 text-caption text-ink-gray-6">The browser does not translate cron or predict DST. Governor validates and computes actual occurrences.</p></div>
          <Alert theme="blue" variant="outline" title="Server confirmation required" description={editorMode() === "edit" ? `Governor checks record version ${editing()?.version ?? "—"} before saving. A conflict leaves your edits in place for review.` : "Creating this record does not claim a run fired. The schedule appears active only after Governor accepts it."} />
          <div class="mt-4 flex flex-wrap gap-2"><Button size="lg" theme="blue" loading={busy()} disabled={busy() || !targetId().trim() || (executionMode() === "personal-host" && !runnerId().trim()) || (triggerKind() === "cron" && !cron().trim()) || (triggerKind() === "once" && !scheduledAt().trim())} onClick={() => void save()}>{editorMode() === "edit" ? "Save new revision" : editorMode() === "duplicate" ? "Create duplicate" : "Create automation"}</Button><Show when={editorMode() !== "create"}><Button size="lg" variant="outline" disabled={busy()} onClick={resetEditor}>Cancel</Button></Show></div>
        </WorkspaceSection>
      </div>
      <ReasonDialog open={Boolean(retiring())} onClose={() => { setRetiring(undefined); setRetireReason(""); }} title="Retire this schedule" description="Future occurrences stop. Already-running work and the complete occurrence history are preserved. Duplicating is the safe way to create a replacement." reason={retireReason()} onReason={setRetireReason} reasonLabel="Retirement reason" confirmLabel="Retire schedule" tone="red" onConfirm={(reason) => { const automation = retiring(); if (automation) void control(automation, "retire", reason); setRetiring(undefined); setRetireReason(""); }} />
    </PageStack>
  </BrainPage>;
}
