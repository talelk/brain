import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import type { ExecutionLink, Mission, WorkItem } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { artifactsHistoryQuery, artifactsListQuery } from "../../data/exec-outputs";
import type { ArtifactHistory, ArtifactState } from "../../data/exec-outputs";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { OutputBrowser } from "../../ui/outputs/OutputBrowser";
import type { OutputGrouping, OutputItem, OutputScope } from "../../ui/outputs/OutputBrowser";
import { execArtifactUrl } from "../../ui/exec/exec-filters";

/**
 * The Output Browser route (`/w/:id/outputs`, T61): an independent, permanently
 * accessible primary experience — not a tab of run detail. Filters and the
 * selected artifact persist in the URL; compare picks hand off to the
 * workspace-free `/outputs/:id` route where `artifacts.diff` is declared.
 */
export default function OutputsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = () => (typeof searchParams.artifact === "string" && searchParams.artifact ? searchParams.artifact : undefined);
  const stateFilter = () => (typeof searchParams.state === "string" && searchParams.state ? searchParams.state : "current");
  const scope = (): OutputScope => ({
    ...(typeof searchParams.job === "string" && searchParams.job ? { jobId: searchParams.job } : {}),
    ...(typeof searchParams.run === "string" && searchParams.run ? { runId: searchParams.run } : {}),
    ...(typeof searchParams.workItem === "string" && searchParams.workItem ? { workItemId: searchParams.workItem } : {}),
  });
  const [compareIds, setCompareIds] = createSignal<readonly string[]>([]);
  const [compareMode, setCompareMode] = createSignal(false);

  // "current" lists fresh (still-uploading) and final output together so new
  // work is never hidden behind a "verified" default.
  const artifacts = createScopedRead<OutputItem[]>({
    scope: app.scope,
    load: async (readScope, signal) => {
      const filter = stateFilter();
      const states: ArtifactState[] = filter === "current" ? ["uploading", "verified"] : [filter as ArtifactState];
      const loaded = await Promise.all(
        states.map(async (state) => ({
          state,
          response: await artifactsListQuery(
            {
              workspaceId: readScope.workspaceId,
              ...(scope().jobId ? { jobId: scope().jobId } : {}),
              ...(scope().runId ? { runId: scope().runId } : {}),
              ...(scope().workItemId ? { workItemId: scope().workItemId } : {}),
              state,
            },
            signal,
          ),
        })),
      );
      const first = loaded[0]!.response;
      return { ...first, snapshot: loaded.flatMap(({ state, response }) => response.snapshot.items.map((item) => ({ ...item, state }))) };
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

  // Which work item (and mission) each output belongs to: execution links tie
  // work items to runs, and an artifacts.list scoped to a work item names its outputs.
  const grouping = createScopedRead<OutputGrouping>({
    scope: app.scope,
    load: async (readScope, signal) => {
      const read = <T,>(queryType: "executionLinks.list" | "workItems.list" | "missions.list") =>
        query<{ snapshot: { items: T[] }; asOf: string; sourceWatermark: number }>({ queryType, workspaceId: readScope.workspaceId, limit: 100 }, signal);
      const [links, items, missions] = await Promise.all([
        read<ExecutionLink>("executionLinks.list"),
        read<WorkItem>("workItems.list"),
        read<Mission>("missions.list"),
      ]);
      const linked = [...new Set(links.snapshot.items.map((link) => link.workItemId))].slice(0, 24);
      const groupOf: Record<string, string> = {};
      await Promise.all(
        linked.map(async (workItemId) => {
          for (const state of ["uploading", "verified"] as const) {
            const found = await artifactsListQuery({ workspaceId: readScope.workspaceId, workItemId, state }, signal);
            for (const artifact of found.snapshot.items) groupOf[artifact.artifactId] ??= workItemId;
          }
        }),
      );
      return {
        snapshot: {
          workItems: items.snapshot.items,
          missionTitles: Object.fromEntries(missions.snapshot.items.map((mission) => [mission.missionId, mission.title])),
          groupOf,
          links: links.snapshot.items,
        },
        asOf: links.asOf,
        sourceWatermark: links.sourceWatermark,
      };
    },
    refreshMs: 30_000,
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
      description="Everything your missions have produced. Review it, accept it or ask for changes."
    >
      <PageStack>
        <OutputBrowser
          artifacts={artifacts.state().data ?? []}
          state={artifacts.state()}
          stateFilter={stateFilter()}
          onStateFilter={(value) => {
            updateParams({ state: value === "current" ? undefined : value, artifact: undefined });
            void artifacts.refresh({ force: true });
          }}
          scope={scope()}
          onScopeChange={(next) => {
            updateParams({ job: next.jobId, run: next.runId, workItem: next.workItemId, artifact: undefined });
            void artifacts.refresh({ force: true });
          }}
          selectedId={selectedId()}
          onSelect={(artifactId) => updateParams({ artifact: artifactId })}
          compareMode={compareMode()}
          onCompareMode={(on) => {
            setCompareMode(on);
            if (!on) setCompareIds([]);
          }}
          compareIds={compareIds()}
          onToggleCompare={toggleCompare}
          onCompare={(leftId, rightId) => void navigate(execArtifactUrl(rightId, { leftId, rightId }))}
          detail={{ history: detail.state().data ?? undefined, loading: detail.state().status === "loading", error: detail.state().error ?? "" }}
          grouping={grouping.state().data ?? { workItems: [], missionTitles: {}, groupOf: {}, links: [] }}
          onRefresh={() => {
            void artifacts.refresh({ force: true });
            void grouping.refresh({ force: true });
            void detail.refresh({ force: true });
          }}
          onOpenDetail={(artifactId) => void navigate(execArtifactUrl(artifactId))}
        />
      </PageStack>
    </BrainPage>
  );
}
