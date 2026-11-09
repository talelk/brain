import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button } from "@talelk/newui-atoms";
import { Card, EmptyState, Select } from "@talelk/newui-molecules";
import { PaneLayout } from "@talelk/newui-templates";
import { useNavigate } from "@solidjs/router";
import type { ExecutionLink, WorkItem } from "@brain/contracts";
import { ScreenRegion } from "../screen-region";
import type { ScreenState } from "../../data/screens";
import { shortDigest } from "../format";
import { LIST_PAGE_SIZE, Pager } from "../components/primitives";
import { WorkspaceSection } from "../components/Domain";
import { PageStack } from "../components/PageLayout";
import { missionHref } from "../mission-links";
import { StatusIcon } from "../viz/StatusIcon";
import type { ArtifactHistory, ArtifactRef } from "../../data/exec-outputs";
import { ArtifactView, previewKindLabel, previewKindOf } from "./ArtifactView";
import { ArtifactMetaStrip, OutputHistory, resolveWorkItemLink } from "./OutputHistory";
import { OutputReview, reviewStateOf } from "./OutputReview";

/**
 * The Output Browser composition (plan T61): the authorized artifact index for
 * one workspace with native previews, live-vs-final states, verification and
 * work-item association in the detail pane, and a two-version compare hand-off
 * to the workspace-free artifact detail route (where `artifacts.diff` is
 * declared). The page owns reads and URL state; this component only renders.
 */

/** One kind → icon mapping so the list reads by preview type at a glance. */
const KIND_ICONS = {
  markdown: "lucide-file-text",
  csv: "lucide-table",
  json: "lucide-braces",
  diff: "lucide-file-diff",
  text: "lucide-file-code",
  image: "lucide-image",
  pdf: "lucide-book-open",
  none: "lucide-package",
} as const;

/** "current" shows fresh and final output together so new work is never hidden; the rest narrow it. */
const STATE_OPTIONS = [
  { value: "current", label: "Latest output", description: "Fresh and final outputs together" },
  { value: "verified", label: "Final only", description: "Completed outputs bound to their immutable digest" },
  { value: "uploading", label: "Still being produced", description: "Shown only when the runtime actually publishes them" },
  { value: "quarantined", label: "Failed checks", description: "Failed verification; kept for audit" },
  { value: "deleted", label: "Deleted", description: "Removed from the browser; retained for audit" },
] as const;

/** An artifact with the state it was listed under (the list itself carries no state). */
export type OutputItem = ArtifactRef & { state: string };

/** Where each artifact came from: its work item, that item's mission and the links that tie them together. */
export interface OutputGrouping {
  workItems: readonly WorkItem[];
  missionTitles: Readonly<Record<string, string>>;
  groupOf: Readonly<Record<string, string>>;
  links: readonly ExecutionLink[];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface OutputScope {
  jobId?: string;
  runId?: string;
  workItemId?: string;
}

export function OutputBrowser(props: {
  artifacts: readonly OutputItem[];
  state: ScreenState<unknown>;
  stateFilter: string;
  onStateFilter: (value: string) => void;
  scope: OutputScope;
  onScopeChange: (scope: OutputScope) => void;
  selectedId: string | undefined;
  onSelect: (artifactId: string) => void;
  compareMode: boolean;
  onCompareMode: (on: boolean) => void;
  compareIds: readonly string[];
  onToggleCompare: (artifactId: string) => void;
  onCompare: (leftId: string, rightId: string) => void;
  detail: { history?: ArtifactHistory; loading: boolean; error: string };
  grouping: OutputGrouping;
  onRefresh: () => void;
  onOpenDetail: (artifactId: string) => void;
}): JSX.Element {
  const [page, setPage] = createSignal(1);
  const navigate = useNavigate();
  const paged = () => {
    const pageCount = Math.max(1, Math.ceil(props.artifacts.length / LIST_PAGE_SIZE));
    const current = Math.min(Math.max(1, page()), pageCount);
    return { current, visible: props.artifacts.slice((current - 1) * LIST_PAGE_SIZE, current * LIST_PAGE_SIZE) };
  };
  const selected = () => props.artifacts.find((artifact) => artifact.artifactId === props.selectedId);
  const itemOf = (artifactId: string): WorkItem | undefined => {
    const id = props.grouping.groupOf[artifactId];
    return id ? props.grouping.workItems.find((item) => item.workItemId === id) : undefined;
  };
  /** Groups of the visible page: work items in review first, then the rest, then output with no work item. */
  const groups = createMemo(() => {
    const byKey = new Map<string, OutputItem[]>();
    for (const artifact of paged().visible) {
      const key = itemOf(artifact.artifactId)?.workItemId ?? "";
      byKey.set(key, [...(byKey.get(key) ?? []), artifact]);
    }
    const rank = (key: string) => (key === "" ? 2 : reviewStateOf(props.grouping.workItems.find((item) => item.workItemId === key)) === "review" ? 0 : 1);
    return [...byKey.entries()]
      .sort((left, right) => rank(left[0]) - rank(right[0]))
      .map(([key, artifacts]) => ({ key, item: props.grouping.workItems.find((candidate) => candidate.workItemId === key), artifacts }));
  });
  const scopeChips = createMemo(() => [
    ...(props.scope.jobId ? [{ key: "jobId" as const, label: `Run ${shortDigest(props.scope.jobId, 10)}` }] : []),
    ...(props.scope.runId ? [{ key: "runId" as const, label: `Workflow run ${shortDigest(props.scope.runId, 10)}` }] : []),
    ...(props.scope.workItemId ? [{ key: "workItemId" as const, label: `Work item ${shortDigest(props.scope.workItemId, 10)}` }] : []),
  ]);
  const stateOption = () => STATE_OPTIONS.find((option) => option.value === props.stateFilter) ?? STATE_OPTIONS[0];
  const reviewCount = () => props.grouping.workItems.filter((item) => reviewStateOf(item) === "review" && Object.values(props.grouping.groupOf).includes(item.workItemId)).length;

  const list = (
    <WorkspaceSection
      title="Outputs"
      description={reviewCount() ? `${reviewCount()} ${reviewCount() === 1 ? "piece of work needs" : "pieces of work need"} your review.` : "What your missions have produced, newest first."}
    >
      <Show when={props.stateFilter === "uploading"}>
        <p class="text-caption text-ink-gray-6">
          Provisional snapshots appear only while the runtime actually publishes them; Brain binds the final artifact digest and its verification when the run
          completes.
        </p>
      </Show>
      <ScreenRegion
        state={props.state}
        skeleton="rows"
        onRetry={props.onRefresh}
        emptyTitle={
          scopeChips().length
            ? "No outputs from this producer yet"
            : stateOption().value === "current"
              ? "Nothing produced yet"
              : `No ${stateOption().label.toLowerCase()} right now`
        }
        emptyDescription={
          scopeChips().length
            ? "Clear a scope chip or pick another producer; outputs appear here as soon as their attempt publishes them."
            : "Outputs appear here as runs publish them, with previews, verification status and version history."
        }
      >
        <div class="flex flex-col gap-4" data-testid="outputs-list">
          <For each={groups()}>
            {(group) => (
              <section class="flex min-w-0 flex-col gap-2" aria-label={group.item?.title ?? "Other outputs"} data-testid="outputs-group">
                <header class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 class="min-w-0 text-interface font-medium text-ink-gray-9">{group.item?.title ?? "Other outputs"}</h3>
                  <Show when={group.item && reviewStateOf(group.item) === "review"}>
                    <Badge size="sm" theme="amber" label="Needs review" />
                  </Show>
                  <Show when={group.item}>
                    {(item) => (
                      <a
                        class="text-caption text-ink-blue-7 hover:underline focus-visible:focus-ring"
                        href={missionHref(item().workspaceId, item().missionId, "plan")}
                        onClick={(event) => {
                          event.preventDefault();
                          void navigate(missionHref(item().workspaceId, item().missionId, "plan"));
                        }}
                      >
                        {props.grouping.missionTitles[item().missionId] ?? "Open mission"}
                      </a>
                    )}
                  </Show>
                </header>
                <For each={group.artifacts}>
                  {(artifact) => (
                    <ArtifactRow
                      artifact={artifact}
                      selected={props.selectedId === artifact.artifactId}
                      compareMode={props.compareMode}
                      comparePicked={props.compareIds.includes(artifact.artifactId)}
                      onSelect={() => props.onSelect(artifact.artifactId)}
                      onToggleCompare={() => props.onToggleCompare(artifact.artifactId)}
                    />
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
        <Pager count={props.artifacts.length} page={paged().current} onPage={setPage} label="Output list pagination" />
      </ScreenRegion>
    </WorkspaceSection>
  );

  const detail = (
    <WorkspaceSection title="Review" description="Look at the output first, then accept it or ask for changes.">
      <Show
        when={props.selectedId}
        keyed
        fallback={
          <EmptyState size="sm"
            icon="lucide-package"
            title="Select an output"
            description="Its preview, review action and history appear here without leaving the page."
          />
        }
      >
        {(selectedId) => (
          <Show when={selected()} fallback={<OpenDetailHint artifactId={selectedId} onOpenDetail={props.onOpenDetail} />}>
            {(artifact) => {
              const item = () => itemOf(artifact().artifactId);
              return (
                <div class="brain-detail-stack" data-testid="outputs-detail">
                  <ArtifactView artifact={artifact()} />
                  <OutputReview
                    item={item()}
                    link={props.grouping.links.find((link) => link.workItemId === item()?.workItemId) ?? resolveWorkItemLink(props.grouping.links, props.detail.history)}
                    history={props.detail.history}
                    onChanged={props.onRefresh}
                  />
                  <details class="rounded-card border border-outline-gray-2 p-3">
                    <summary class="cursor-pointer text-interface font-medium text-ink-gray-9">Details: source, producer, digest</summary>
                    <div class="mt-2">
                      <ArtifactMetaStrip history={props.detail.history} loading={props.detail.loading} error={props.detail.error} executions={props.grouping.links} />
                    </div>
                  </details>
                  <OutputHistory history={props.detail.history} loading={props.detail.loading} error={props.detail.error} />
                  <div>
                    <Button size="sm" variant="ghost" iconRight="lucide-external-link" onClick={() => props.onOpenDetail(artifact().artifactId)}>
                      Open full page
                    </Button>
                  </div>
                </div>
              );
            }}
          </Show>
        )}
      </Show>
    </WorkspaceSection>
  );

  return (
    <PageStack>
      <Card padding="sm" class="flex-row flex-wrap items-end gap-3">
        <Select
          class="w-64"
          label="Show"
          value={props.stateFilter || "current"}
          options={STATE_OPTIONS.map((option) => ({ value: option.value, label: option.label, description: option.description }))}
          onValueChange={(value) => {
            setPage(1);
            props.onStateFilter(value ?? "current");
          }}
        />
        <Show when={scopeChips().length}>
          <fieldset class="m-0 flex flex-wrap items-center gap-1 border-0 p-0">
            <legend class="sr-only">Scoped to a producer or work item</legend>
            <For each={scopeChips()}>
              {(chip) => (
                <span class="inline-flex items-center gap-1 rounded-control border border-outline-blue-3 bg-surface-blue-1 px-2 py-1 text-caption text-ink-blue-8">
                  {chip.label}
                  <button
                    type="button"
                    aria-label={`Remove ${chip.label} scope`}
                    class="focus-visible:focus-ring"
                    onClick={() => props.onScopeChange({ ...props.scope, [chip.key]: undefined })}
                  >
                    <span class="lucide-x size-3.5" aria-hidden="true" />
                  </button>
                </span>
              )}
            </For>
          </fieldset>
        </Show>
        <span class="ms-auto flex items-center gap-2">
          <Button size="sm" variant="outline" iconLeft="lucide-columns-2" aria-pressed={props.compareMode} onClick={() => props.onCompareMode(!props.compareMode)}>
            Compare versions
          </Button>
          <Button size="sm" variant="ghost" iconLeft="lucide-refresh-cw" onClick={props.onRefresh}>Refresh</Button>
        </span>
      </Card>
      <Show when={props.compareMode}>
        {(() => {
          const left = () => props.compareIds[0] ?? "";
          const right = () => props.compareIds[1] ?? "";
          return (
            <div
              class="flex min-w-0 flex-wrap items-center gap-2 rounded-card border border-outline-blue-3 bg-surface-blue-1 p-2"
              data-testid="outputs-compare-bar"
            >
              <span class="min-w-0 break-all text-caption text-ink-gray-8">
                {props.compareIds.length === 0 ? "Tick two outputs in the list to compare them." : props.compareIds.length === 1 ? "Tick one more output." : `${left()} → ${right()}`}
              </span>
              <Show when={props.compareIds.length === 2}>
                <Button size="sm" variant="solid" theme="blue" iconLeft="lucide-columns-2" onClick={() => props.onCompare(left(), right())}>
                  Open diff
                </Button>
              </Show>
              <Button size="sm" variant="ghost" onClick={() => props.onCompareMode(false)}>
                Cancel
              </Button>
            </div>
          );
        })()}
      </Show>
      <PaneLayout
        class="brain-list-detail"
        startSize={40}
        minStartSize={28}
        maxStartSize={58}
        active={props.selectedId ? "end" : "start"}
        start={list}
        end={detail}
      />
    </PageStack>
  );
}

function ArtifactRow(props: {
  artifact: OutputItem;
  selected: boolean;
  compareMode: boolean;
  comparePicked: boolean;
  onSelect: () => void;
  onToggleCompare: () => void;
}): JSX.Element {
  const kind = () => previewKindOf(props.artifact.mediaType);
  const final = () => props.artifact.state === "verified";
  const label = () => (final() ? "Final" : props.artifact.state === "uploading" ? "In progress" : props.artifact.state === "quarantined" ? "Failed checks" : props.artifact.state);
  const theme = () => (final() ? ("green" as const) : props.artifact.state === "quarantined" ? ("red" as const) : ("amber" as const));
  return (
    <div class={`flex items-stretch gap-1.5 rounded-control border ${props.selected ? "border-outline-blue-3 bg-surface-blue-1" : "border-outline-gray-2"} p-1.5`}>
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2.5 text-start focus-visible:focus-ring"
        onClick={props.onSelect}
        aria-pressed={props.selected}
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-control bg-surface-blue-2 text-ink-blue-8"><span class={`${KIND_ICONS[kind()]} size-4`} aria-hidden="true" /></span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-interface font-medium text-ink-gray-9" title={props.artifact.artifactId}>{props.artifact.artifactId}</span>
          <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-ink-gray-6" title={`${props.artifact.mediaType} · ${props.artifact.bytes.toLocaleString()} bytes · ${props.artifact.classification} · ${props.artifact.digest}`}>
            <StatusIcon state={label()} theme={theme()} />
            <span class="shrink-0">{label()}</span>
            <span aria-hidden="true">·</span>
            <span class="truncate">{previewKindLabel(kind())} · {formatBytes(props.artifact.bytes)}</span>
          </span>
        </span>
      </button>
      <Show when={props.compareMode}>
        <button
          type="button"
          aria-pressed={props.comparePicked}
          title={props.comparePicked ? "Remove from comparison" : "Pick for comparison"}
          class={`inline-flex size-8 shrink-0 items-center justify-center self-center rounded-control border focus-visible:focus-ring ${props.comparePicked ? "border-outline-blue-4 bg-surface-blue-2 text-ink-blue-8" : "border-outline-gray-2 text-ink-gray-6 hover:bg-surface-gray-1"}`}
          onClick={props.onToggleCompare}
        >
          <span class={`${props.comparePicked ? "lucide-square-check" : "lucide-square"} size-4`} aria-hidden="true" />
          <span class="sr-only">{props.comparePicked ? "Remove from comparison" : "Pick for comparison"}</span>
        </button>
      </Show>
    </div>
  );
}

function OpenDetailHint(props: { artifactId: string; onOpenDetail: (artifactId: string) => void }): JSX.Element {
  return (
    <EmptyState size="sm"
      icon="lucide-package"
      title="Output outside this list"
      description="The linked output is not in the current list. Open it on its own page."
      action={
        <Button size="sm" variant="outline" onClick={() => props.onOpenDetail(props.artifactId)}>
          Open output
        </Button>
      }
    />
  );
}
