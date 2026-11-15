import { ArtifactSelector, EvidenceSelector } from "../ui/components/ArtifactSelectors";
import { useApp } from "../ui/app-context";
import { createScopedRead } from "../data/screens";
import { configExplainQuery } from "../data/governor";
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { Badge, Button, KeyValue, TextInput, createMediaQuery as mediaQuery } from "@talelk/newui-atoms";
import { Alert, Dialog, Select, EmptyState } from "@talelk/newui-molecules";
import { PaneLayout } from "@talelk/newui-templates";
import type { Classification, MemoryResult, MemoryScope, ToolCatalogEntry, ToolCandidateView } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { digestTag, formatDateTime, formatRelative } from "../ui/format";
import { changeText } from "../ui/components/LearnedKnowledge";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { ReasonDialog } from "../ui/components/ReasonDialog";
import { ArtifactView } from "../ui/outputs/ArtifactView";
import { LIST_PAGE_SIZE as PAGE_SIZE, Pager } from "../ui/components/primitives";import { QueueRow, WorkspaceSection } from "../ui/components/Domain";
import { StatGrid } from "@talelk/newui-organisms";
import { MixBar } from "../ui/viz/MixBar";
import { ToolCallsPanel } from "../ui/tools/ToolCallsPanel";
import { ToolTryPanel } from "../ui/tools/ToolTryPanel";
import { authorCandidate } from "./catalog";
import { t } from "../i18n";
export interface MemoryPublicationInput {
  candidateId: string;
  sourceWorkspaceId: string;
  targetScope: MemoryScope;
  content: { artifactId: string; digest: string; bytes: number; mediaType: string; classification: Classification };
  evidenceDigests: string[];
  reviewerId: string;
  redactionProfile: { id: string; digest: string };
}

function scopeLabel(scope: MemoryScope): string {
  if (scope.visibility === "global-approved") return "Approved organization-wide";
  if (scope.visibility === "team") return "Mission team";
  if (scope.visibility === "private") return "Private · only you";
  return `Workspace · ${scope.workspaceId}`;
}

export function KnowledgeScreen(props: {
  workspaceId: string;
  tools: ToolCatalogEntry[];
  state: ScreenState<{ results: MemoryResult[]; degraded: boolean; storeLabel?: string; tools: ToolCatalogEntry[] }>;
  searched: boolean;
  onRefresh: () => void;
  onSearch: (text: string) => void;
  onPublish: (publication: MemoryPublicationInput) => Promise<void>;
  onRevoke: (sourceId: string, reason: string) => Promise<void>;
  canPublish: boolean;
}): JSX.Element {
  const app = useApp();
  const members = app.useMembers();
  const navigate = useNavigate();
  const profiles = createScopedRead<{ id: string; digest: string }[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await configExplainQuery(scope.workspaceId, "/manifest/documents", signal);
      const documents = loaded.snapshot.effective;
      return {
        ...loaded,
        snapshot: Array.isArray(documents)
          ? (documents as { kind: string; id: string; digest: string }[]).filter((document) => document.kind === "Policy")
          : [],
      };
    },
  });
  const [text, setText] = createSignal("");
  const [scopeFilter, setScopeFilter] = createSignal("all");
  const [revokeReason, setRevokeReason] = createSignal("");
  const [revokeFor, setRevokeFor] = createSignal<string>();
  const [publishOpenFor, setPublishOpenFor] = createSignal<string>();
  const [contentDigest, setContentDigest] = createSignal("");
  const [contentBytes, setContentBytes] = createSignal("");
  const [contentArtifactId, setContentArtifactId] = createSignal("");
  const [reviewerId, setReviewerId] = createSignal("");
  const [profileId, setProfileId] = createSignal("");
  const [profileDigest, setProfileDigest] = createSignal("");
  const [evidenceText, setEvidenceText] = createSignal("");
  const results = () => (props.state.data?.results ?? []).filter((result) => scopeFilter() === "all" || result.scope.visibility === scopeFilter());
  const publishing = () => results().find((result) => result.sourceId === publishOpenFor());
  const evidenceDigests = () =>
    evidenceText()
      .split(/[\s,]+/u)
      .map((digest) => digest.trim())
      .filter(Boolean);
  const publishReady = () =>
    contentDigest().trim().length > 0 &&
    Number(contentBytes()) > 0 &&
    reviewerId().trim().length > 0 &&
    profileId().trim().length > 0 &&
    profileDigest().trim().length > 0 &&
    evidenceDigests().length > 0 &&
    publishOpenFor() !== undefined;
  const canMutate = () => props.canPublish && !props.state.data?.degraded;
  // Opening the dialog for one candidate starts from clean fields, never another candidate's draft bindings.
  const openPublish = (sourceId: string) => {
    setContentArtifactId("");
    setContentDigest("");
    setContentBytes("");
    setReviewerId("");
    setProfileId("");
    setProfileDigest("");
    setEvidenceText("");
    setPublishOpenFor(sourceId);
  };

  return (
    <BrainPage
      title={t("tools.knowledge.dec1")}
      description={t("tools.find-scoped-knowledge-with-prove.7941")}
    >
      <PageStack>
        <WorkspaceSection
          title={t("tools.find-knowledge.c1b8")}
          description={t("tools.search-only-the-current-workspac.75b9")}
        >
          <form
            class="grid min-w-0 items-end gap-2 md:grid-cols-[minmax(0,1fr)_12rem_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (text().trim()) props.onSearch(text().trim());
            }}
          >
            <TextInput
              label={t("tools.search-scoped-knowledge.477b")}
              value={text()}
              placeholder={t("tools.find-a-fact-decision-or-operatio.91cb")}
              onInput={(event) => setText(event.currentTarget.value)}
            />
            <Select
              label={t("tools.result-scope.ebd3")}
              value={scopeFilter()}
              options={[
                { value: "all", label: t("tools.all-returned-scopes.9bf7") },
                { value: "workspace", label: t("tools.workspace.4ca0") },
                { value: "private", label: t("tools.private.237d") },
                { value: "team", label: t("tools.team.2188") },
                { value: "global-approved", label: t("tools.approved-organization-wide.eef4") },
              ]}
              onValueChange={(value) => setScopeFilter(value ?? "all")}
            />
            <Button size="sm" class="w-full md:w-auto" type="submit" variant="solid" theme="blue" iconLeft="lucide-search" disabled={!text().trim()}>
              Search
            </Button>
          </form>
          <Show when={props.searched && !props.state.data?.degraded && props.state.data?.storeLabel}>
            <p class="mt-1 mb-2 text-caption text-ink-gray-7" data-testid="memory-store-label"><span class="lucide-hard-drive me-1 inline-block size-3.5 align-text-bottom" aria-hidden="true" />{props.state.data?.storeLabel}: saved documents and approved knowledge, ranked by how well they match.</p>
          </Show>
          <Show when={props.state.data?.degraded}>
            <Alert
              theme="amber"
              variant="outline"
              title={t("tools.knowledge-service-is-degraded.91c2")}
              description={t("tools.results-come-from-the-local-scop.5823")}
            />
          </Show>
          <ScreenRegion
            state={props.state}
            skeleton="rows"
            emptyTitle={props.searched ? t("tools.no-knowledge-matches.6ea5") : t("tools.search-your-scoped-knowledge.3e76")}
            emptyDescription={
              props.searched
                ? "Try a different query or scope, or publish a reviewed candidate so it becomes searchable."
                : "Nothing is shown until you search. Knowledge arrives from documents you add, outputs you save, and candidates a reviewer approves. Unverified and stale results stay clearly labelled and never gain execution authority."
            }
            emptyAction={
              props.searched ? (
                <Button size="sm" onClick={props.onRefresh}>
                  Run search again
                </Button>
              ) : undefined
            }
            onRetry={props.onRefresh}
          >
            <Show
              when={results().length}
              fallback={
                <EmptyState size="sm" icon="lucide-filter" title={t("tools.no-results-in-this-scope.c3bc")} description={t("tools.choose-another-returned-scope-or.9f95")} />
              }
            >
              <div class="min-w-0 divide-y divide-outline-gray-1 border-y border-outline-gray-1">
                <For each={results()}>
                  {(result) => (
                    <article class="min-w-0 py-3 first:pt-0 last:pb-0">
                      <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Show when={result.title}><strong class="min-w-0 break-words text-base-medium text-ink-gray-9">{result.title}</strong></Show>
                        <StatusBadge kind="knowledge" status={result.status} />
                        <Show when={result.sourceType}><Badge size="sm" variant="outline" theme="gray" label={result.sourceType === "document" ? "Saved document" : result.sourceType === "knowledge" ? "Approved knowledge" : result.sourceType!} /></Show>
                        <Show when={result.selfReviewed}><Badge size="sm" variant="outline" theme="amber" label={t("tools.self-reviewed.85cc")} /></Show>
                        <Badge size="sm" variant="outline" theme="blue" label={result.classification} />
                        <Badge size="sm" variant="outline" theme={result.scope.visibility === "team" || result.scope.visibility === "private" ? "blue" : "gray"} label={scopeLabel(result.scope)} />
                      </div>
                      <Show when={result.stale}>{(stale) => <p class="mt-2 break-words rounded-control border border-outline-amber-2 bg-surface-amber-1 p-2 text-caption text-ink-gray-8" data-testid="result-stale">{t("library.stale.detail", { when: formatRelative(stale().since), what: stale().changes.map(changeText).join("; ") })}</p>}</Show>
                      <p class="brain-prose mt-2 whitespace-pre-wrap break-words text-interface text-ink-gray-8">{result.content}</p>
                      <div class="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-gray-6">
                        <span class="min-w-0 break-all">{t("tools.source.6da1")} <code class="text-ink-gray-7">{result.sourceId}</code> · v{result.sourceVersion}</span>
                        <span>{t("tools.updated.f2f8")} <DateText value={result.updatedAt} /></span>
                        <span>{result.provenance.length} provenance references</span>
                      </div>
                      <Show when={result.provenance.length}>
                        <details class="mt-2 min-w-0">
                          <summary class="cursor-pointer text-caption font-medium text-ink-gray-6">{t("tools.provenance-references.8e9f")}</summary>
                          <ul class="mt-1 flex min-w-0 flex-col gap-1"><For each={result.provenance}>{(reference) => <li><code class="break-all text-caption text-ink-gray-7">{reference}</code></li>}</For></ul>
                        </details>
                      </Show>
                      <Show when={props.canPublish}>
                        <div class="mt-3 flex flex-wrap gap-2 border-t border-outline-gray-1 pt-2">
                          <Button size="sm" variant="outline" iconLeft="lucide-upload" disabled={!canMutate()} onClick={() => openPublish(result.sourceId)}>
                            Review publication…
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            theme="red"
                            iconLeft="lucide-trash-2"
                            disabled={!canMutate()}
                            onClick={() => setRevokeFor(result.sourceId)}
                          >
                            Revoke
                          </Button>
                        </div>
                      </Show>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </ScreenRegion>
        </WorkspaceSection>
        <WorkspaceSection
          title={t("tools.trusted-capabilities.9ce7")}
          description={t("tools.knowledge-instructions-and-execu.0ec0")}
          actions={
            <A
              href={`/w/${props.workspaceId}/knowledge?tab=tools`}
              class="inline-flex min-h-8 items-center gap-1.5 rounded-control border border-outline-gray-2 px-2.5 text-caption font-medium text-ink-blue-link hover:bg-surface-gray-1 focus-visible:focus-ring"
            >
              Open tool registry<span class="lucide-arrow-up-right size-3.5" aria-hidden="true" />
            </A>
          }
        >
          <div class="brain-queue">
            <For each={props.tools.slice(0, 4)}>
              {(tool) => (
                <QueueRow
                  title={tool.id}
                  description={`${tool.effectClass} effect · version ${digestTag(tool.release.digest)}`}
                  icon={tool.effectClass === "read" ? "lucide-scan-search" : "lucide-wrench"}
                  tone={tool.effectClass === "read" ? "blue" : "amber"}
                  label={`Open ${tool.id} in the tool registry`}
                  trailing={<StatusBadge status={tool.status} />}
                  onClick={() => void navigate(`/w/${props.workspaceId}/knowledge?tab=tools`)}
                />
              )}
            </For>
          </div>
        </WorkspaceSection>
        <Dialog.Root
          open={Boolean(publishing())}
          onOpenChange={(open) => {
            if (!open) setPublishOpenFor(undefined);
          }}
        >
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{t("tools.review-knowledge-publication.0603")}</Dialog.Title>
              <Dialog.Description>
                Bind a real content artifact, independent reviewer, evidence, and a release-declared redaction profile. This is not tool publication.
              </Dialog.Description>
            </Dialog.Header>
            <Show when={publishing()} keyed>
              {(result) => (
                <div class="my-3 flex min-w-0 max-h-[55dvh] flex-col gap-3 overflow-y-auto pe-1">
                  <Alert
                    theme="blue"
                    variant="outline"
                    title={t("tools.reviewed-publication.8e06")}
                    description={<span class="break-words">{t("tools.candidate.d769")} <code class="break-all">{result.sourceId}</code> · target scope {scopeLabel(result.scope)}</span>}
                  />
                  <ArtifactSelector
                    label={t("tools.content-artifact.f22b")}
                    maxBytes={262144}
                    onSelect={(artifact) => {
                      setContentArtifactId(artifact.artifactId);
                      setContentDigest(artifact.digest);
                      setContentBytes(String(artifact.bytes));
                    }}
                  />
                  <Select
                    label={t("tools.reviewer.a74f")}
                    value={reviewerId()}
                    options={(members.state().data ?? [])
                      .filter((member) => !member.revoked && member.principalId !== app.identity()?.actor.actorId)
                      .map((member) => ({ value: member.principalId, label: member.principalId }))}
                    onValueChange={(id) => setReviewerId(id ?? "")}
                  />
                  <Select
                    label={t("tools.redaction-policy.3a98")}
                    value={profileId()}
                    options={(profiles.state().data ?? []).map((profile) => ({ value: profile.id, label: profile.id }))}
                    onValueChange={(id) => {
                      const profile = profiles.state().data?.find((entry) => entry.id === id);
                      setProfileId(profile?.id ?? "");
                      setProfileDigest(profile?.digest ?? "");
                    }}
                  />
                  <EvidenceSelector onSelect={(digests) => setEvidenceText(digests.join(" "))} />
                </div>
              )}
            </Show>
            <Dialog.Footer class="flex-wrap justify-end gap-2 border-t border-outline-gray-1 pt-3">
              <Button size="sm" variant="outline" onClick={() => setPublishOpenFor(undefined)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="solid"
                theme="blue"
                disabled={!publishReady()}
                onClick={() => {
                  const result = publishing();
                  if (!result) return;
                  void props.onPublish({
                    candidateId: result.sourceId,
                    sourceWorkspaceId: props.workspaceId,
                    targetScope: result.scope,
                    content: {
                      artifactId: contentArtifactId().trim() || contentDigest().trim().slice(0, 12),
                      digest: contentDigest().trim(),
                      bytes: Number(contentBytes()),
                      mediaType: "text/plain",
                      classification: result.classification,
                    },
                    evidenceDigests: evidenceDigests(),
                    reviewerId: reviewerId().trim(),
                    redactionProfile: { id: profileId().trim(), digest: profileDigest().trim() },
                  });
                  setPublishOpenFor(undefined);
                }}
              >
                Publish for review
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Root>
        <ReasonDialog
          open={Boolean(revokeFor())}
          onClose={() => {
            setRevokeFor(undefined);
            setRevokeReason("");
          }}
          title={t("tools.revoke-knowledge.8e71")}
          description={t("tools.revocation-is-an-explicit-scoped.eae9")}
          reason={revokeReason()}
          onReason={setRevokeReason}
          reasonLabel="Revocation reason"
          multiline={false}
          confirmLabel={t("tools.revoke-knowledge.8e71")}
          tone="red"
          onConfirm={(value) => {
            const sourceId = revokeFor();
            if (sourceId) void props.onRevoke(sourceId, value);
            setRevokeFor(undefined);
            setRevokeReason("");
          }}
        />
      </PageStack>
    </BrainPage>
  );
}

export interface ToolProposalInput {
  package: { artifactId: string; digest: string; bytes: number; mediaType: string; classification: Classification };
  evidence: string[];
}

/** The list row's one honest sentence about a tool: availability first (an unavailable tool is not offered), then use as a failure rate. */
function usageSummary(tool: ToolCatalogEntry): string {
  const base = tool.usage.calls === 0 ? "Never used" : `${callsText(tool)}${tool.usage.lastCallAt ? `, last used ${formatDateTime(tool.usage.lastCallAt)}` : ""}`;
  return tool.availability.available ? base : `${availabilityText(tool)} · ${base}`;
}
function availabilityText(tool: ToolCatalogEntry): string {
  return tool.availability.available ? "Available" : `Not available${tool.availability.reason ? `: ${tool.availability.reason}` : ""}`;
}
function countsText(calls: number, failures: number): string {
  const noun = calls === 1 ? "call" : "calls";
  return failures === 0 ? `${calls} ${noun}, none failed` : `${calls} ${noun}, ${failures} failed (${Math.round((failures / calls) * 100)}%)`;
}
/** "66 calls, 50 failed (76%)" over the last 7 days, so a tool fixed last week does not keep reading as broken; "Never used" when it never ran. */
function callsText(tool: ToolCatalogEntry): string {
  const { calls, recent } = tool.usage;
  if (calls === 0) return "Never used";
  if (recent.calls === 0) return "no calls in the last 7 days";
  return countsText(recent.calls, recent.failures);
}
/** The all-time counts, kept as secondary text: "lifetime: 23 calls, 21 failed". */
function lifetimeText(tool: ToolCatalogEntry): string | undefined {
  const { calls, failures } = tool.usage;
  if (calls === 0) return undefined;
  return `lifetime: ${calls} ${calls === 1 ? "call" : "calls"}, ${failures === 0 ? "none failed" : `${failures} failed`}`;
}

export function ToolsScreen(props: {
  tools: ToolCatalogEntry[];
  candidates: ToolCandidateView[];
  state: ScreenState<ToolCatalogEntry[]>;
  onRefresh: () => void;
  canPublish: boolean;
  onPropose: (proposal: ToolProposalInput) => Promise<void>;
  onPublish: (release: { id: string; digest: string }, evidence: string[]) => Promise<void>;
}): JSX.Element {
  const desktop = mediaQuery("(min-width: 1024px)");
  const app = useApp();
  const navigate = useNavigate();
  const [editError, setEditError] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  /** Opens the Studio on an editable candidate of this tool: its definition, script and schemas. Nothing changes until a candidate is published and activated. */
  const editTool = async (id: string): Promise<void> => {
    setEditing(true); setEditError("");
    try { await authorCandidate(app, navigate, "Tool", id, `Edit ${id}`, "edit"); }
    catch (cause) { setEditError(cause instanceof Error ? cause.message : "The tool could not be opened for editing"); }
    finally { setEditing(false); }
  };
  const [selectedId, setSelectedId] = createSignal("");
  const [proposeOpen, setProposeOpen] = createSignal(false);
  const [publishOpen, setPublishOpen] = createSignal(false);
  const [packageArtifactId, setPackageArtifactId] = createSignal("");
  const [packageDigest, setPackageDigest] = createSignal("");
  const [packageBytes, setPackageBytes] = createSignal("");
  const [packageClassification, setPackageClassification] = createSignal<Classification>("internal");
  const [proposeEvidence, setProposeEvidence] = createSignal("");
  const [releaseId, setReleaseId] = createSignal("");
  const [releaseDigest, setReleaseDigest] = createSignal("");
  const [publishEvidence, setPublishEvidence] = createSignal("");
  const digests = (text: string) =>
    text
      .split(/[\s,]+/u)
      .map((digest) => digest.trim())
      .filter(Boolean);
  const current = () => props.tools.find((tool) => tool.id === selectedId()) ?? (desktop() ? props.tools[0] : undefined);
  const [toolPage, setToolPage] = createSignal(1);
  const toolPageSafe = () => Math.min(toolPage(), Math.max(1, Math.ceil(props.tools.length / PAGE_SIZE)));
  const pagedTools = () => props.tools.slice((toolPageSafe() - 1) * PAGE_SIZE, toolPageSafe() * PAGE_SIZE);
  return (
    <BrainPage
      title={t("tools.trusted-capability-registry.5ef4")}
      description={t("tools.inspect-what-each-tool-can-do-it.f5d9")}
      actions={<Show when={props.canPublish}>
            <Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setProposeOpen(true)}>
              Propose tool
            </Button>
          </Show>}
    >
      <PageStack>
        <StatGrid compact
          stats={[
            {
              label: t("tools.trusted.99f7"),
              value: String(props.tools.filter((tool) => tool.status === "trusted").length),
              hint: t("tools.currently-trusted-definitions.f838"),
              icon: "lucide-shield-check",
            },
            {
              label: t("tools.review-candidates.438b"),
              value: String(props.tools.filter((tool) => tool.status === "candidate" || tool.status === "reviewing").length),
              hint: t("tools.not-automatically-live-authority.2da4"),
              icon: "lucide-scan-search",
            },
            {
              label: t("tools.write-privileged.fbb3"),
              value: String(props.tools.filter((tool) => tool.effectClass !== "read").length),
              hint: t("tools.effect-permit-required-at-execut.3c33"),
              icon: "lucide-shield-alert",
            },
          ]}
        />
        <div class="grid min-w-0 gap-4 sm:grid-cols-2">
          <MixBar label={t("tools.trust-status.55e4")} empty="No tools declared yet." segments={[
            { label: t("tools.trusted.99f7"), count: props.tools.filter((tool) => tool.status === "trusted").length, tone: "green" },
            { label: t("tools.candidate.d769"), count: props.tools.filter((tool) => tool.status === "candidate").length, tone: "gray" },
            { label: t("tools.reviewing.166e"), count: props.tools.filter((tool) => tool.status === "reviewing").length, tone: "amber" },
            { label: t("tools.revoked.85f1"), count: props.tools.filter((tool) => tool.status === "revoked").length, tone: "red" },
          ]} />
          <MixBar label={t("tools.effect-class.afbf")} empty="No tools declared yet." segments={[
            { label: t("tools.read.852b"), count: props.tools.filter((tool) => tool.effectClass === "read").length, tone: "blue" },
            { label: t("tools.write.4a48"), count: props.tools.filter((tool) => tool.effectClass === "write").length, tone: "amber" },
            { label: t("tools.privileged.d6ed"), count: props.tools.filter((tool) => tool.effectClass === "privileged").length, tone: "red" },
          ]} />
        </div>
        <ScreenRegion
          state={props.state}
          skeleton="rows"
          emptyTitle={t("tools.no-tools-declared.2018")}
          emptyDescription={t("tools.tools-appear-here-once-a-release.ab98")}
          emptyAction={
            props.canPublish ? (
              <Button onClick={() => setProposeOpen(true)}>
                Propose tool
              </Button>
            ) : undefined
          }
          onRetry={props.onRefresh}
        >
          <PaneLayout
            class="brain-list-detail"
            startSize={40}
            minStartSize={30}
            maxStartSize={58}
            active={current() ? "end" : "start"}
            start={
              <WorkspaceSection title={t("tools.capability-registry.9ce3")} description={t("tools.select-a-tool-to-inspect-its-con.5149")}>
                <div class="brain-queue">
                  <For each={pagedTools()}>
                    {(tool) => (
                      <QueueRow
                        title={tool.id}
                        description={`${tool.effectClass} effect · ${usageSummary(tool)}`}
                        icon={tool.effectClass === "read" ? "lucide-scan-search" : "lucide-wrench"}
                        tone={tool.effectClass === "read" ? "blue" : "amber"}
                        meta={<span title={tool.release.digest}>Version {digestTag(tool.release.digest)}</span>}
                        trailing={<StatusBadge status={tool.status} />}
                        selected={current()?.id === tool.id}
                        onClick={() => setSelectedId(tool.id)}
                      />
                    )}
                  </For>
                </div>
                <Pager count={props.tools.length} page={toolPageSafe()} onPage={setToolPage} label={t("tools.capability-registry-pages.d9d5")} />
              </WorkspaceSection>
            }
            end={
              <Show
                when={current()}
                keyed
                fallback={
                  <EmptyState size="sm"
                    icon="lucide-wrench"
                    title={t("tools.select-a-tool.45e0")}
                    description={t("tools.its-effect-typed-schemas-target.58d3")}
                  />
                }
              >
                {(tool) => (
                  <PageStack>
                    <Button variant="ghost" iconLeft="lucide-arrow-left" class="self-start lg:hidden" onClick={() => setSelectedId("")}>
                      Back to registry
                    </Button>
                    <div>
                      <StatusBadge status={tool.status} />
                      <h2 class="mt-3 text-section">{tool.id}</h2>
                      <p class="mt-2 text-interface text-ink-gray-7" data-tool-description>
                        {tool.description ?? "This tool's definition carries no description."}
                      </p>
                    </div>
                    <dl class="grid gap-4 border-y border-outline-gray-1 py-4 sm:grid-cols-2">
                      <KeyValue
                        label={t("tools.effect-class.afbf")}
                        value={<Badge variant="outline" theme={tool.effectClass === "read" ? "blue" : "amber"} label={tool.effectClass} />}
                        orientation="vertical"
                      />
                      <KeyValue label={t("tools.publication.e004")} value={tool.status} orientation="vertical" />
                      <KeyValue label={t("tools.agents-allowed-to-call-it.5f9b")} value={<span data-tool-agents>{tool.allowedAgents.length ? tool.allowedAgents.join(", ") : "No agent has this tool in its allowlist"}</span>} orientation="vertical" />
                      <KeyValue label={t("tools.active-since.7d5b")} value={<DateText value={tool.createdAt} />} orientation="vertical" />
                      <KeyValue label={t("tools.availability.681b")} value={<span data-tool-availability>{availabilityText(tool)}</span>} orientation="vertical" />
                      <KeyValue label={t("tools.calls-last-7-days.9fed")} value={<span><span data-tool-calls>{callsText(tool)}</span><Show when={lifetimeText(tool)}>{(text) => <span class="block text-ink-gray-6" data-tool-lifetime>{text()}</span>}</Show></span>} orientation="vertical" />
                      <KeyValue label={t("tools.last-call.8254")} value={<Show when={tool.usage.lastCallAt} fallback={<span>{t("tools.never-used.984e")}</span>}><span class="flex flex-wrap items-center gap-2"><DateText value={tool.usage.lastCallAt} /><Show when={tool.usage.lastCallRunId}>{(runId) => <A class="text-ink-blue-7 underline focus-visible:focus-ring" href={`/runs/${runId()}`}>{t("tools.open-the-run.400d")}</A>}</Show></span></Show>} orientation="vertical" />
                      <KeyValue label={t("tools.last-failure.d11a")} value={<Show when={tool.usage.lastFailureAt} fallback={<span>{tool.usage.calls ? "none recorded" : t("tools.never-used.984e")}</span>}><span class="flex flex-wrap items-center gap-2"><DateText value={tool.usage.lastFailureAt} /><Show when={tool.usage.lastFailureRunId}>{(runId) => <A class="text-ink-blue-7 underline focus-visible:focus-ring" href={`/runs/${runId()}`}>{t("tools.open-the-run.400d")}</A>}</Show></span></Show>} orientation="vertical" />
                      <Show when={tool.usage.lastFailureMessage}><KeyValue label={t("tools.last-error.5e4d")} value={<span data-tool-last-error>{tool.usage.lastFailureMessage}</span>} orientation="vertical" /></Show>
                      <Show when={tool.allowedHosts?.length}><KeyValue label={t("tools.hosts-it-may-reach.8b07")} value={<span data-tool-hosts>{tool.allowedHosts!.join(", ")}</span>} orientation="vertical" /></Show>
                      <KeyValue label={t("tools.input-schema.7cb0")} value={tool.inputSchemaRef} orientation="vertical" />
                      <KeyValue label={t("tools.output-schema.c572")} value={tool.outputSchemaRef} orientation="vertical" />
                    </dl>
                    <Alert
                      theme={tool.effectClass === "read" ? "blue" : "amber"}
                      variant="outline"
                      title={tool.effectClass === "read" ? t("tools.read-capability.7c87") : t("tools.governed-effect-capability.913f")}
                      description={
                        tool.effectClass === "read"
                          ? "The declared effect class is read-only. Actual runner permission still depends on current placement and policy."
                          : "Execution requires the exact permit and current authorization. A trusted definition is not blanket permission to run anywhere."
                      }
                    />
                    <WorkspaceSection title={t("tools.test-and-evidence.4bff")} description={t("tools.actual-artifacts-attached-to-thi.0262")}>
                      <Show
                        when={tool.evidence.length}
                        fallback={
                          <p class="text-interface text-ink-gray-7">
                            No evidence artifacts are attached. Do not infer test success from publication status alone.
                          </p>
                        }
                      >
                        <div class="flex flex-col gap-3">
                          <For each={tool.evidence}>{(artifact) => <ArtifactView artifact={artifact} compact />}</For>
                        </div>
                      </Show>
                    </WorkspaceSection>
                    <Show when={props.canPublish}>
                      <div class="flex flex-wrap items-center gap-3" data-tool-edit>
                        <Button variant="outline" iconLeft="lucide-pencil" disabled={editing()} onClick={() => void editTool(tool.id)}>{t("tools.edit-this-tool.f166")}</Button>
                        <span class="text-caption text-ink-gray-6">{t("tools.opens-an-editable-copy-of-its-de.42fe")}</span>
                      </div>
                      <Show when={editError()}><Alert theme="red" variant="outline" title={t("tools.could-not-open-the-tool-for-edit.b84f")} description={editError()} /></Show>
                    </Show>
                    <Show when={props.canPublish}>
                      <WorkspaceSection title={t("tools.try-this-tool.30a8")} description={t("tools.run-it-with-an-input-you-type-an.db29")}>
                        <ToolTryPanel toolId={tool.id} effectClass={tool.effectClass} />
                      </WorkspaceSection>
                    </Show>
                    <WorkspaceSection title={t("tools.recent-calls-and-why-they-failed.1767")} description={t("tools.the-latest-calls-of-this-tool-in.078c")}>
                      <ToolCallsPanel toolId={tool.id} />
                    </WorkspaceSection>
                    <TechnicalDetails label={t("tools.manifest-and-release.7333")}>
                      <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words text-caption">{JSON.stringify(tool, null, 2)}</pre>
                    </TechnicalDetails>
                  </PageStack>
                )}
              </Show>
            }
          />
        </ScreenRegion>
        <Show when={props.canPublish}>
          <WorkspaceSection
            title={t("tools.governed-publication.cf50")}
            description={t("tools.proposal-and-publication-are-sep.0279")}
            actions={
              <Button variant="outline" iconLeft="lucide-upload" onClick={() => setPublishOpen(true)}>
                Publish reviewed release
              </Button>
            }
          />
        </Show>
        <Dialog.Root open={proposeOpen()} onOpenChange={setProposeOpen}>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{t("tools.propose-a-tool-package.7477")}</Dialog.Title>
              <Dialog.Description>A proposal is a pinned package artifact plus evidence; review happens before any publish.</Dialog.Description>
            </Dialog.Header>
            <div class="my-4 flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pe-1">
              <ArtifactSelector
                label={t("tools.tool-package.1fb9")}
                onSelect={(artifact) => {
                  setPackageArtifactId(artifact.artifactId);
                  setPackageDigest(artifact.digest);
                  setPackageBytes(String(artifact.bytes));
                  setPackageClassification(artifact.classification);
                }}
              />
              <EvidenceSelector onSelect={(selected) => setProposeEvidence(selected.join(" "))} />
            </div>
            <Dialog.Footer class="justify-end">
              <Button variant="outline" onClick={() => setProposeOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="solid"
                theme="blue"
                disabled={!packageDigest().trim() || Number(packageBytes()) <= 0 || digests(proposeEvidence()).length === 0}
                onClick={() => {
                  void props.onPropose({
                    package: {
                      artifactId: packageArtifactId(),
                      digest: packageDigest().trim(),
                      bytes: Number(packageBytes()),
                      mediaType: "application/octet-stream",
                      classification: packageClassification(),
                    },
                    evidence: digests(proposeEvidence()),
                  });
                  setProposeOpen(false);
                }}
              >
                Submit proposal
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Root>
        <Dialog.Root open={publishOpen()} onOpenChange={setPublishOpen}>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{t("tools.publish-reviewed-tool-release.912f")}</Dialog.Title>
              <Dialog.Description>{t("tools.choose-the-exact-candidate-and-b.a6ca")}</Dialog.Description>
            </Dialog.Header>
            <div class="my-4 flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pe-1">
              <Show when={!props.candidates.length}>
                <Alert
                  theme="amber"
                  variant="outline"
                  title={t("tools.no-review-candidates-yet.cd0a")}
                  description={t("tools.proposals-that-pass-the-rule-of.de80")}
                />
              </Show>
              <Select
                label={t("tools.reviewed-tool-candidate.b222")}
                value={releaseId()}
                options={props.candidates.map((candidate) => ({ value: candidate.release.id, label: `${candidate.release.id} · ${candidate.state}` }))}
                onValueChange={(id) => {
                  const candidate = props.candidates.find((entry) => entry.release.id === id);
                  setReleaseId(candidate?.release.id ?? "");
                  setReleaseDigest(candidate?.release.digest ?? "");
                }}
              />
              <EvidenceSelector onSelect={(selected) => setPublishEvidence(selected.join(" "))} />
            </div>
            <Dialog.Footer class="justify-end">
              <Button variant="outline" onClick={() => setPublishOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="solid"
                theme="blue"
                disabled={!releaseId().trim() || !releaseDigest().trim() || digests(publishEvidence()).length === 0}
                onClick={() => {
                  void props.onPublish({ id: releaseId().trim(), digest: releaseDigest().trim() }, digests(publishEvidence()));
                  setPublishOpen(false);
                }}
              >
                Publish release
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Root>
      </PageStack>
    </BrainPage>
  );
}
