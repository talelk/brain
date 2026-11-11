import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useLocation, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { Badge, Button } from "@talelk/newui-atoms";
import { FileCard, Select } from "@talelk/newui-molecules";
import type { OutputDetail, OutputRef, OutputVersion } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { QueueRow, WorkspaceSection } from "../../ui/components/Domain";
import { ActionFeedback } from "../../ui/components/ActionFeedback";
import { ArtifactView } from "../../ui/outputs/ArtifactView";
import { saveAsKnowledge } from "../../ui/outputs/review-actions";
import { ShareResult } from "../../ui/outputs/ShareResult";
import { ChallengeFeedProvider, ChallengeResult } from "../../ui/outputs/ChallengeResult";
import { OutputDiff } from "../../ui/outputs/OutputDiff";
import { formatDateTime, formatRelative, friendlyOutputName, shortDigest } from "../../ui/format";
import { missionHref } from "../../ui/mission-links";

const single = (value: unknown): string => (typeof value === "string" && value ? value : "");

/**
 * A named output (T61, #41/#43): one mission's output by name with every
 * version and its lineage across missions. `?v=` opens one version and
 * `/compare?left=&right=` diffs two versions beside their provenance.
 */
export default function NamedOutputPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const [search] = useSearchParams();
  const [compareWith, setCompareWith] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal<{ tone: "success" | "error"; message: string }>();
  const comparing = () => location.pathname.endsWith("/compare");
  const detail = createScopedRead<OutputDetail | null>({
    scope: app.scope,
    resource: () => params.id,
    load: async (scope, signal, resource) => {
      const response = await query<{ snapshot: OutputDetail; asOf: string; sourceWatermark: number }>({ queryType: "missionOutputs.get", workspaceId: scope.workspaceId, resourceId: resource }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (loaded) => !loaded,
  });
  const versions = (): readonly OutputVersion[] => detail.state().data?.output.versions ?? [];
  const latest = () => versions().at(-1);
  const find = (id: string) => versions().find((version) => version.versionId === id);
  const selected = () => find(single(search.v)) ?? latest();
  const label = (version: OutputVersion) => `Version ${versions().indexOf(version) + 1}`;
  const artifactOf = (version?: OutputVersion) => detail.state().data?.artifacts.find((entry) => entry.versionId === version?.versionId)?.artifact;
  const base = () => `/outputs/${encodeURIComponent(params.id ?? "")}`;
  const left = () => find(single(search.left));
  const right = () => find(single(search.right));
  const openRef = (ref: OutputRef) => void navigate(`/outputs/${encodeURIComponent(ref.outputId)}`);
  async function saveSelected(): Promise<void> {
    const version = selected();
    const artifact = artifactOf(version);
    if (!version || !artifact || saving()) return;
    setSaving(true);
    setSaved(undefined);
    const result = await saveAsKnowledge(app, artifact, `${detail.state().data?.output.name ?? "Output"} (${label(version)})`);
    setSaving(false);
    setSaved(result.accepted ? { tone: "success", message: result.searchable ? `${label(version)} was saved to the Library. It is searchable by agents now.` : `${label(version)} was saved to the Library, but this file type cannot be read, so agents cannot search it.` } : { tone: "error", message: result.detail });
  }

  const provenance = (version: OutputVersion) => <div class="flex flex-col gap-1">
    <span class="text-base-medium text-ink-gray-9">{label(version)}</span>
    <div class="flex flex-wrap items-center gap-2">
      <Badge variant="outline" theme={version.state === "final" ? "blue" : "gray"} label={version.state === "final" ? "Final" : "Draft"} />
      <Badge variant="outline" theme={version.verified ? "green" : "gray"} label={version.verified ? "Verified" : "Not verified"} />
    </div>
    <span class="text-caption text-ink-gray-6">Recorded {formatDateTime(version.createdAt)} by work item {version.workItemId}</span>
  </div>;

  return <ChallengeFeedProvider><BrainPage title={friendlyOutputName(detail.state().data?.output.name ?? "Output")} description="A named mission output: read any version, see its lineage and compare versions."
    actions={<Show when={detail.state().data}>{(loaded) => <div class="flex flex-wrap gap-2">
      <Button variant="outline" iconLeft="lucide-library" disabled={!artifactOf(selected()) || saving()} loading={saving()} onClick={() => void saveSelected()}>Save as knowledge</Button>
      <Button variant="outline" iconLeft="lucide-flag" onClick={() => void navigate(missionHref(app.workspaceId(), loaded().output.missionId, "outputs"))}>{loaded().missionTitle}</Button>
    </div>}</Show>}>
    <PageStack>
      <ScreenRegion state={detail.state()} onRetry={() => void detail.refresh({ force: true })} emptyTitle="Output not found"
        emptyDescription="No output with this id exists in the current workspace, or you cannot read it.">
        <Show when={comparing()} fallback={<>
          <Show when={saved()}>{(current) => <ActionFeedback tone={current().tone} message={current().message} title="Not saved" />}</Show>
          <div class="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <WorkspaceSection title="Selected version" description="Final versions become verified when their work item is Done on verified evidence; only verified final versions feed other work.">
              <Show when={selected()} keyed fallback={<p class="text-interface text-ink-gray-7">No version has been recorded yet.</p>}>{(version) => <div class="flex min-w-0 flex-col gap-4">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" theme={version.state === "final" ? "blue" : "gray"} label={version.state === "final" ? "Final" : "Draft"} />
                  <Badge variant="outline" theme={version.verified ? "green" : "gray"} label={version.verified ? "Verified" : "Not verified"} />
                  <span class="text-caption text-ink-gray-6">Recorded {formatRelative(version.createdAt)}</span>
                </div>
                <ArtifactView artifact={artifactOf(version)} title={label(version)} />
                <ShareResult versionId={version.versionId} verified={version.verified && version.state === "final"} />
                <ChallengeResult workItemId={version.workItemId} finished={version.verified} />
                <details class="rounded-card border border-outline-gray-2 p-3">
                  <summary class="cursor-pointer text-interface font-medium text-ink-gray-9">Details</summary>
                  <dl class="mt-2 grid gap-x-4 gap-y-2 text-caption sm:grid-cols-2">
                    <div class="min-w-0"><dt class="text-ink-gray-6">Recorded</dt><dd class="font-medium text-ink-gray-9">{formatDateTime(version.createdAt)}</dd></div>
                    <div class="min-w-0"><dt class="text-ink-gray-6">Produced by work item</dt><dd class="break-all font-medium text-ink-gray-9">{version.workItemId}</dd></div>
                    <div class="min-w-0"><dt class="text-ink-gray-6">Digest</dt><dd class="brain-exec-log break-all font-medium text-ink-gray-9" title={version.artifactDigest}>{shortDigest(version.artifactDigest)}</dd></div>
                    <div class="min-w-0"><dt class="text-ink-gray-6">Version id</dt><dd class="break-all font-medium text-ink-gray-9">{version.versionId}</dd></div>
                  </dl>
                </details>
              </div>}</Show>
            </WorkspaceSection>
            <div class="flex min-w-0 flex-col gap-4">
              <WorkspaceSection title="Versions" description="Newest first. Open a version, or compare an earlier one with the latest.">
                <div class="flex min-w-0 flex-col gap-1.5"><For each={[...versions()].reverse()}>{(version) => <FileCard as="button" name={label(version)} icon="lucide-file-clock"
                  selected={selected()?.versionId === version.versionId} aria-label={`Open ${label(version)}`}
                  meta={`${version.state === "final" ? "Final" : "Draft"} · ${version.verified ? "verified" : "not verified"} · ${formatRelative(version.createdAt)}`}
                  onClick={() => void navigate(`${base()}?v=${encodeURIComponent(version.versionId)}`)} />}</For></div>
                <Show when={versions().length > 1}>
                  <div class="mt-4 flex flex-col gap-2">
                    <Select label="Compare the latest with" value={compareWith() || versions().at(-2)?.versionId || null}
                      options={versions().slice(0, -1).map((version) => ({ value: version.versionId, label: label(version) }))}
                      onValueChange={(id) => setCompareWith(id ?? "")} />
                    <Button variant="outline" iconLeft="lucide-git-compare"
                      onClick={() => void navigate(`${base()}/compare?left=${encodeURIComponent(compareWith() || versions().at(-2)?.versionId || "")}&right=${encodeURIComponent(latest()!.versionId)}`)}>
                      Compare versions
                    </Button>
                  </div>
                </Show>
              </WorkspaceSection>
              <WorkspaceSection title="Lineage" description="The output this one continues and the follow-up missions that continue it.">
                <Show when={detail.state().data?.continues || detail.state().data?.continuedBy.length} fallback={<p class="text-interface text-ink-gray-7">This output starts its own line: it continues no earlier output and nothing continues it yet.</p>}>
                  <div class="brain-queue">
                    <Show when={detail.state().data?.continues}>{(ref) => <QueueRow title={friendlyOutputName(ref().name)} description="Continued by this output" eyebrow="Continues" icon="lucide-history" label={`Open the continued output ${ref().name}`} onClick={() => openRef(ref())} />}</Show>
                    <For each={detail.state().data?.continuedBy ?? []}>{(ref) => <QueueRow title={friendlyOutputName(ref.name)} description="A follow-up mission's output" eyebrow="Continued by" icon="lucide-git-branch" label={`Open the follow-up output ${ref.name}`} onClick={() => openRef(ref)} />}</For>
                  </div>
                </Show>
              </WorkspaceSection>
            </div>
          </div>
        </>}>
          <WorkspaceSection title="Version comparison" description="Unified diff of two versions, each with the work item and verification that produced it."
            actions={<Button variant="outline" iconLeft="lucide-x" onClick={() => void navigate(base())}>Exit comparison</Button>}>
            <Show when={left() && right()} fallback={<p class="text-interface text-ink-gray-7">Choose two versions of this output to compare.</p>}>
              <div class="flex flex-col gap-4">
                <div class="grid gap-4 md:grid-cols-2">{provenance(left()!)}{provenance(right()!)}</div>
                <OutputDiff leftId={artifactOf(left())?.artifactId ?? ""} rightId={artifactOf(right())?.artifactId ?? ""} />
              </div>
            </Show>
          </WorkspaceSection>
        </Show>
      </ScreenRegion>
    </PageStack>
  </BrainPage></ChallengeFeedProvider>;
}
