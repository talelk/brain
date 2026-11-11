import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { FileCard } from "@talelk/newui-molecules";
import type { ExecutionLink, Mission, Output } from "@brain/contracts";
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
import { ChallengeResult } from "./ChallengeResult";
import { ShareResult } from "./ShareResult";
import { ProposePlay } from "./ProposePlay";
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

/** One named output as a card: its version count, latest status and a way into the output page. */
function DocumentCard(props: { output: Output }): JSX.Element {
  const navigate = useNavigate();
  const status = () => outputStatus(props.output);
  const count = () => props.output.versions.length;
  const latestAt = () => props.output.versions.at(-1)?.createdAt ?? props.output.createdAt;
  return (
    <FileCard
      as="button"
      size="md"
      name={props.output.name}
      icon="lucide-file-text"
      aria-label={`Open output ${props.output.name}`}
      meta={`${count()} ${count() === 1 ? "version" : "versions"} · updated ${formatRelative(latestAt())}${props.output.continues ? " · continues earlier work" : ""}`}
      badge={<Badge size="sm" theme={status().theme} label={status().label} />}
      onClick={() => void navigate(`/outputs/${encodeURIComponent(props.output.outputId)}`)}
    />
  );
}

/** One task's Result: title, status and trust up front; opened, the written result and the accept / request-changes bar. */
function ResultCard(props: { task: ResultTask; links: readonly ExecutionLink[]; documents: readonly Output[]; initiallyOpen: boolean; scrollTo: boolean; onToggle: (open: boolean) => void; onChanged: () => void }): JSX.Element {
  const [open, setOpen] = createSignal(props.initiallyOpen);
  const toggle = () => {
    setOpen(!open());
    props.onToggle(open());
  };
  /** The newest verified final version this task wrote: what a read-only link can show. */
  const shareable = () => {
    const workItemId = props.task.item?.workItemId;
    for (const output of props.documents) {
      const version = output.versions.findLast((entry) => entry.workItemId === workItemId && entry.verified && entry.state === "final");
      if (version) return version;
    }
    return undefined;
  };
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
      <button type="button" class="flex min-w-0 items-center gap-3 rounded-card px-4 py-3 text-start focus-visible:focus-ring" aria-expanded={open()} onClick={toggle}>
        <span class="lucide-file-text size-5 shrink-0 text-ink-gray-6" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-base-medium text-ink-gray-9">{title()}</span>
          <Show when={trust()}>{(line) => <span class="block truncate text-caption text-ink-gray-6">{line().text}</span>}</Show>
        </span>
        <Show when={trust()?.needsSignOff}><Badge size="sm" variant="subtle" theme="amber" label="Unverified" /></Show>
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
            trust={trust()}
            onChanged={() => {
              void refetch();
              props.onChanged();
            }}
          />
          <Show when={shareable()}>{(version) => <ShareResult versionId={version().versionId} verified />}</Show>
          <Show when={props.documents.length > 0}>
            <section class="flex min-w-0 flex-col gap-2" aria-label="Version history" data-testid="version-history">
              <h4 class="text-interface font-medium text-ink-gray-9">Version history</h4>
              <div class="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-2">
                <For each={props.documents}>{(output) => <DocumentCard output={output} />}</For>
              </div>
            </section>
          </Show>
        </div>
      </Show>
      <ChallengeResult
        workItemId={props.task.item?.workItemId}
        finished={props.task.item?.state === "done" || props.task.item?.state === "review"}
        quiet={!open()}
        class={open() ? "mx-4 mb-4 sm:mx-6" : "mx-4 mb-3"}
      />
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
export function MissionOutputs(props: { mission: Mission; onChanged?: () => void }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
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
  const taskKey = (task: ResultTask) => task.item?.workItemId ?? task.result.artifact.artifactId;
  /** Cards are keyed by task id, so a refresh that rebuilds the task objects re-orders or updates cards but never remounts them. */
  const taskIds = createMemo(() => tasks().map(taskKey), [], { equals: (before, after) => before.length === after.length && before.every((id, index) => id === after[index]) });
  const taskById = createMemo(() => new Map(tasks().map((task) => [taskKey(task), task] as const)));
  const wanted = () => (typeof search["result"] === "string" ? search["result"] : undefined);
  /** A card opens first when the link names it, or (with no link) when it leads a short list. Read once, as a card appears. */
  const opensFirst = (id: string) => (wanted() ? id === wanted() : taskIds()[0] === id && taskIds().length <= 3);
  /** The open card is kept in the address (?result=<task id>) so a reload or a shared link lands on it; opening or closing never scrolls. */
  const remember = (id: string, open: boolean) => {
    if (open) setSearch({ result: id }, { replace: true, scroll: false });
    else if (wanted() === id) setSearch({ result: undefined }, { replace: true, scroll: false });
  };
  const outputs = createScopedRead<Output[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<Envelope<{ items: Output[] }>>({ queryType: "missionOutputs.list", workspaceId: scope.workspaceId, resourceId: props.mission.missionId }, signal);
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  /** The named outputs a task wrote any version of: they appear as that task's "Version history". */
  const documentsOf = (id: string): Output[] => (outputs.state().data ?? []).filter((output) => output.versions.some((version) => version.workItemId === id));
  /** Outputs no Result card accounts for (no task wrote them yet). */
  const strays = createMemo(() => {
    const shown = new Set(tasks().flatMap((task) => (task.item ? [task.item.workItemId] : [])));
    return (outputs.state().data ?? []).filter((output) => !output.versions.some((version) => shown.has(version.workItemId)));
  });
  /** A refresh keeps the cards on screen: only a first load shows the skeleton. */
  const regionState = () => {
    const state = files.state();
    return state.status === "loading" && state.data ? { ...state, status: "ready" as const } : state;
  };
  const refreshAll = () => {
    props.onChanged?.();
    void files.refresh({ force: true });
    void outputs.refresh({ force: true });
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
        <ProposePlay missionId={props.mission.missionId} achieved={props.mission.state === "closed" && props.mission.outcome === "achieved"} />
      </div>
      <ScreenRegion
        state={regionState()}
        skeleton="cards"
        onRetry={refreshAll}
        emptyTitle="No results yet"
        emptyDescription="Each task's result appears here as soon as it finishes."
      >
        <div class="flex min-w-0 flex-col gap-3" data-testid="mission-results">
          <For each={taskIds()}>
            {(id) => (
              <ResultCard
                task={taskById().get(id)!}
                links={files.state().data?.grouping.links ?? []}
                documents={documentsOf(id)}
                initiallyOpen={opensFirst(id)}
                scrollTo={wanted() === id}
                onToggle={(open) => remember(id, open)}
                onChanged={refreshAll}
              />
            )}
          </For>
        </div>
      </ScreenRegion>
      <Show when={strays().length > 0}>
        <div class="mt-6 flex min-w-0 flex-col gap-2" data-testid="other-documents">
          <h3 class="text-base-medium text-ink-gray-9">Other documents</h3>
          <div class="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-2">
            <For each={strays()}>{(output) => <DocumentCard output={output} />}</For>
          </div>
          <TechnicalDetails label="About document versions">
            <p>Versions are immutable. A task input pins one exact verified final version when its attempt is admitted.</p>
          </TechnicalDetails>
        </div>
      </Show>
    </WorkspaceSection>
  );
}
