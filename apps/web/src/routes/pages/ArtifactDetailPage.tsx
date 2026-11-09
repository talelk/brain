import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { ExecutionLink } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { artifactsHistoryQuery } from "../../data/exec-outputs";
import type { ArtifactHistory } from "../../data/exec-outputs";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { WorkspaceSection } from "../../ui/components/Domain";import { ScreenRegion } from "../../ui/screen-region";
import { ArtifactView } from "../../ui/outputs/ArtifactView";
import { ArtifactMetaStrip, OutputHistory } from "../../ui/outputs/OutputHistory";
import { OutputDiff } from "../../ui/outputs/OutputDiff";
import { execOutputsUrl } from "../../ui/exec/exec-filters";

/**
 * Material outside any mission at `/outputs/:id` (T61): preview,
 * metadata, independent verification status, version history — and, via the
 * `/compare?left=&right=` deep link other surfaces build, the diff between two
 * versions. Session state never lives here; the Live console stays the only
 * session surface and this page never reproduces it.
 */
export default function ArtifactDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const artifactId = () => params.id;
  const leftId = () => (typeof searchParams.left === "string" && searchParams.left ? searchParams.left : "");
  const rightId = () => (typeof searchParams.right === "string" && searchParams.right ? searchParams.right : "");
  const diffMode = () => Boolean(leftId() && rightId());

  const history = createScopedRead<ArtifactHistory | null>({
    scope: app.scope,
    resource: () => artifactId(),
    load: async (_readScope, signal, resource) => {
      if (!resource) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      return artifactsHistoryQuery({ artifactId: resource }, signal);
    },
    isEmpty: (loaded) => !loaded,
  });

  // Execution links resolve the producer's work-item association; they belong
  // to the artifact's own workspace, which history resolves from the digest.
  const executions = createScopedRead<ExecutionLink[]>({
    scope: () => ({
      organizationId: app.identity()?.actor.organizationId ?? "",
      workspaceId: history.state().data?.workspaceId ?? "",
      generation: app.scope().generation,
    }),
    load: async (readScope, signal) => {
      if (!readScope.workspaceId) return { snapshot: [], asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: { items: ExecutionLink[] }; asOf: string; sourceWatermark: number }>(
        { queryType: "executionLinks.list", workspaceId: readScope.workspaceId, limit: 100 },
        signal,
      );
      return { snapshot: [...response.snapshot.items], asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (links) => links.length === 0,
  });

  const previewArtifact = () => {
    const current = history.state().data;
    if (!current) return undefined;
    return {
      artifactId: current.artifactId,
      digest: current.digest,
      bytes: current.bytes,
      mediaType: current.mediaType,
      classification: current.classification,
    };
  };

  return (
    <BrainPage title="Artifact" description="One artifact: native preview, source, producer, independent verification, versions and diffs.">
      <PageStack>
        <div class="flex flex-wrap items-center justify-between gap-control-gap">
          <Show when={history.state().data} keyed fallback={<span />}>
            {(current) => (
              <Show when={current.workspaceId}>
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft="lucide-arrow-left"
                  onClick={() => void navigate(execOutputsUrl(current.workspaceId, { jobId: current.producer?.jobId }))}
                >
                  Open in the Output Browser
                </Button>
              </Show>
            )}
          </Show>
          <Show when={diffMode()}>
            <Button size="sm" variant="outline" iconLeft="lucide-x" onClick={() => void navigate(`/outputs/${artifactId()}`)}>
              Exit comparison
            </Button>
          </Show>
        </div>
        <Show
          when={diffMode()}
          fallback={
            <ScreenRegion
              state={history.state()}
              skeleton="cards"
              emptyTitle="Artifact not found"
              emptyDescription="No authorized artifact with this id exists for your organization — it may have been removed, or it belongs to a workspace you cannot read."
            >
              <div class="brain-detail-stack">
                <ArtifactMetaStrip
                  history={history.state().data ?? undefined}
                  loading={history.state().status === "loading"}
                  error={history.state().error ?? ""}
                  executions={executions.state().data}
                />
                <WorkspaceSection title="Preview" description="Authorized inline preview; download stays an action beside it.">
                  <ArtifactView artifact={previewArtifact()} />
                </WorkspaceSection>
                <WorkspaceSection
                  title="Versions and verification"
                  description="Evidence bundles pinning this digest over time, each with its independent verdict."
                >
                  <OutputHistory
                    history={history.state().data ?? undefined}
                    loading={history.state().status === "loading"}
                    error={history.state().error ?? ""}
                  />
                </WorkspaceSection>
                <p class="text-caption text-ink-gray-6">
                  Compare two versions from the Output Browser's compare picks — they deep-link to <code>/compare?left=…&amp;right=…</code>.
                </p>
              </div>
            </ScreenRegion>
          }
        >
          <div class="brain-detail-stack">
            <WorkspaceSection
              title="Version comparison"
              description="Unified diff of the selected versions; text, JSON, code and CSV compare within the byte bound."
            >
              <OutputDiff leftId={leftId()} rightId={rightId()} />
            </WorkspaceSection>
            <WorkspaceSection title="Versions and verification" description="The evidence bundles that pin these digests and their independent verdicts.">
              <OutputHistory history={history.state().data ?? undefined} loading={history.state().status === "loading"} error={history.state().error ?? ""} />
            </WorkspaceSection>
          </div>
        </Show>
      </PageStack>
    </BrainPage>
  );
}
