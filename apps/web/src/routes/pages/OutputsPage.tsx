import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import type { ExecutionLink, WorkBoardView } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { artifactsHistoryQuery, artifactsListQuery } from "../../data/exec-outputs";
import type { ArtifactHistory, ArtifactRef, ArtifactState } from "../../data/exec-outputs";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { FactStrip } from "../../ui/components/Domain";
import { OutputBrowser } from "../../ui/outputs/OutputBrowser";
import type { OutputScope } from "../../ui/outputs/OutputBrowser";
import { execArtifactUrl } from "../../ui/exec/exec-filters";

/**
 * The Output Browser route (`/w/:id/outputs`, T61): an independent, permanently
 * accessible primary experience — not a tab of run detail. Filters and the
 * selected artifact persist in the URL; compare picks hand off to the
 * workspace-free `/artifacts/:id` route where `artifacts.diff` is declared.
 */
export default function OutputsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = () => (typeof searchParams.artifact === "string" && searchParams.artifact ? searchParams.artifact : undefined);
  const stateFilter = () => (typeof searchParams.state === "string" && searchParams.state ? searchParams.state : "verified");
  const scope = (): OutputScope => ({
    ...(typeof searchParams.job === "string" && searchParams.job ? { jobId: searchParams.job } : {}),
    ...(typeof searchParams.run === "string" && searchParams.run ? { runId: searchParams.run } : {}),
    ...(typeof searchParams.workItem === "string" && searchParams.workItem ? { workItemId: searchParams.workItem } : {}),
  });
  const [compareIds, setCompareIds] = createSignal<readonly string[]>([]);

  const artifacts = createScopedRead<ArtifactRef[]>({
    scope: app.scope,
    load: async (readScope, signal) => {
      const loaded = await artifactsListQuery(
        {
          workspaceId: readScope.workspaceId,
          ...(scope().jobId ? { jobId: scope().jobId } : {}),
          ...(scope().runId ? { runId: scope().runId } : {}),
          ...(scope().workItemId ? { workItemId: scope().workItemId } : {}),
          ...(stateFilter() !== "verified" ? { state: stateFilter() as ArtifactState } : {}),
        },
        signal,
      );
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
  });

  // The full metadata strip (source, producer, verification, work-item link)
  // resolves per selected artifact; a resource switch re-reads inside the scope
  // while keeping the previous body visible for kept-mounted panes.
  const detail = createScopedRead<ArtifactHistory | null>({
    scope: app.scope,
    resource: () => selectedId(),
    load: async (_readScope, signal, resource) => {
      if (!resource) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      return artifactsHistoryQuery({ artifactId: resource }, signal);
    },
    isEmpty: (loaded) => !loaded,
  });

  // Execution links resolve the artifact's producer attempt/job to its work item.
  const executions = createScopedRead<ExecutionLink[]>({
    scope: app.scope,
    load: async (readScope, signal) => {
      const response = await query<{ snapshot: WorkBoardView; asOf: string; sourceWatermark: number }>(
        { queryType: "workBoard.get", workspaceId: readScope.workspaceId },
        signal,
      );
      return { snapshot: [...response.snapshot.executions], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (links) => links.length === 0,
  });

  const updateParams = (patch: Record<string, string | undefined>) => {
    setSearchParams({
      job: searchParams.job,
      run: searchParams.run,
      workItem: searchParams.workItem,
      artifact: searchParams.artifact,
      state: searchParams.state,
      ...patch,
    });
  };

  const toggleCompare = (artifactId: string) => {
    setCompareIds((current) => {
      if (current.includes(artifactId)) return current.filter((id) => id !== artifactId);
      if (current.length < 2) return [...current, artifactId];
      return [current.at(-1) ?? artifactId, artifactId]; // keep the newest pick as the right side
    });
  };

  return (
    <BrainPage
      title="Outputs"
      description="Authorized generated artifacts with native previews, final vs provisional states, verification status, diffs and history."
    >
      <PageStack>
        <FactStrip
          label="Output browser summary"
          items={[
            {
              label: "Artifacts",
              value: String(artifacts.state().data?.length ?? 0),
              hint: stateFilter() === "verified" ? "Final, digest-bound outputs" : "Filtered by artifact state",
              icon: "lucide-package",
            },
            { label: "Workspace", value: app.workspaceId() || "—", hint: "Authorization scope of every row", icon: "lucide-folder" },
            {
              label: "Scope",
              value: (
                <Show when={scope().jobId || scope().runId || scope().workItemId} fallback={<span>Whole workspace</span>}>
                  <span class="flex flex-wrap gap-1">
                    <For each={[scope().jobId, scope().runId, scope().workItemId]}>
                      {(id) => (
                        <Show when={id}>
                          <code class="break-all">{id}</code>
                        </Show>
                      )}
                    </For>
                  </span>
                </Show>
              ),
              hint: "From the deep-link filters",
              icon: "lucide-filter",
            },
          ]}
        />
        <OutputBrowser
          artifacts={artifacts.state().data ?? []}
          state={artifacts.state()}
          stateFilter={stateFilter()}
          onStateFilter={(value) => {
            updateParams({ state: value === "verified" ? undefined : value, artifact: undefined });
            void artifacts.refresh({ force: true });
          }}
          scope={scope()}
          onScopeChange={(next) => {
            updateParams({ job: next.jobId, run: next.runId, workItem: next.workItemId, artifact: undefined });
            void artifacts.refresh({ force: true });
          }}
          selectedId={selectedId()}
          onSelect={(artifactId) => updateParams({ artifact: artifactId })}
          compareIds={compareIds()}
          onToggleCompare={toggleCompare}
          onCompare={(leftId, rightId) => void navigate(execArtifactUrl(rightId, { leftId, rightId }))}
          detail={{ history: detail.state().data ?? undefined, loading: detail.state().status === "loading", error: detail.state().error ?? "" }}
          executions={executions.state().data ?? []}
          onRefresh={() => void artifacts.refresh({ force: true })}
          onOpenDetail={(artifactId) => void navigate(execArtifactUrl(artifactId))}
        />
      </PageStack>
    </BrainPage>
  );
}
