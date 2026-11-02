import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Select } from "@talelk/newui-molecules";
import { PaneLayout } from "@talelk/newui-templates";
import type { ExecutionLink } from "@brain/contracts";
import { ScreenRegion } from "../screen-region";
import type { ScreenState } from "../../data/screens";
import { shortDigest } from "../format";
import { LIST_PAGE_SIZE, IconTile, Pager, RefreshButton } from "../components/primitives";
import { EmptyPreview, WorkspaceSection } from "../components/Domain";
import { PageStack } from "../components/PageLayout";
import type { ArtifactHistory, ArtifactRef } from "../../data/exec-outputs";
import { ArtifactView, previewKindOf } from "./ArtifactView";
import { ArtifactMetaStrip, OutputHistory } from "./OutputHistory";

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

/** The list is filtered server-side by artifact state; "verified" is the default final view. */
const STATE_OPTIONS = [
  { value: "verified", label: "Final artifacts", description: "Completed outputs bound to their immutable digest" },
  { value: "uploading", label: "Provisional snapshots", description: "Shown only when the runtime actually publishes them" },
  { value: "quarantined", label: "Quarantined", description: "Failed verification; kept for audit" },
  { value: "deleted", label: "Deleted", description: "Removed from the browser; retained for audit" },
] as const;

export interface OutputScope {
  jobId?: string;
  runId?: string;
  workItemId?: string;
}

export function OutputBrowser(props: {
  artifacts: readonly ArtifactRef[];
  state: ScreenState<unknown>;
  stateFilter: string;
  onStateFilter: (value: string) => void;
  scope: OutputScope;
  onScopeChange: (scope: OutputScope) => void;
  selectedId: string | undefined;
  onSelect: (artifactId: string) => void;
  compareIds: readonly string[];
  onToggleCompare: (artifactId: string) => void;
  onCompare: (leftId: string, rightId: string) => void;
  detail: { history?: ArtifactHistory; loading: boolean; error: string };
  executions: readonly ExecutionLink[];
  onRefresh: () => void;
  onOpenDetail: (artifactId: string) => void;
}): JSX.Element {
  const [page, setPage] = createSignal(1);
  const paged = () => {
    const pageCount = Math.max(1, Math.ceil(props.artifacts.length / LIST_PAGE_SIZE));
    const current = Math.min(Math.max(1, page()), pageCount);
    return { current, visible: props.artifacts.slice((current - 1) * LIST_PAGE_SIZE, current * LIST_PAGE_SIZE) };
  };
  const selected = () => props.artifacts.find((artifact) => artifact.artifactId === props.selectedId);
  const scopeChips = createMemo(() => [
    ...(props.scope.jobId ? [{ key: "jobId" as const, label: `Run ${shortDigest(props.scope.jobId, 10)}` }] : []),
    ...(props.scope.runId ? [{ key: "runId" as const, label: `Workflow run ${shortDigest(props.scope.runId, 10)}` }] : []),
    ...(props.scope.workItemId ? [{ key: "workItemId" as const, label: `Work item ${shortDigest(props.scope.workItemId, 10)}` }] : []),
  ]);
  const stateOption = () => STATE_OPTIONS.find((option) => option.value === props.stateFilter) ?? STATE_OPTIONS[0];

  const list = (
    <WorkspaceSection
      title="Authorized artifacts"
      description="Generated outputs Brain is authorized to show. Preview is inline; download is an action beside it, never the only way to read."
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
            ? "No artifacts from this producer yet"
            : stateOption().value === "verified"
              ? "No final artifacts yet"
              : `No ${stateOption().label.toLowerCase()} right now`
        }
        emptyDescription={
          scopeChips().length
            ? "Clear a scope chip or pick another producer; artifacts appear here as soon as their attempt publishes them."
            : "Artifacts appear here as runs publish them, with previews, verification status and version history."
        }
      >
        <div class="flex flex-col gap-2" data-testid="outputs-list">
          <For each={paged().visible}>
            {(artifact) => (
              <ArtifactRow
                artifact={artifact}
                selected={props.selectedId === artifact.artifactId}
                comparePicked={props.compareIds.includes(artifact.artifactId)}
                onSelect={() => props.onSelect(artifact.artifactId)}
                onToggleCompare={() => props.onToggleCompare(artifact.artifactId)}
              />
            )}
          </For>
        </div>
        <Pager count={props.artifacts.length} page={paged().current} onPage={setPage} label="Artifact list pagination" />
      </ScreenRegion>
    </WorkspaceSection>
  );

  const detail = (
    <WorkspaceSection title="Artifact inspection" description="Native preview, producer, verification status and version history for the selected artifact.">
      <Show
        when={props.selectedId}
        keyed
        fallback={
          <EmptyPreview
            icon="lucide-package"
            title="Select an artifact"
            description="Its preview, source, producer, verification and history appear here without leaving the browser."
          />
        }
      >
        {(selectedId) => (
          <Show when={selected()} fallback={<OpenDetailHint artifactId={selectedId} onOpenDetail={props.onOpenDetail} />}>
            {(artifact) => (
              <div class="brain-detail-stack" data-testid="outputs-detail">
                <ArtifactMetaStrip history={props.detail.history} loading={props.detail.loading} error={props.detail.error} executions={props.executions} />
                <ArtifactView artifact={artifact()} />
                <OutputHistory history={props.detail.history} loading={props.detail.loading} error={props.detail.error} />
                <div>
                  <Button size="md" variant="outline" iconRight="lucide-external-link" onClick={() => props.onOpenDetail(artifact().artifactId)}>
                    Open workspace-free detail
                  </Button>
                </div>
              </div>
            )}
          </Show>
        )}
      </Show>
    </WorkspaceSection>
  );

  return (
    <PageStack>
      <div class="flex flex-wrap items-end gap-control-gap">
        <Select
          class="w-64"
          label="Artifact state"
          value={props.stateFilter || "verified"}
          options={STATE_OPTIONS.map((option) => ({ value: option.value, label: option.label, description: option.description }))}
          onValueChange={(value) => {
            setPage(1);
            props.onStateFilter(value ?? "verified");
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
        <span class="ms-auto">
          <RefreshButton onClick={props.onRefresh} />
        </span>
      </div>
      <Show
        when={props.compareIds.length > 0}
        fallback={<p class="text-caption text-ink-gray-6">Pick any two artifacts with the compare control to open their diff on the artifact detail route.</p>}
      >
        {(() => {
          const left = props.compareIds[0] ?? "";
          const right = props.compareIds[1] ?? "";
          return (
            <div
              class="flex flex-wrap items-center gap-control-gap rounded-card border border-outline-blue-3 bg-surface-blue-1 p-card-pad"
              data-testid="outputs-compare-bar"
            >
              <span class="text-base text-ink-gray-8">
                <For each={props.compareIds}>
                  {(id, index) => (
                    <>
                      <Show when={index() > 0}>
                        <span class="mx-1 text-ink-gray-6">→</span>
                      </Show>
                      <span class="font-medium">{id}</span>
                    </>
                  )}
                </For>
                {props.compareIds.length === 2 ? "" : " — pick one more version"}
              </span>
              <Show when={props.compareIds.length === 2}>
                <Button size="md" variant="solid" theme="blue" iconLeft="lucide-columns-2" onClick={() => props.onCompare(left, right)}>
                  Open diff
                </Button>
              </Show>
              <Button
                size="md"
                variant="ghost"
                onClick={() => {
                  for (const id of [...props.compareIds]) props.onToggleCompare(id);
                }}
              >
                Clear
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
  artifact: ArtifactRef;
  selected: boolean;
  comparePicked: boolean;
  onSelect: () => void;
  onToggleCompare: () => void;
}): JSX.Element {
  const kind = () => previewKindOf(props.artifact.mediaType);
  return (
    <div class={`flex items-stretch gap-2 rounded-control border ${props.selected ? "border-outline-blue-3 bg-surface-blue-1" : "border-outline-gray-2"} p-2`}>
      <button
        type="button"
        class="flex min-w-0 flex-1 items-start gap-3 text-start focus-visible:focus-ring"
        onClick={props.onSelect}
        aria-pressed={props.selected}
      >
        <IconTile icon={KIND_ICONS[kind()]} />
        <span class="min-w-0">
          <span class="block break-all text-base-medium text-ink-gray-9">{props.artifact.artifactId}</span>
          <span class="mt-0.5 block break-words text-caption text-ink-gray-6">
            {props.artifact.mediaType} · {props.artifact.bytes.toLocaleString()} bytes · {props.artifact.classification}
          </span>
          <span class="mt-0.5 block text-caption text-ink-gray-6" title={props.artifact.digest}>
            version {shortDigest(props.artifact.digest)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-pressed={props.comparePicked}
        title={props.comparePicked ? "Remove from comparison" : "Pick for comparison"}
        class={`mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-control border focus-visible:focus-ring ${props.comparePicked ? "border-outline-blue-4 bg-surface-blue-2 text-ink-blue-8" : "border-outline-gray-2 text-ink-gray-6 hover:bg-surface-gray-1"}`}
        onClick={props.onToggleCompare}
      >
        <span class="lucide-columns-2 size-4" aria-hidden="true" />
        <span class="sr-only">{props.comparePicked ? "Remove from comparison" : "Pick for comparison"}</span>
      </button>
    </div>
  );
}

function OpenDetailHint(props: { artifactId: string; onOpenDetail: (artifactId: string) => void }): JSX.Element {
  return (
    <EmptyPreview
      icon="lucide-package"
      title="Artifact outside this page"
      description="The linked artifact is not in the current list. Open it in the workspace-free artifact detail view."
      action={
        <Button size="md" variant="outline" onClick={() => props.onOpenDetail(props.artifactId)}>
          Open artifact detail
        </Button>
      }
    />
  );
}
