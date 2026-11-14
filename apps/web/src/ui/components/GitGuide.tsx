import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Select } from "@talelk/newui-molecules";
import type { GitConnection } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { gitGuideRead, type GitGuide, type GuideStep } from "../../data/engine";
import { ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "./Domain";
import { StatusIcon } from "../viz/StatusIcon";
import { t, tOr } from "../../i18n";

const THEME: Readonly<Record<GuideStep["state"], "green" | "amber" | "red">> = { done: "green", todo: "amber", failed: "red" };

/** The step's title in the interface language, by its stable id; the advice under it is the Governor's own sentence about this connection. */
const stepTitle = (step: GuideStep): string => step.id === "connect" ? t(step.state === "done" ? "guide.step.connect.done" : "guide.step.connect.todo") : tOr(`guide.step.${step.id}`, step.title);

/**
 * The guided Git connection checklist (`integrations.guide`): connect, verify, may push, bound for pull requests.
 * Each step is done, to do or needs attention, with the one thing to do about it.
 */
export function GitGuideChecklist(props: { connections: readonly GitConnection[] }): JSX.Element {
  const app = useApp();
  const [chosen, setChosen] = createSignal("");
  const connectionId = () => props.connections.find((connection) => connection.connectionId === chosen())?.connectionId ?? props.connections[0]?.connectionId;
  const guide = createScopedRead<GitGuide>({ scope: app.scope, live: true, resource: () => connectionId() ?? "", load: (_scope, signal, resource) => gitGuideRead(resource || undefined, signal) });
  return <WorkspaceSection title={t("guide.title")} description={t("guide.description")}>
    <Show when={props.connections.length > 1}><Select label={t("guide.connection")} value={connectionId() ?? null} onValueChange={(value) => setChosen(value ?? "")}
      options={props.connections.map((connection) => ({ value: connection.connectionId, label: connection.name }))} /></Show>
    <ScreenRegion state={guide.state()} onRetry={() => void guide.refresh({ force: true })} emptyTitle={t("guide.title")} emptyDescription={t("guide.notReady")}>
      <Show when={guide.state().data}>{(data) => <div class="flex min-w-0 flex-col gap-3" data-git-guide data-ready={data().ready ? "yes" : "no"}>
        <p class="m-0 text-interface font-medium text-ink-gray-9" data-git-guide-verdict>{data().ready ? t("guide.ready") : t("guide.notReady")}</p>
        <ol class="m-0 flex list-none flex-col gap-2 p-0"><For each={data().steps}>{(step) => <li class="flex min-w-0 items-start gap-2 rounded-control border border-outline-gray-1 p-3" data-guide-step={step.id} data-state={step.state}>
          <span class="mt-0.5"><StatusIcon state={step.state === "done" ? "ready" : step.state === "failed" ? "failed" : "pending"} theme={THEME[step.state]} class="size-4" /></span>
          <div class="min-w-0"><p class="m-0 break-words text-interface font-medium text-ink-gray-9">{stepTitle(step)} <span class="text-caption font-normal text-ink-gray-6">({t(`guide.state.${step.state}` as const)})</span></p>
            <p class="m-0 break-words text-caption text-ink-gray-7">{step.advice}</p></div>
        </li>}</For></ol>
      </div>}</Show>
    </ScreenRegion>
  </WorkspaceSection>;
}
