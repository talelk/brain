import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { JSX } from "solid-js";
import { Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Pagination, Select } from "@talelk/newui-molecules";
import { FormSheet } from "./BrainForm";
import { WorkspaceSection } from "./Domain";import type { Automation, AutomationOccurrence } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../screen-region";
import { StatusBadge } from "./StatusBadge";
import { formatDateTime } from "../format";
import { missionHref } from "../mission-links";
import { ReasonDialog } from "./ReasonDialog";
import { OccurrenceChange } from "../outputs/OccurrenceChange";

function triggerSummary(automation: Automation): string {
  if (automation.trigger.kind === "cron") return `${automation.trigger.cron} · ${automation.trigger.timezone}`;
  if (automation.trigger.kind === "once") return `Once at ${formatDateTime(automation.trigger.scheduledAt)}`;
  return "Manual (Run now)";
}

/** The scheduler's recorded detail, in words a person can act on (#56). Unknown details are kept, never dropped. */
export function plainReason(detail: string): string {
  if (/previous occurrence is still running/i.test(detail)) return "Skipped: the previous run was still going.";
  if (/still open/i.test(detail)) return "Skipped: the mission the previous run started is still open, so no second one was started.";
  if (/missed under the skip/i.test(detail)) return "Skipped: Brain was not running at that time, and this schedule does not catch up.";
  if (/personal host .* (offline|unavailable); offline policy fail/i.test(detail)) return "Failed: the personal computer this schedule is pinned to was offline, and the schedule is set to fail rather than wait.";
  if (/personal host .* (offline|unavailable)/i.test(detail)) return "Waiting: the personal computer this schedule is pinned to is offline; the run starts when it is back.";
  if (/is not in the active release/i.test(detail)) return "Could not start: the play this schedule repeats is no longer in the active release.";
  if (/work item is /i.test(detail)) return `Skipped: ${detail.replace(/^work item is /i, "the task was already ")}.`;
  if (/missions are not available/i.test(detail)) return "Could not start: missions are not available in this workspace.";
  return `Could not start: ${detail}`;
}

const SCHEDULES_PAGE_SIZE = 25;
const OCCURRENCES_PAGE_SIZE = 25;

export type ScheduleTarget = { kind: "workflow" | "workItem" | "play"; id: string; label: string };
const KIND_LABEL: Record<ScheduleTarget["kind"], string> = { play: "Play", workflow: "Task", workItem: "Work item" };

/**
 * The one place schedules are managed: every automation of the workspace with
 * the Play, task or work item it starts, filterable, creatable for any known
 * target; occurrence history stays attached. Plays, tasks and missions only
 * link here (`focus` narrows the list to one target, `create` opens the editor
 * for one).
 */
export function SchedulesPanel(props: { targets: readonly ScheduleTarget[]; focus?: string; create?: string; title?: string; /** Bumped by a caller that just created a schedule elsewhere. */ refreshKey?: number }): JSX.Element {
  const app = useApp();
  const [stateFilter, setStateFilter] = createSignal("");
  const [kindFilter, setKindFilter] = createSignal("");
  const targetLabel = (kind: string, id: string) => props.targets.find((target) => target.kind === kind && target.id === id)?.label ?? id;
  const [title, setTitle] = createSignal("");
  const firstTarget = () => props.focus ? props.targets.find((target) => target.id === props.focus)?.id ?? props.focus : props.targets[0]?.id ?? "";
  const [targetId, setTargetId] = createSignal(firstTarget());
  const targetKind = () => props.targets.find((target) => target.id === targetId())?.kind ?? editing()?.target.kind ?? "workflow";
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
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [editorMode, setEditorMode] = createSignal<"create" | "edit" | "duplicate">("create");
  const [retiring, setRetiring] = createSignal<Automation>();
  const [retireReason, setRetireReason] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [schedulePage, setSchedulePage] = createSignal(1);
  const [occurrencePage, setOccurrencePage] = createSignal(1);

  const schedules = () => (automations.state().data?.items ?? []).filter((automation) =>
    (!props.focus || automation.target.id === props.focus) && (!stateFilter() || automation.state === stateFilter()) && (!kindFilter() || automation.target.kind === kindFilter()));
  const schedulePageCount = () => Math.max(1, Math.ceil(schedules().length / SCHEDULES_PAGE_SIZE));
  const safeSchedulePage = () => Math.min(Math.max(1, schedulePage()), schedulePageCount());
  const visibleSchedules = () => schedules().slice((safeSchedulePage() - 1) * SCHEDULES_PAGE_SIZE, safeSchedulePage() * SCHEDULES_PAGE_SIZE);
  const occurrences = () => history.state().data?.items ?? [];
  const occurrencePageCount = () => Math.max(1, Math.ceil(occurrences().length / OCCURRENCES_PAGE_SIZE));
  const safeOccurrencePage = () => Math.min(Math.max(1, occurrencePage()), occurrencePageCount());
  const visibleOccurrences = () => occurrences().slice((safeOccurrencePage() - 1) * OCCURRENCES_PAGE_SIZE, safeOccurrencePage() * OCCURRENCES_PAGE_SIZE);

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

  createEffect(on(() => props.refreshKey ?? 0, () => void automations.refresh({ force: true }), { defer: true }));
  function resetEditor() {
    setEditing(undefined); setEditorMode("create"); setTitle(""); setTargetId(firstTarget());
    setTriggerKind("cron"); setCron(""); setTimezone("UTC"); setScheduledAt(""); setOverlap("skip"); setMisfire("skip");
    setExecutionMode("managed"); setRunnerId(""); setOfflinePolicy("wait"); setInputJson(""); setError(""); setEditorOpen(false);
  }
  function beginCreate() { resetEditor(); setEditorOpen(true); }
  onMount(() => { if (props.create) { setTargetId(props.create); setEditorOpen(true); } });

  function loadEditor(automation: Automation, mode: "edit" | "duplicate") {
    setEditorOpen(true); setEditing(automation); setEditorMode(mode); setTitle(mode === "duplicate" ? `Copy of ${automation.title}` : automation.title);
    setTargetId(automation.target.id); setTriggerKind(automation.trigger.kind);
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
        target: { kind: targetKind() as "workflow" | "workItem" | "play", id: targetId().trim() },
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

  return <section aria-label="Schedules" class="flex flex-col gap-4">
      <Show when={error()}><Alert theme="red" variant="outline" title="Automation action failed" description={error()} /></Show>
      <div class="brain-page-stack">
        <WorkspaceSection title={props.title ?? "Schedules and triggers"} description="When each schedule starts work, in which timezone, and when it fires next." actions={<><Button variant="outline" iconLeft="lucide-refresh-cw" onClick={() => void automations.refresh({ force: true })}>Refresh</Button><Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={beginCreate}>New schedule</Button></>}>
          <div class="mb-3 flex flex-wrap gap-3"><Select label="State" value={stateFilter()} options={[{ value: "", label: "Any state" }, { value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "retired", label: "Retired" }]} onValueChange={(value) => setStateFilter(value ?? "")} /><Select label="Starts" value={kindFilter()} options={[{ value: "", label: "Anything" }, { value: "play", label: "Plays" }, { value: "workflow", label: "Tasks" }, { value: "workItem", label: "Work items" }]} onValueChange={(value) => setKindFilter(value ?? "")} /></div>
          <ScreenRegion state={automations.state()} onRetry={() => void automations.refresh()} emptyTitle="Nothing is scheduled yet" emptyDescription="Start a Play or task on a timer, or once later. Choose New schedule, pick what it starts and when, and Brain runs it for you.">
            <div class="flex flex-col gap-3">
              <For each={visibleSchedules()}>{(automation) => <article class="border-y border-outline-gray-1 py-3">
                <div class="flex flex-wrap items-start justify-between gap-2"><div class="min-w-0"><h3 class="break-words text-base-medium">{automation.title}</h3><p class="mt-1 break-words text-caption text-ink-gray-6">{KIND_LABEL[automation.target.kind]} · {targetLabel(automation.target.kind, automation.target.id)} · revision {automation.revision}</p></div><StatusBadge kind="automation" status={automation.state} /></div>
                <dl class="mt-2 grid gap-3 text-interface sm:grid-cols-2"><div><dt class="text-caption text-ink-gray-6">Trigger / timezone</dt><dd class="mt-1">{triggerSummary(automation)}</dd></div><div><dt class="text-caption text-ink-gray-6">Execution</dt><dd class="mt-1">{automation.execution.mode === "personal-host" ? <>Personal host <a class="text-ink-blue-3 underline" href={`/runners/${automation.execution.runnerId}`}>{automation.execution.runnerId}</a> · offline {automation.execution.offlinePolicy}</> : "Managed runners"}</dd></div><div><dt class="text-caption text-ink-gray-6">Policies</dt><dd class="mt-1">Overlap {automation.overlap} · missed fires {automation.misfire}</dd></div><div><dt class="text-caption text-ink-gray-6">Next actual fire</dt><dd class="mt-1"><Show when={automation.nextOccurrences?.[0]} fallback="Not currently scheduled"><DateText value={automation.nextOccurrences?.[0]} /></Show></dd></div></dl>
                <Show when={(automation.nextOccurrences?.length ?? 0) > 1}><details class="mt-2 text-caption text-ink-gray-6"><summary class="cursor-pointer">Preview next {automation.nextOccurrences?.length} occurrences</summary><ul class="mt-2 flex flex-col gap-1"><For each={automation.nextOccurrences}>{(occurrence) => <li><DateText value={occurrence} /></li>}</For></ul></details></Show>
                <div class="mt-2 flex flex-wrap gap-2"><Button variant="outline" iconLeft="lucide-pencil" disabled={busy() || automation.state === "retired"} onClick={() => loadEditor(automation, "edit")}>Edit</Button><Button variant="outline" iconLeft="lucide-copy" disabled={busy()} onClick={() => loadEditor(automation, "duplicate")}>Duplicate</Button><Button variant="outline" iconLeft="lucide-pause" disabled={busy() || automation.state !== "active"} onClick={() => void control(automation, "pause")}>Pause</Button><Button variant="outline" iconLeft="lucide-play" disabled={busy() || automation.state !== "paused"} onClick={() => void control(automation, "resume")}>Resume</Button><Button variant="outline" theme="blue" iconLeft="lucide-zap" disabled={busy() || automation.state === "retired"} onClick={() => void control(automation, "runNow")}>Run now</Button><Button variant="ghost" iconLeft="lucide-history" onClick={() => { setSelectedId(automation.automationId === selectedId() ? "" : automation.automationId); setOccurrencePage(1); void history.refresh({ force: true }); }}>{automation.automationId === selectedId() ? "Hide history" : "History"}</Button><Button variant="ghost" theme="red" iconLeft="lucide-archive" disabled={busy() || automation.state === "retired"} onClick={() => setRetiring(automation)}>Retire</Button></div>
                <Show when={automation.automationId === selectedId()}><div class="mt-2 border-t border-outline-gray-1 pt-3"><ScreenRegion state={history.state()} onRetry={() => void history.refresh()} emptyTitle="No occurrences yet" emptyDescription="Planned instants appear here with their run links."><ul class="flex flex-col gap-2 text-caption text-ink-gray-7"><For each={visibleOccurrences()}>{(occurrence) => <li class="flex flex-col gap-1 break-words"><span><DateText value={occurrence.plannedAt} /> · <StatusBadge kind="occurrence" status={occurrence.state} />{occurrence.dispatchRef?.startsWith("mission-") && <> · <a class="text-ink-blue-link underline" data-testid="occurrence-mission" href={missionHref(app.workspaceId(), occurrence.dispatchRef, "outputs")}>Open the mission</a></>}{occurrence.dispatchRef && !occurrence.dispatchRef.startsWith("mission-") && <> · {occurrence.dispatchRef}</>}</span>{occurrence.detail && <span class="text-ink-gray-7" data-testid="occurrence-reason">{plainReason(occurrence.detail)}</span>}<Show when={occurrence.state === "dispatched"}><OccurrenceChange refId={occurrence.occurrenceId} /></Show></li>}</For></ul><Show when={occurrences().length > OCCURRENCES_PAGE_SIZE}><div class="mt-2 flex justify-center border-t border-outline-gray-1 pt-3"><Pagination.Root count={occurrences().length} pageSize={OCCURRENCES_PAGE_SIZE} page={safeOccurrencePage()} onPageChange={setOccurrencePage} aria-label="Occurrence history pagination"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /><Pagination.Range class="ms-2" /></Pagination.Root></div></Show></ScreenRegion></div></Show>
              </article>}</For>
            </div>
            <Show when={schedules().length > SCHEDULES_PAGE_SIZE}><div class="mt-4 flex justify-center border-t border-outline-gray-1 pt-3"><Pagination.Root count={schedules().length} pageSize={SCHEDULES_PAGE_SIZE} page={safeSchedulePage()} onPageChange={setSchedulePage} aria-label="Schedule library pagination"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /><Pagination.Range class="ms-2" /></Pagination.Root></div></Show>
          </ScreenRegion>
        </WorkspaceSection>
        <FormSheet size="xl" centered={editorMode() === "create"} open={editorOpen()} onClose={resetEditor} title={editorMode() === "edit" ? `Edit ${editing()?.title ?? "schedule"}` : editorMode() === "duplicate" ? "Duplicate schedule" : "Guided schedule editor"} description={editorMode() === "edit" ? "Saving creates a new revision for future occurrences. Existing occurrence history stays attached to this automation." : "The copied or new settings create a separate automation with its own identity and history."}
          submit={editorMode() === "edit" ? "Save new revision" : editorMode() === "duplicate" ? "Create duplicate" : "Create automation"} icon={editorMode() === "edit" ? "lucide-save" : editorMode() === "duplicate" ? "lucide-copy" : "lucide-plus"} busy={busy()} disabled={!targetId().trim() || (executionMode() === "personal-host" && !runnerId().trim()) || (triggerKind() === "cron" && !cron().trim()) || (triggerKind() === "once" && !scheduledAt().trim())} onSubmit={save} error={error()} errorTitle="The automation was refused">
          <div class="border-y border-outline-gray-1 py-3"><h3 class="mb-3 text-base-medium">1 · Target</h3><div class="brain-field-grid"><TextInput label="Schedule title" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Nightly triage" /><Select label="Target" value={targetId()} options={props.targets.map((target) => ({ value: target.id, label: `${KIND_LABEL[target.kind]} · ${target.label}` }))} onValueChange={(value) => setTargetId(value ?? firstTarget())} /></div></div>
          <div class="border-b border-outline-gray-1 py-3"><h3 class="mb-3 text-base-medium">2 · Trigger</h3><div class="brain-field-grid"><Select label="Trigger" value={triggerKind()} options={[{ value: "cron", label: "Recurring (cron)" }, { value: "once", label: "One-off delayed" }, { value: "manual", label: "Manual (Run now)" }]} onValueChange={(value) => setTriggerKind(value ?? "cron")} /><Show when={triggerKind() === "cron"}><TextInput label="Cron expression" value={cron()} onInput={(event) => setCron(event.currentTarget.value)} placeholder="*/15 * * * *" description="Five fields; interpreted by Brain at minute granularity" /><TextInput label="Timezone" value={timezone()} onInput={(event) => setTimezone(event.currentTarget.value)} placeholder="Europe/Paris" description="IANA timezone; server runtime handles DST" /></Show><Show when={triggerKind() === "once"}><TextInput label="Run at" value={scheduledAt()} onInput={(event) => setScheduledAt(event.currentTarget.value)} placeholder={new Date(Date.now() + 3600_000).toISOString()} description="ISO 8601 instant, in the future" /></Show></div></div>
          <div class="border-b border-outline-gray-1 py-3"><h3 class="mb-3 text-base-medium">3 · Misfire, overlap and host</h3><div class="brain-field-grid"><Select label="Overlap" value={overlap()} options={[{ value: "skip", label: "Skip while the previous run is unfinished" }, { value: "queue-one", label: "Queue one more" }]} onValueChange={(value) => setOverlap(value ?? "skip")} /><Select label="Missed fires" value={misfire()} options={[{ value: "skip", label: "Skip and continue in the future" }, { value: "coalesce", label: "Coalesce into one fire" }]} onValueChange={(value) => setMisfire(value ?? "skip")} /><Select label="Execution host" value={executionMode()} options={[{ value: "managed", label: "Managed runners" }, { value: "personal-host", label: "Personal host only" }]} onValueChange={(value) => setExecutionMode(value ?? "managed")} /><Show when={executionMode() === "personal-host"}><TextInput label="Personal runner id" value={runnerId()} onInput={(event) => setRunnerId(event.currentTarget.value)} placeholder="runner-agents-1" description="Scheduled jobs are pinned to this runner; no managed fallback" /><Select label="When the personal host is offline" value={offlinePolicy()} options={[{ value: "wait", label: "Wait and keep the occurrence pending" }, { value: "fail", label: "Fail the occurrence without starting a run" }]} onValueChange={(value) => setOfflinePolicy(value ?? "wait")} /></Show></div></div>
          <div class="py-3"><h3 class="mb-3 text-base-medium">4 · Typed input and review</h3><Textarea label="Workflow input (JSON, optional)" value={inputJson()} onInput={(event) => setInputJson(event.currentTarget.value)} placeholder='{"situation": "Scheduled check"}' /><p class="mt-2 break-words text-interface text-ink-gray-7">{title().trim() || "Untitled schedule"} · {targetKind()} {targetId().trim() || "not selected"} · {triggerKind() === "cron" ? `${cron().trim() || "cron not entered"} · ${timezone().trim() || "UTC"}` : triggerKind()}</p><p class="mt-1 text-caption text-ink-gray-6">The browser does not translate cron or predict DST. Brain validates and computes actual occurrences.</p></div>
          <Alert theme="blue" variant="outline" title="Server confirmation required" description={editorMode() === "edit" ? `Brain checks record version ${editing()?.version ?? "—"} before saving. A conflict leaves your edits in place for review.` : "Creating this record does not claim a run fired. The schedule appears active only after Brain accepts it."} />

        </FormSheet>
      </div>
      <ReasonDialog open={Boolean(retiring())} onClose={() => { setRetiring(undefined); setRetireReason(""); }} title="Retire this schedule" description="Future occurrences stop. Already-running work and the complete occurrence history are preserved. Duplicating is the safe way to create a replacement." reason={retireReason()} onReason={setRetireReason} reasonLabel="Retirement reason" confirmLabel="Retire schedule" tone="red" onConfirm={(reason) => { const automation = retiring(); if (automation) void control(automation, "retire", reason); setRetiring(undefined); setRetireReason(""); }} />
  </section>;
}

/** What a Play, task or mission shows instead of its own editor: how many schedules start it, with a way to the central Schedules page. */
export function SchedulesLink(props: { targetIds: readonly string[]; label: string }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const automations = createScopedRead<{ items: Automation[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: Automation[] }; asOf: string; sourceWatermark: number }>({ queryType: "automations.list", workspaceId: scope.workspaceId }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    refreshMs: 30_000,
  });
  const mine = () => (automations.state().data?.items ?? []).filter((automation) => props.targetIds.includes(automation.target.id) && automation.state !== "retired");
  const base = () => `/w/${app.workspaceId()}/schedules`;
  const first = () => props.targetIds[0] ?? "";
  return <WorkspaceSection title="Schedules" description="Every schedule is managed in one place, Schedules.">
    <div class="flex flex-wrap items-center gap-3">
      <p class="min-w-0 flex-1 text-interface text-ink-gray-8">{mine().length ? `${mine().length} active or paused schedule${mine().length === 1 ? "" : "s"} start ${props.label}.` : `Nothing starts ${props.label} on a schedule.`}</p>
      <Show when={mine().length > 0}><Button variant="ghost" onClick={() => navigate(`${base()}?target=${encodeURIComponent(first())}`)}>View schedules</Button></Show>
      <Button variant="outline" iconLeft="lucide-calendar-plus" onClick={() => navigate(`${base()}?create=${encodeURIComponent(first())}`)}>Add schedule</Button>
    </div>
  </WorkspaceSection>;
}
