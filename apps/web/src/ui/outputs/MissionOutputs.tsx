import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { FileCard } from "@talelk/newui-molecules";
import type { ExecutionLink, Mission, Output, WorkItem } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import type { ArtifactHistory } from "../../data/exec-outputs";
import { artifactsHistoryQuery } from "../../data/exec-outputs";
import { ScreenRegion } from "../screen-region";
import { WorkspaceSection } from "../components/Domain";
import { KnowledgeProposalNote, ReusedLine } from "../components/Reuse";
import { TechnicalDetails } from "../components/PageLayout";
import { formatRelative } from "../format";
import { execOutputsUrl } from "../exec/exec-filters";
import { ArtifactView } from "./ArtifactView";
import { OutputReview } from "./OutputReview";
import { resolveWorkItemLink } from "./OutputHistory";
import { TrustNote } from "./ResultReader";
import { trustLineOf } from "./result-model";
import { createTrust } from "./trust-read";
import { OccurrenceChange } from "./OccurrenceChange";
import { loadMissionFiles } from "./mission-results";
import type { MissionFiles } from "./mission-results";
import { groupByTask, resolveFiles, reviewStateOf } from "./output-files";
import type { FileBadgeTheme, OutputFile, TaskResults } from "./output-files";

type Envelope<T> = { snapshot: T; asOf: string; sourceWatermark: number };
type ResultTask = TaskResults & { result: OutputFile };

/** The status a named output shows: its latest version's state and verification. */
function outputStatus(output: Output): { label: string; theme: FileBadgeTheme } {
  const latest = output.versions.at(-1);
  if (!latest) return { label: "No version yet", theme: "gray" };
  if (latest.verified) return { label: "Verified", theme: "green" };
  return latest.state === "final" ? { label: "Final", theme: "blue" } : { label: "Draft", theme: "gray" };
}

/** One task's Result: title, status and trust up front; opened, the written result and the accept / request-changes bar. */
function ResultCard(props: { task: ResultTask; links: readonly ExecutionLink[]; initiallyOpen: boolean; scrollTo: boolean; onChanged: () => void }): JSX.Element {
  const [open, setOpen] = createSignal(props.initiallyOpen);
  let root: HTMLElement | undefined;
  onMount(() => {
    if (props.scrollTo) root?.scrollIntoView({ block: "start" });
  });
  const [history, { refetch }] = createResource(
    () => props.task.result.artifact.artifactId,
    async (artifactId) => (await artifactsHistoryQuery({ artifactId })).snapshot as ArtifactHistory,
  );
  const loaded = () => (history.error ? undefined : history());
  const trust = createTrust(loaded);
  const title = () => props.task.title ?? props.task.result.name;
  return (
    <section
      ref={(element) => {
        root = element;
      }}
      class="flex min-w-0 flex-col rounded-card border border-outline-gray-2 bg-surface-white"
      aria-label={`Result: ${title()}`}
      data-testid="mission-result"
      data-open={open() ? "true" : "false"}
      id={`result-${props.task.item?.workItemId ?? props.task.result.artifact.artifactId}`}
    >
      <button type="button" class="flex min-w-0 items-center gap-3 rounded-card px-4 py-3 text-start focus-visible:focus-ring" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="lucide-file-text size-5 shrink-0 text-ink-gray-6" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-base-medium text-ink-gray-9">{title()}</span>
          <Show when={trust()}>{(line) => <span class="block truncate text-caption text-ink-gray-6">{line().text}</span>}</Show>
        </span>
        <Badge size="sm" variant="subtle" theme={props.task.result.status.theme} label={props.task.result.status.label} />
        <span class={`${open() ? "lucide-chevron-up" : "lucide-chevron-down"} size-4 shrink-0 text-ink-gray-6`} aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="flex min-w-0 flex-col gap-4 border-t border-outline-gray-2 px-4 py-4 sm:px-6">
          <ArtifactView artifact={props.task.result.artifact} title={title()} resultTitle={title()} history={loaded()} />
          <Show when={history.error}>
            <TrustNote trust={trustLineOf(undefined)} />
          </Show>
          <OutputReview
            item={props.task.item}
            link={props.task.result.link ?? resolveWorkItemLink(props.links, loaded())}
            history={loaded()}
            onChanged={() => {
              void refetch();
              props.onChanged();
            }}
          />
        </div>
      </Show>
    </section>
  );
}

/**
 * A mission's Outputs tab: one Result per task, the same cards as the
 * workspace Outputs page, each opening as a readable document with its trust
 * line and the accept / request-changes bar. Documents the mission produced as
 * versioned named outputs follow underneath. Reads the lists the workspace
 * Outputs page reads, narrowed to this mission.
 */
export function MissionOutputs(props: { mission: Mission }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const files = createScopedRead<MissionFiles>({
    scope: app.scope,
    load: async (scope, signal) => loadMissionFiles(scope.workspaceId, props.mission, signal),
    isEmpty: (loaded) => loaded.artifacts.length === 0,
    refreshMs: 15_000,
  });
  const tasks = createMemo((): ResultTask[] => {
    const loaded = files.state().data;
    if (!loaded) return [];
    return groupByTask(resolveFiles(loaded.artifacts, loaded.grouping))
      .filter((task): task is ResultTask => task.result !== undefined)
      .sort((left, right) => Number(reviewStateOf(right.item) === "review") - Number(reviewStateOf(left.item) === "review"));
  });
  const wanted = () => (typeof search["result"] === "string" ? search["result"] : undefined);
  const opensFirst = (task: ResultTask, index: number) => (wanted() ? task.item?.workItemId === wanted() : index === 0 && tasks().length <= 3);
  const outputs = createScopedRead<Output[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: Output[] }>>({ queryType: "missionOutputs.list", workspaceId: scope.workspaceId, resourceId: props.mission.missionId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  const items = createScopedRead<WorkItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: WorkItem[] }>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal);
      return { snapshot: response.snapshot.items.filter((item) => item.missionId === props.mission.missionId), asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
  });
  /** Documents grouped by the plan task whose work produced their latest version; tasks in review first. */
  const groups = createMemo(() => {
    const byTask = new Map<string, { title: string; review: boolean; outputs: Output[] }>();
    for (const output of outputs.state().data ?? []) {
      const producer = items.state().data?.find((item) => item.workItemId === output.versions.at(-1)?.workItemId);
      const title = producer?.title ?? "Not yet produced";
      const group = byTask.get(title) ?? { title, review: producer?.state === "review", outputs: [] };
      group.outputs.push(output);
      byTask.set(title, group);
    }
    return [...byTask.values()].sort((left, right) => Number(right.review) - Number(left.review));
  });
  const latestAt = (output: Output) => output.versions.at(-1)?.createdAt ?? output.createdAt;
  const refreshAll = () => {
    void files.refresh({ force: true });
    void items.refresh({ force: true });
  };

  return (
    <WorkspaceSection
      title="Results"
      description="What each task produced. Open one to read it, see how it was checked, then accept it or ask for changes."
      actions={
        <Button size="sm" variant="ghost" iconLeft="lucide-folder-open" onClick={() => void navigate(execOutputsUrl(props.mission.workspaceId))}>
          Browse all outputs
        </Button>
      }
    >
      <div class="mb-3 flex min-w-0 flex-col gap-3">
        <OccurrenceChange refId={props.mission.missionId} />
        <ReusedLine missionId={props.mission.missionId} workspaceId={props.mission.workspaceId} />
        <KnowledgeProposalNote missionId={props.mission.missionId} workspaceId={props.mission.workspaceId} achieved={props.mission.outcome === "achieved"} />
      </div>
      <ScreenRegion
        state={files.state()}
        skeleton="cards"
        onRetry={refreshAll}
        emptyTitle="No results yet"
        emptyDescription="Each task's result appears here as soon as it finishes."
      >
        <div class="flex min-w-0 flex-col gap-3" data-testid="mission-results">
          <For each={tasks()}>{(task, index) => <ResultCard task={task} links={files.state().data?.grouping.links ?? []} initiallyOpen={opensFirst(task, index())} scrollTo={wanted() !== undefined && task.item?.workItemId === wanted()} onChanged={refreshAll} />}</For>
        </div>
      </ScreenRegion>
      <Show when={groups().length > 0}>
        <div class="mt-6 flex min-w-0 flex-col gap-5">
          <h3 class="text-base-medium text-ink-gray-9">Documents with versions</h3>
          <For each={groups()}>
            {(group) => (
              <section class="flex min-w-0 flex-col gap-2" aria-label={`Outputs of ${group.title}`}>
                <header class="flex min-w-0 items-center gap-2">
                  <span class="lucide-folder size-4 shrink-0 text-ink-gray-6" aria-hidden="true" />
                  <h4 class="min-w-0 truncate text-interface font-medium text-ink-gray-9">{group.title}</h4>
                  <Show when={group.review}>
                    <Badge size="sm" theme="amber" label="Needs review" />
                  </Show>
                  <span class="text-caption tabular-nums text-ink-gray-6">{group.outputs.length}</span>
                </header>
                <div class="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-2">
                  <For each={group.outputs}>
                    {(output) => {
                      const status = outputStatus(output);
                      const count = output.versions.length;
                      return (
                        <FileCard
                          as="button"
                          size="md"
                          name={output.name}
                          icon="lucide-file-text"
                          aria-label={`Open output ${output.name}`}
                          meta={`${count} ${count === 1 ? "version" : "versions"} · updated ${formatRelative(latestAt(output))}${output.continues ? " · continues earlier work" : ""}`}
                          badge={<Badge size="sm" theme={status.theme} label={status.label} />}
                          onClick={() => void navigate(`/outputs/${encodeURIComponent(output.outputId)}`)}
                        />
                      );
                    }}
                  </For>
                </div>
              </section>
            )}
          </For>
          <TechnicalDetails label="About document versions">
            <p>Versions are immutable. A task input pins one exact verified final version when its attempt is admitted.</p>
          </TechnicalDetails>
        </div>
      </Show>
    </WorkspaceSection>
  );
}
