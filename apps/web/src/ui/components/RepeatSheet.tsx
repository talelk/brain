import { For, Show, createResource, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Checkbox, TextInput } from "@talelk/newui-atoms";
import type { Mission, WorkflowCatalogEntry } from "@brain/contracts";
import { useApp } from "../app-context";
import { query } from "../../data/client";
import { FormSheet } from "./BrainForm";
import { formatOccurrence } from "../format";

/** One preset as the server returns it: the cron and timezone are the server's, the browser only shows them. */
interface PresetView { presetId: string; label: string; cron: string; timezone: string; nextOccurrences: string[] }
type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };

/** The workflow a described mission (one with no play) repeats through. */
export const DESCRIBED_WORK_WORKFLOW = "general-task";

function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
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
  const [autoConfirm, setAutoConfirm] = createSignal(true);
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
        // The mission this repeats: every run reuses its confirmed plan, and the switch says whether the schedule may confirm it for you (ADR 0017).
        input: { sourceMissionId: props.mission.missionId, autoConfirm: autoConfirm(), ...(to.kind === "workflow" ? { situation: situation() } : {}) },
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
            <ol class="flex flex-col gap-0.5 text-interface text-ink-gray-8" data-testid="repeat-next-runs"><For each={preset.nextOccurrences}>{(at) => <li>{formatOccurrence(at, preset.timezone)}</li>}</For></ol>
          </Show>
        </label>}</For>
      </Show>
      <Show when={preview()?.problem}><p class="text-interface text-ink-red-7" role="alert">{preview()?.problem}</p></Show>
    </fieldset>
    <div class="flex items-end gap-2">
      <div class="min-w-0 flex-1"><TextInput label="Timezone" value={zoneDraft()} onInput={(event) => setZoneDraft(event.currentTarget.value)} onBlur={() => { if (zoneDraft().trim()) setTimezone(zoneDraft().trim()); }} description="A place name such as Europe/Paris; Brain handles daylight saving." /></div>
    </div>
    <div class="flex min-w-0 flex-col gap-1 rounded-control border border-outline-gray-2 bg-surface-elevation-1 px-3 py-2.5" data-testid="repeat-autoconfirm">
      <Checkbox checked={autoConfirm()} onCheckedChange={(checked) => setAutoConfirm(Boolean(checked))} label="Confirm the plan automatically each time" />
      <p class="m-0 text-caption text-ink-gray-6">
        {autoConfirm()
          ? "Brain starts each run with the plan you already confirmed, with no action from you, as long as that plan is unchanged, this mission was verified as achieved, no step writes or needs an approval, autonomy is standard or higher, there is budget left and you can still confirm plans; otherwise the run waits in Needs you with the reason."
          : "Each run waits in Needs you until you confirm its plan."}
      </p>
    </div>
    <p class="text-caption text-ink-gray-6">
      Each run is a new mission with its own Results, so you can see what changed.{" "}
      <Show when={props.mission.playId} fallback={<>If the previous run is still going, the next one is skipped.</>}>If the previous mission is still open, the next run is skipped.</Show> A run that fails appears in Needs you.
    </p>
    <Show when={cannotTarget()}><p class="text-interface text-ink-amber-8" role="alert">This workspace has no task Brain can repeat a described mission with, so it cannot be scheduled yet.</p></Show>
  </FormSheet>;
}
