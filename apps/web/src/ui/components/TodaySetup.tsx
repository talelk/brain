import { createEffect, createSignal, For, lazy, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Dialog } from "@talelk/newui-molecules";
import type { JobSnapshot, OperationalReadiness } from "@brain/contracts";
import { useApp } from "../app-context";
import { IconTile } from "./primitives";
import { liveNow, refreshLiveNow, useClock, wantFastPulse } from "../../data/live";
import { createScopedRead } from "../../data/screens";
import { jobQuery } from "../../data/governor";
import { CHECK_WORKFLOW, checkOutcome, failureKey, startInstallCheck, takenLabel, waitingKey } from "../../data/install-check";
import { t } from "../../i18n";
const LocalModelSetup = lazy(() => import("./LocalModelSetup").then((module) => ({ default: module.LocalModelSetup })));
import type { createReadiness } from "./OperationalChecklist";

type Check = OperationalReadiness["checks"][number];
type Step = "model" | "release" | "runners" | "smoke";

interface SetupRow { step: Step; title: string; status: Check["status"]; detail: string; next: string; workflowId?: string }

/** The installation check as this page started it: nothing yet, starting, following a run, passed (with how long it took) or failed (with the plain reason). */
type CheckRun =
  | { readonly phase: "idle" }
  | { readonly phase: "starting"; readonly startedAt: number }
  | { readonly phase: "running"; readonly startedAt: number; readonly runId: string }
  | { readonly phase: "passed"; readonly ms: number; readonly runId: string }
  | { readonly phase: "failed"; readonly message: string; readonly runId?: string };

/** The readiness read, folded into the four things a person fixes. Text comes from the Governor's checks, not from here. */
export function setupRows(checks: readonly Check[]): SetupRow[] {
  const rows: SetupRow[] = [];
  const model = checks.find((check) => check.action === "model");
  if (model) rows.push({ step: "model", title: t("today.setup.model"), status: model.status, detail: model.detail, next: model.nextAction });
  const release = checks.find((check) => check.id === "release") ?? checks.find((check) => check.action === "release");
  if (release) rows.push({ step: "release", title: t("today.setup.release"), status: release.status, detail: release.status === "ready" ? t("today.setup.release.done") : release.detail, next: release.nextAction });
  const runnerChecks = checks.filter((check) => check.id.startsWith("workflow:"));
  const missingRunner = runnerChecks.find((check) => check.status === "missing");
  if (runnerChecks.length > 0) rows.push({ step: "runners", title: t("today.setup.runners"), status: missingRunner ? "missing" : "ready", detail: missingRunner ? missingRunner.detail : t("today.setup.runners.done"), next: missingRunner?.nextAction ?? "" });
  const smoke = checks.find((check) => check.action === "smoke");
  if (smoke) rows.push({ step: "smoke", title: t("today.setup.smoke"), status: smoke.status, detail: smoke.status === "ready" ? t("today.setup.smoke.done") : t("today.setup.smoke.idle"), next: "", workflowId: smoke.workflowId });
  return rows;
}

/** Missing model, release or runners stop the box; an unverified smoke test only asks to be run. */
export function blockedBy(checks: readonly Check[]): SetupRow[] {
  return setupRows(checks).filter((row) => row.status === "missing" && row.step !== "smoke");
}

const takenText = (ms: number): string => { const { minutes, seconds } = takenLabel(ms); return minutes > 0 ? t("today.check.taken.min", { m: minutes, s: seconds }) : t("today.check.taken.s", { s: seconds }); };

/**
 * Inline setup on Today (#48): while the install is not ready, the box is blocked
 * and the existing readiness checks show as a checklist with one fix each. Model
 * and runners open the existing guided setup in a sheet; the release goes to the
 * existing release screen. "Run the check" starts the read-only check task right
 * here and follows that run through the live store in the same row: running,
 * passed with the time it took, or failed with the plain reason; on success the
 * checklist folds into one line. Nothing here decides readiness: the run's own
 * state and the Governor's readiness read do.
 */
export function TodaySetup(props: { readiness: ReturnType<typeof createReadiness> }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const [run, setRun] = createSignal<CheckRun>({ phase: "idle" });
  const rows = () => setupRows(props.readiness.state().data?.checks ?? []);
  const administrator = () => Boolean(app.identity()?.actor.scopes.includes("config:activate"));
  const blocked = () => rows().some((row) => row.status === "missing" && row.step !== "smoke");
  // While the sheet is open the checklist behind it re-reads quickly, so it is already right when the sheet closes.
  createEffect(() => {
    if (!open()) return;
    const release = wantFastPulse();
    onCleanup(release);
  });
  // One clock for the seconds counter, only while a check is in flight.
  createEffect(() => {
    const phase = run().phase;
    if (phase !== "starting" && phase !== "running") return;
    const release = useClock();
    onCleanup(release);
  });
  // The started run, read through the live store like every other screen: it re-loads when the Governor says something changed.
  const job = createScopedRead<JobSnapshot | null>({
    scope: app.scope,
    resource: () => { const current = run(); return current.phase === "running" ? current.runId : undefined; },
    load: async (scope, signal, runId) => {
      if (!runId) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const loaded = await jobQuery(scope.workspaceId, runId, signal);
      return { snapshot: loaded.snapshot as JobSnapshot, asOf: loaded.asOf, sourceWatermark: loaded.sourceWatermark };
    },
  });
  createEffect(() => {
    const current = run();
    const snapshot = job.state().data;
    if (current.phase !== "running" || !snapshot || snapshot.workflowRunId !== current.runId) return;
    const outcome = checkOutcome(snapshot);
    if (outcome === "passed") { setRun({ phase: "passed", ms: Date.now() - current.startedAt, runId: current.runId }); void props.readiness.refresh({ force: true }); refreshLiveNow(); }
    else if (outcome === "failed") { setRun({ phase: "failed", message: t("today.check.failed", { reason: t(failureKey(snapshot)) }), runId: current.runId }); void props.readiness.refresh({ force: true }); }
  });
  async function runCheck(workflowId: string | undefined): Promise<void> {
    if (run().phase === "starting" || run().phase === "running") return;
    const startedAt = Date.now();
    setRun({ phase: "starting", startedAt });
    try {
      const runId = await startInstallCheck(app.workspaceId(), workflowId ?? CHECK_WORKFLOW);
      setRun({ phase: "running", startedAt, runId });
      refreshLiveNow();
    } catch (error) {
      setRun({ phase: "failed", message: t("today.check.failedStart", { reason: error instanceof Error ? error.message : "" }).trim() });
    }
  }
  const inFlight = () => run().phase === "starting" || run().phase === "running";
  const elapsed = () => { const current = run(); return current.phase === "starting" || current.phase === "running" ? takenText(Math.max(0, liveNow()() - current.startedAt)) : ""; };
  const waiting = () => { const snapshot = job.state().data; const key = snapshot ? waitingKey(snapshot) : undefined; return key ? t(key) : ""; };
  const fix = (row: SetupRow) => { if (row.step === "release") void navigate("/settings?tab=release&from=today"); else if (row.step === "smoke") void runCheck(row.workflowId); else setOpen(true); };
  const label = (row: SetupRow) => (row.step === "smoke" ? (run().phase === "failed" ? t("today.check.again") : t("today.check.run")) : t(row.step === "release" ? "today.setup.release" : row.step === "model" ? "today.setup.model" : "today.setup.runners"));
  const startFirstMission = () => { const box = document.querySelector<HTMLTextAreaElement>("textarea"); box?.focus(); box?.scrollIntoView({ block: "center" }); };
  /** What the row says and shows for the installation check: the run it started wins over the readiness read. */
  const view = (row: SetupRow): { status: string; detail: string; next: string; busy: boolean } => {
    if (row.step !== "smoke") return { status: row.status, detail: row.status === "ready" ? row.detail : row.next ? `${row.detail}. ${row.next}.` : row.detail, next: "", busy: false };
    const current = run();
    if (current.phase === "starting") return { status: "running", detail: t("today.check.starting"), next: "", busy: true };
    if (current.phase === "running") return { status: "running", detail: [t("today.check.running", { taken: elapsed() }), waiting()].filter(Boolean).join(" "), next: "", busy: true };
    if (current.phase === "failed") return { status: "missing", detail: current.message, next: t("today.check.next"), busy: false };
    return { status: row.status, detail: row.detail, next: "", busy: false };
  };
  return <>
    <Show when={run().phase === "passed"}>
      <section class="flex min-w-0 flex-wrap items-center gap-3 rounded-card border border-outline-green-2 bg-surface-green-1 p-4 max-sm:[&>[data-slot=button]]:basis-full" aria-label={t("today.check.done.title")} data-testid="today-setup-done" role="status">
        <IconTile icon="lucide-check" tone="green" />
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-base-medium text-ink-gray-9">{t("today.check.done.title")}</h2>
          <p class="m-0 mt-0.5 text-interface text-ink-gray-7">{(() => { const current = run(); return current.phase === "passed" ? t("today.check.done.detail", { taken: takenText(current.ms) }) : ""; })()}</p>
        </div>
        <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-flag" onClick={startFirstMission}>{t("today.check.done.cta")}</Button>
      </section>
    </Show>
    <Show when={run().phase !== "passed" && props.readiness.state().data && (!props.readiness.state().data!.ready || run().phase === "failed")}>
    <section class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-amber-3 bg-surface-amber-1 p-4 sm:p-5" aria-label={t("today.setup.title.blocked")} data-testid="today-setup">
      <div>
        <h2 class="m-0 text-section text-ink-gray-9">{blocked() ? t("today.setup.title.blocked") : t("today.setup.title.last")}</h2>
        <p class="m-0 mt-1 text-interface text-ink-gray-8">{blocked() ? t("today.setup.lead.blocked") : t("today.setup.lead.last")}</p>
      </div>
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        <For each={rows()}>{(row) => { const shown = () => view(row); return <li class="flex min-w-0 flex-wrap items-center gap-3 rounded-control bg-surface-white p-3 max-sm:[&>[data-slot=button]]:basis-full" data-step={row.step} data-status={shown().status} data-phase={row.step === "smoke" ? run().phase : undefined}>
          <Show when={shown().busy} fallback={<IconTile icon={shown().status === "ready" ? "lucide-check" : shown().status === "missing" ? "lucide-circle-alert" : "lucide-circle-help"} tone={shown().status === "ready" ? "green" : shown().status === "missing" ? "amber" : "gray"} />}>
            <IconTile icon="lucide-loader" tone="gray" />
          </Show>
          <div class="min-w-0 flex-1" aria-live={row.step === "smoke" ? "polite" : undefined}>
            <h3 class="m-0 text-base-medium text-ink-gray-9">{row.title}<Show when={row.status === "ready"}><span class="sr-only"> (done)</span></Show></h3>
            <p class="m-0 mt-0.5 break-words text-interface text-ink-gray-7" data-testid={row.step === "smoke" ? "check-detail" : undefined}>{shown().detail}</p>
            <Show when={shown().next}><p class="m-0 mt-0.5 break-words text-interface text-ink-gray-7" data-testid="check-next">{shown().next}</p></Show>
            <Show when={row.step === "smoke" && run().phase === "failed" && (run() as { runId?: string }).runId}><Button class="mt-1" size="sm" variant="ghost" iconRight="lucide-arrow-right" onClick={() => void navigate(`/runs/${(run() as { runId: string }).runId}`)}>{t("today.check.details")}</Button></Show>
          </div>
          <Show when={shown().status !== "ready" && !shown().busy}>
            <Button size="sm" variant="solid" theme="blue" disabled={!administrator() || (row.step === "smoke" && blocked())} onClick={() => fix(row)}>{administrator() ? label(row) : t("today.setup.adminNeeded")}</Button>
          </Show>
        </li>; }}</For>
      </ul>
    </section>
    </Show>
    <Dialog.Root open={open()} onOpenChange={(next) => { setOpen(next); if (!next) void props.readiness.refresh({ force: true }); }}>
      <Dialog.Content size="2xl" class="flex max-h-[calc(100dvh-2rem)] flex-col max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
        <Dialog.Header><Dialog.Title>{t("today.setup.dialog.title")}</Dialog.Title><Dialog.Description>{t("today.setup.dialog.description")}</Dialog.Description></Dialog.Header>
        <div class="my-3 min-h-0 flex-1 overflow-y-auto pe-1"><Show when={open()}><LocalModelSetup /></Show></div>
        <Dialog.Footer class="justify-end"><Button size="sm" variant="outline" onClick={() => setOpen(false)}>{t("today.setup.dialog.close")}</Button></Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </>;
}
