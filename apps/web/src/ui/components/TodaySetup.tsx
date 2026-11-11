import { createEffect, createSignal, For, lazy, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Dialog } from "@talelk/newui-molecules";
import type { OperationalReadiness } from "@brain/contracts";
import { useApp } from "../app-context";
import { IconTile } from "./primitives";
const LocalModelSetup = lazy(() => import("./LocalModelSetup").then((module) => ({ default: module.LocalModelSetup })));
import type { createReadiness } from "./OperationalChecklist";

type Check = OperationalReadiness["checks"][number];
type Step = "model" | "release" | "runners" | "smoke";

interface SetupRow { step: Step; title: string; status: Check["status"]; detail: string; next: string }

const TITLES: Record<Step, string> = { model: "Connect a model", release: "Activate the starter release", runners: "Start the runners", smoke: "Verify the install" };

/** The readiness read, folded into the four things a person fixes. Text comes from the Governor's checks, not from here. */
export function setupRows(checks: readonly Check[]): SetupRow[] {
  const rows: SetupRow[] = [];
  const model = checks.find((check) => check.action === "model");
  if (model) rows.push({ step: "model", title: TITLES.model, status: model.status, detail: model.detail, next: model.nextAction });
  const release = checks.find((check) => check.id === "release") ?? checks.find((check) => check.action === "release");
  if (release) rows.push({ step: "release", title: TITLES.release, status: release.status, detail: release.status === "ready" ? "A configuration release is active." : release.detail, next: release.nextAction });
  const runnerChecks = checks.filter((check) => check.id.startsWith("workflow:"));
  const missingRunner = runnerChecks.find((check) => check.status === "missing");
  if (runnerChecks.length > 0) rows.push({ step: "runners", title: TITLES.runners, status: missingRunner ? "missing" : "ready", detail: missingRunner ? missingRunner.detail : "Runners are online for every workflow.", next: missingRunner?.nextAction ?? "" });
  const smoke = checks.find((check) => check.action === "smoke");
  if (smoke) rows.push({ step: "smoke", title: TITLES.smoke, status: smoke.status, detail: smoke.status === "ready" ? "The installation check passed for this connection." : "Not checked yet. One small task runs the model, a runner and the independent validator together.", next: "" });
  return rows;
}

/** Missing model, release or runners stop the box; an unverified smoke test only asks to be run. */
export function blockedBy(checks: readonly Check[]): SetupRow[] {
  return setupRows(checks).filter((row) => row.status === "missing" && row.step !== "smoke");
}

/**
 * Inline setup on Today (#48): while the install is not ready, the box is blocked
 * and the existing readiness checks show as a checklist with one fix each. Model,
 * runners and the installation check open the existing guided setup in a sheet;
 * the release goes to the existing release screen. Nothing here decides readiness.
 */
export function TodaySetup(props: { readiness: ReturnType<typeof createReadiness> }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const rows = () => setupRows(props.readiness.state().data?.checks ?? []);
  const administrator = () => Boolean(app.identity()?.actor.scopes.includes("config:activate"));
  // While the sheet is open the checklist behind it re-reads quickly, so it is already right when the sheet closes.
  createEffect(() => {
    if (!open()) return;
    const timer = setInterval(() => void props.readiness.refresh({ force: true }), 3000);
    onCleanup(() => clearInterval(timer));
  });
  const fix = (row: SetupRow) => { if (row.step === "release") void navigate("/settings?tab=release&from=today"); else setOpen(true); };
  const label = (row: SetupRow) => (row.step === "smoke" ? "Run the check" : row.step === "release" ? "Open releases" : row.step === "model" ? "Connect a model" : "Start the runners");
  return <>
    <Show when={props.readiness.state().data && !props.readiness.state().data!.ready}>
    <section class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-amber-3 bg-surface-amber-1 p-4 sm:p-5" aria-label="Finish setting up Brain" data-testid="today-setup">
      <div>
        <h2 class="m-0 text-section text-ink-gray-9">{rows().some((row) => row.status === "missing" && row.step !== "smoke") ? "Finish setting up Brain" : "One more step"}</h2>
        <p class="m-0 mt-1 text-interface text-ink-gray-8">{rows().some((row) => row.status === "missing" && row.step !== "smoke")
          ? "The box below starts working as soon as each item here is ready."
          : "Brain is ready to take work. Run the installation check once to confirm it end to end."}</p>
      </div>
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        <For each={rows()}>{(row) => <li class="flex min-w-0 flex-wrap items-center gap-3 rounded-control bg-surface-white p-3 max-sm:[&>[data-slot=button]]:basis-full" data-step={row.step} data-status={row.status}>
          <IconTile icon={row.status === "ready" ? "lucide-check" : row.status === "missing" ? "lucide-circle-alert" : "lucide-circle-help"} tone={row.status === "ready" ? "green" : row.status === "missing" ? "amber" : "gray"} />
          <div class="min-w-0 flex-1">
            <h3 class="m-0 text-base-medium text-ink-gray-9">{row.title}<Show when={row.status === "ready"}><span class="sr-only"> (done)</span></Show></h3>
            <p class="m-0 mt-0.5 break-words text-interface text-ink-gray-7">{row.status === "ready" ? row.detail : row.next ? `${row.detail}. ${row.next}.` : row.detail}</p>
          </div>
          <Show when={row.status !== "ready"}>
            <Button size="sm" variant="solid" theme="blue" disabled={!administrator()} onClick={() => fix(row)}>{administrator() ? label(row) : "Administrator needed"}</Button>
          </Show>
        </li>}</For>
      </ul>
    </section>
    </Show>
    <Dialog.Root open={open()} onOpenChange={(next) => { setOpen(next); if (!next) void props.readiness.refresh({ force: true }); }}>
      <Dialog.Content size="2xl" class="flex max-h-[calc(100dvh-2rem)] flex-col max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
        <Dialog.Header><Dialog.Title>Set up Brain</Dialog.Title><Dialog.Description>The same guided setup as Administration. Close this when you are done; the checklist is already up to date.</Dialog.Description></Dialog.Header>
        <div class="my-3 min-h-0 flex-1 overflow-y-auto pe-1"><Show when={open()}><LocalModelSetup /></Show></div>
        <Dialog.Footer class="justify-end"><Button size="sm" variant="outline" onClick={() => setOpen(false)}>Close</Button></Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </>;
}
