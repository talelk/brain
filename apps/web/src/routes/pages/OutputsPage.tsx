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
import type { OutputGrouping, OutputItem, OutputScope, OutputView } from "../../ui/outputs/OutputBrowser";
import { execArtifactUrl } from "../../ui/exec/exec-filters";

/**
 * The Output Browser route (`/w/:id/outputs`, T61): a file explorer over
 * everything the workspace's missions produced — an independent, permanently
 * accessible primary experience, not a tab of run detail. Folder, layout,
 * search, type, state filter and the previewed file persist in the URL; a
 * two-file compare hands off to the workspace-free `/outputs/:id` route where
 * `artifacts.diff` is declared.
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
  const param = (key: string) => (typeof searchParams[key] === "string" ? (searchParams[key] as string) : "");
  const view = (): OutputView => (param("view") === "list" ? "list" : "grid");

  // "current" lists fresh (still-uploading) and final output together so new
  // work is never hidden behind a "verified" default. Results and attempt records are listed apart: the Result
  // count and its paging are the server's true total of results, and records never inflate either.
  const [pages, setPages] = createSignal(1);
  const artifacts = createScopedRead<{ items: OutputItem[]; total: number; recordsTotal: number }>({
    scope: app.scope,
    load: async (readScope, signal) => {
      const filter = stateFilter();
      const states: ArtifactState[] = filter === "current" ? ["uploading", "verified"] : [filter as ArtifactState];
      const producer = {
        ...(scope().jobId ? { jobId: scope().jobId } : {}),
        ...(scope().runId ? { runId: scope().runId } : {}),
        ...(scope().workItemId ? { workItemId: scope().workItemId } : {}),
      };
      const results = await Promise.all(states.map(async (state) => {
        const items: OutputItem[] = [];
        let cursor: string | undefined;
        let total = 0;
        let first: Awaited<ReturnType<typeof artifactsListQuery>> | undefined;
        for (let page = 0; page < pages(); page += 1) {
          const response = await artifactsListQuery({ workspaceId: readScope.workspaceId, ...producer, state, kind: "result", ...(cursor ? { cursor } : {}) }, signal);
          first ??= response;
          total = response.totalEstimate ?? response.snapshot.items.length;
          items.push(...response.snapshot.items.map((item) => ({ ...item, state })));
          cursor = response.cursor || undefined;
          if (!cursor) break;
        }
        const records = await artifactsListQuery({ workspaceId: readScope.workspaceId, ...producer, state, kind: "record" }, signal);
        return { first: first!, items: [...items, ...records.snapshot.items.map((item) => ({ ...item, state }))], total, recordsTotal: records.totalEstimate ?? records.snapshot.items.length };
      }));
      return {
        asOf: results[0]!.first.asOf, sourceWatermark: results[0]!.first.sourceWatermark,
        snapshot: { items: results.flatMap((result) => result.items), total: results.reduce((sum, result) => sum + result.total, 0), recordsTotal: results.reduce((sum, result) => sum + result.recordsTotal, 0) },
      };
    },
    isEmpty: (loaded) => loaded.items.length === 0,
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
      return {
        snapshot: {
          workItems: items.snapshot.items,
          missionTitles: Object.fromEntries(missions.snapshot.items.map((mission) => [mission.missionId, mission.title])),
          links: links.snapshot.items,
        },
        asOf: links.asOf,
        sourceWatermark: links.sourceWatermark,
      };
    },
  });

  const updateParams = (patch: Record<string, string | undefined>) => {
    setSearchParams({
      job: searchParams.job,
      run: searchParams.run,
      workItem: searchParams.workItem,
      artifact: searchParams.artifact,
      state: searchParams.state,
      folder: searchParams.folder,
      view: searchParams.view,
      q: searchParams.q,
      kind: searchParams.kind,
      ...patch,
    });
  };

  return (
    <BrainPage
      title="Outputs"
      description="Every file your missions produced. Review it, accept it or ask for changes."
    >
      <PageStack>
        <OutputBrowser
          artifacts={artifacts.state().data?.items ?? []}
          total={artifacts.state().data?.total ?? 0}
          recordsTotal={artifacts.state().data?.recordsTotal ?? 0}
          onMore={() => { setPages(pages() + 1); void artifacts.refresh({ force: true }); }}
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
          folder={param("folder") || undefined}
          onFolder={(folder) => updateParams({ folder })}
          view={view()}
          onView={(next) => updateParams({ view: next === "grid" ? undefined : next })}
          search={param("q")}
          onSearch={(q) => setSearchParams({ q: q || undefined }, { replace: true })}
          kind={param("kind")}
          onKind={(kind) => updateParams({ kind: kind || undefined })}
          selectedId={selectedId()}
          onSelect={(artifactId) => updateParams({ artifact: artifactId })}
          onCompare={(leftId, rightId) => void navigate(execArtifactUrl(rightId, { leftId, rightId }))}
          detail={{ history: detail.state().data ?? undefined, loading: detail.state().status === "loading", error: detail.state().error ?? "" }}
          grouping={grouping.state().data ?? { workItems: [], missionTitles: {}, links: [] }}
          onRefresh={() => {
            setPages(1);
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
