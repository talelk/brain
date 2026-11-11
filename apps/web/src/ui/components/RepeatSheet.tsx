import { For, Show, createResource, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { TextInput } from "@talelk/newui-atoms";
import type { Mission, WorkflowCatalogEntry } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { FormSheet } from "./BrainForm";
import { CLOCK_24 } from "../format";

/** One preset as the server returns it: the cron and timezone are the server's, the browser only shows them. */
interface PresetView { presetId: string; label: string; cron: string; timezone: string; nextOccurrences: string[] }
type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** The workflow a described mission (one with no play) repeats through. */
export const DESCRIBED_WORK_WORKFLOW = "general-task";

function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** An instant as the weekday, date and clock time of the chosen timezone, so "08:00" reads as 08:00. */
function inZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { ...CLOCK_24, timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch { return iso; }
}

/**
 * "Repeat this" (#56): pick how often a finished mission should run again.
 * The presets, their cron and the next five run times come from the server;
 * creating goes through the ordinary `automation.upsert`, so the schedule is
 * active only once the server accepts it.
 */
export function RepeatSheet(props: { mission: Mission; open: boolean; onClose: () => void; onCreated?: () => void }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [timezone, setTimezone] = createSignal(browserTimezone());
  const [zoneDraft, setZoneDraft] = createSignal(timezone());
  const [chosen, setChosen] = createSignal("weekdays-0800");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const [preview] = createResource(
    () => (props.open ? { workspaceId: app.workspaceId(), zone: timezone() } : undefined),
    async ({ workspaceId, zone }) => {
      try {
        const response = await query<Envelope<{ timezone: string; presets: PresetView[] }>>({ queryType: "automations.preview", workspaceId, search: zone });
        return { presets: response.snapshot.presets, problem: "" };
      } catch (cause) {
        return { presets: [] as PresetView[], problem: cause instanceof Error ? cause.message : "The preview is not available" };
      }
    },
  );
  const [workflows] = createResource(
    () => (props.open && !props.mission.playId ? app.workspaceId() : undefined),
    async (workspaceId) => (await query<Envelope<{ items: WorkflowCatalogEntry[] }>>({ queryType: "workflows.list", workspaceId })).snapshot.items,
  );
  const presets = () => preview()?.presets ?? [];
  const selected = () => presets().find((preset) => preset.presetId === chosen());
  const target = () => props.mission.playId
    ? { kind: "play" as const, id: props.mission.playId }
    : (workflows() ?? []).some((workflow) => workflow.release.id === DESCRIBED_WORK_WORKFLOW) ? { kind: "workflow" as const, id: DESCRIBED_WORK_WORKFLOW } : undefined;
  const situation = () => [props.mission.intent, props.mission.successCriteria.length ? `Done when:\n${props.mission.successCriteria.map((criterion) => `- ${criterion}`).join("\n")}` : ""].filter(Boolean).join("\n\n").slice(0, 30000);

  async function create(): Promise<void> {
    const preset = selected();
    const to = target();
    if (!preset || !to || busy()) return;
    setBusy(true); setError("");
    try {
      const saved = await app.run("automation.upsert", {
        title: `Repeat: ${props.mission.title}`.slice(0, 200),
        target: to,
        trigger: { kind: "cron", cron: preset.cron, timezone: preset.timezone },
        overlap: "skip", misfire: "skip",
        ...(to.kind === "workflow" ? { input: { situation: situation() } } : {}),
      });
      if (!saved.accepted) throw new Error(saved.detail);
      props.onCreated?.();
      props.onClose();
      void navigate(`/w/${encodeURIComponent(app.workspaceId())}/schedules?target=${encodeURIComponent(to.id)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The schedule was refused"); }
    finally { setBusy(false); }
  }

  const cannotTarget = () => !props.mission.playId && workflows.state === "ready" && !target();
  return <FormSheet centered size="lg" open={props.open} onClose={props.onClose} title="Repeat this" icon="lucide-repeat"
    description={`Run "${props.mission.title}" again on a schedule.`} submit="Repeat on this schedule"
    busy={busy()} disabled={!selected() || !target()} onSubmit={create} error={error()} errorTitle="The schedule was not created">
    <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"><legend class="sr-only">How often</legend>
      <Show when={!preview.loading} fallback={<p class="text-interface text-ink-gray-6">Working out the next runs…</p>}>
        <For each={presets()}>{(preset) => <label class={`flex min-w-0 cursor-pointer flex-col gap-1 rounded-control border px-3 py-2.5 focus-within:focus-ring ${chosen() === preset.presetId ? "border-outline-blue-3 bg-surface-blue-1" : "border-outline-gray-2 bg-surface-elevation-1 hover:bg-surface-gray-1"}`}>
          <input type="radio" name="repeat-preset" class="sr-only" value={preset.presetId} checked={chosen() === preset.presetId} onChange={() => setChosen(preset.presetId)} />
          <span class="text-base-medium text-ink-gray-9">{preset.label}</span>
          <Show when={chosen() === preset.presetId}>
            <span class="text-caption text-ink-gray-6">Next runs ({preset.timezone})</span>
            <ol class="flex flex-col gap-0.5 text-interface text-ink-gray-8" data-testid="repeat-next-runs"><For each={preset.nextOccurrences}>{(at) => <li>{inZone(at, preset.timezone)}</li>}</For></ol>
          </Show>
        </label>}</For>
      </Show>
      <Show when={preview()?.problem}><p class="text-interface text-ink-red-7" role="alert">{preview()?.problem}</p></Show>
    </fieldset>
    <div class="flex items-end gap-2">
      <div class="min-w-0 flex-1"><TextInput label="Timezone" value={zoneDraft()} onInput={(event) => setZoneDraft(event.currentTarget.value)} onBlur={() => { if (zoneDraft().trim()) setTimezone(zoneDraft().trim()); }} description="A place name such as Europe/Paris; Brain handles daylight saving." /></div>
    </div>
    <p class="text-caption text-ink-gray-6">
      <Show when={props.mission.playId} fallback={<>Each run does the same work again and keeps its result, so you can see what changed. If the previous run is still going, the next one is skipped.</>}>
        Each run starts a new mission from the same play. You confirm its plan, as you did the first time. If the previous mission is still open, the next run is skipped.
      </Show>
    </p>
    <Show when={cannotTarget()}><p class="text-interface text-ink-amber-8" role="alert">This workspace has no task Brain can repeat a described mission with, so it cannot be scheduled yet.</p></Show>
  </FormSheet>;
}
