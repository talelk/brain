import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { A } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { evalCasesRead, type EvalCaseRow } from "../../data/engine";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";
import { formatDateTime } from "../../ui/format";
import { missionHref } from "../../ui/mission-links";
import { t, tn } from "../../i18n";

/** The release-time check ADR 0010 names. It needs a real model, so a person starts it; nothing in Brain does. */
const REPLAY_COMMAND = "BRAIN_LOCAL_MODEL_URL=http://host:8000/v1 BRAIN_LOCAL_MODEL_ID=model node scripts/qualification/task-quality.mjs --cases brain-eval-cases.json";

/** Hands the cases over as the file the replay script reads (an array of cases). */
function download(items: readonly EvalCaseRow[], fileName: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(items, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CaseCard(props: { item: EvalCaseRow; workspaceId: string }): JSX.Element {
  const source = () => props.item.kind === "rejected-verdict" ? t("evalcases.source.rejected-verdict") : t("evalcases.source.task-sent-back");
  return <article class="flex min-w-0 flex-col gap-3 rounded-card border border-outline-gray-2 bg-surface-white p-4" data-eval-case={props.item.caseId} data-kind={props.item.kind}>
    <div class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 class="m-0 min-w-0 break-words text-base-medium text-ink-gray-9">
        <A class="text-ink-blue-link hover:underline focus-visible:focus-ring" href={missionHref(props.workspaceId, props.item.missionId)}>{props.item.missionTitle}</A>
      </h3>
      <span class="text-caption text-ink-gray-6">{t("evalcases.recorded", { when: formatDateTime(props.item.recordedAt) })}</span>
    </div>
    <div class="flex flex-wrap items-center gap-2 text-caption text-ink-gray-7">
      <span>{t("evalcases.source.label")}</span>
      <Badge variant="outline" theme={props.item.kind === "rejected-verdict" ? "red" : "amber"} label={source()} />
    </div>
    <div class="min-w-0">
      <h4 class="m-0 text-interface font-medium text-ink-gray-8">{t("evalcases.findings")}</h4>
      <Show when={props.item.findings.length} fallback={<p class="m-0 mt-1 text-interface text-ink-gray-7">{t("evalcases.findings.none")}</p>}>
        <ul class="m-0 mt-1 flex list-disc flex-col gap-1 ps-5 text-interface text-ink-gray-9"><For each={props.item.findings}>{(finding) => <li class="break-words">{finding}</li>}</For></ul>
      </Show>
    </div>
    <div class="min-w-0">
      <h4 class="m-0 text-interface font-medium text-ink-gray-8">{tn("evalcases.tasks", props.item.tasks.length)}</h4>
      <ul class="m-0 mt-1 flex list-disc flex-col gap-0.5 ps-5 text-interface text-ink-gray-7"><For each={props.item.tasks}>{(task) => <li class="break-words">{task.title}</li>}</For></ul>
    </div>
    <div class="flex min-w-0 flex-col gap-2 rounded-control bg-surface-gray-1 px-3 py-2 text-interface text-ink-gray-8" data-eval-replay>
      <p class="m-0">{tn("evalcases.case.replay", props.item.tasks.length)}</p>
      <div>
        <Button size="sm" variant="outline" iconLeft="lucide-download" onClick={() => download([props.item], `brain-eval-case-${props.item.caseId.slice(-8)}.json`)}>{t("evalcases.download.one")}</Button>
      </div>
    </div>
  </article>;
}

/**
 * Eval cases (Quality area): every result that was sent back from review or rejected at sign-off, saved by Brain as a regression case
 * (ADR 0010). The page lists them and says how to replay each one by hand. It never replays anything and no case changes a prompt,
 * a workflow or a release.
 */
export default function EvalCasesPage(): JSX.Element {
  const app = useApp();
  const cases = createScopedRead<{ items: EvalCaseRow[]; total: number }>({
    scope: app.scope, live: true,
    load: (scope, signal) => evalCasesRead(scope.workspaceId, signal),
    isEmpty: (data) => data.total === 0,
  });
  return <BrainPage title={t("evalcases.title")} description={t("evalcases.description")}>
    <PageStack>
      <ScreenRegion state={cases.state()} onRetry={() => void cases.refresh({ force: true })} emptyTitle={t("evalcases.empty.title")} emptyDescription={t("evalcases.empty.description")}>
        <Show when={cases.state().data}>{(data) => <>
          <WorkspaceSection title={t("evalcases.replay.title")} description={t("evalcases.replay.description")}>
            <div class="flex min-w-0 flex-col gap-3">
            <ol class="m-0 flex list-decimal flex-col gap-2 ps-5 text-interface text-ink-gray-9">
              <li>{t("evalcases.replay.step1")}</li>
              <li>{t("evalcases.replay.step2")}<pre class="m-0 mt-1 overflow-x-auto rounded-control bg-surface-gray-1 p-2 text-caption"><code>{REPLAY_COMMAND}</code></pre></li>
              <li>{t("evalcases.replay.step3")}</li>
            </ol>
            <p class="m-0 text-caption text-ink-gray-7">{t("evalcases.replay.never")}</p>
            <div><Button size="sm" variant="solid" theme="blue" iconLeft="lucide-download" onClick={() => download(data().items, "brain-eval-cases.json")}>{t("evalcases.download")}</Button></div>
            </div>
          </WorkspaceSection>
          <WorkspaceSection title={tn("evalcases.list.title", data().total)} description={data().total > data().items.length ? t("evalcases.truncated", { shown: data().items.length, total: data().total }) : undefined}>
            <div class="flex min-w-0 flex-col gap-3" data-eval-cases>
              <For each={data().items}>{(item) => <CaseCard item={item} workspaceId={app.workspaceId()} />}</For>
            </div>
          </WorkspaceSection>
        </>}</Show>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
