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
import { shortDigest } from "../ui/format";
import { BrainPage, PageStack, TechnicalDetails } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { ReasonDialog } from "../ui/components/ReasonDialog";
import { ArtifactView } from "../ui/outputs/ArtifactView";
import { LIST_PAGE_SIZE as PAGE_SIZE, Pager } from "../ui/components/primitives";import { QueueRow, WorkspaceSection } from "../ui/components/Domain";
import { StatGrid } from "@talelk/newui-organisms";
import { MixBar } from "../ui/viz/MixBar";
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
  if (scope.visibility === "team") return `Team ${scope.teamId}`;
  if (scope.visibility === "private") return `Private · ${scope.ownerId}`;
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
      title="Knowledge"
      description="Find scoped knowledge with provenance and trust visible; review and publication remain separate governed journeys."
    >
      <PageStack>
        <WorkspaceSection
          title="Find knowledge"
          description="Search only the current workspace and review states authorized to your account. Results cannot change agent policy or execute tools."
        >
          <form
            class="grid min-w-0 items-end gap-2 md:grid-cols-[minmax(0,1fr)_12rem_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (text().trim()) props.onSearch(text().trim());
            }}
          >
            <TextInput
              label="Search scoped knowledge"
              value={text()}
              placeholder="Find a fact, decision, or operational detail…"
              onInput={(event) => setText(event.currentTarget.value)}
            />
            <Select
              label="Result scope"
              value={scopeFilter()}
              options={[
                { value: "all", label: "All returned scopes" },
                { value: "workspace", label: "Workspace" },
                { value: "private", label: "Private" },
                { value: "team", label: "Team" },
                { value: "global-approved", label: "Approved organization-wide" },
              ]}
              onValueChange={(value) => setScopeFilter(value ?? "all")}
            />
            <Button size="sm" class="w-full md:w-auto" type="submit" variant="solid" theme="blue" iconLeft="lucide-search" disabled={!text().trim()}>
              Search
            </Button>
          </form>
          <Show when={props.searched && !props.state.data?.degraded && props.state.data?.storeLabel}>
            <p class="mt-1 mb-2 text-caption text-ink-gray-7" data-testid="memory-store-label"><span class="lucide-hard-drive mr-1 inline-block size-3.5 align-text-bottom" aria-hidden="true" />{props.state.data?.storeLabel}: saved documents and approved knowledge, ranked by how well they match.</p>
          </Show>
          <Show when={props.state.data?.degraded}>
            <Alert
              theme="amber"
              variant="outline"
              title="Knowledge service is degraded"
              description="Results come from the local scoped store. Publish and revoke actions are unavailable until the knowledge service is healthy."
            />
          </Show>
          <ScreenRegion
            state={props.state}
            skeleton="rows"
            emptyTitle={props.searched ? "No knowledge matches" : "Search your scoped knowledge"}
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
                <EmptyState size="sm" icon="lucide-filter" title="No results in this scope" description="Choose another returned scope or run a broader search." />
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
                        <Show when={result.selfReviewed}><Badge size="sm" variant="outline" theme="amber" label="Self-reviewed" /></Show>
                        <Badge size="sm" variant="outline" theme="blue" label={result.classification} />
                        <Badge size="sm" variant="outline" theme="gray" label={scopeLabel(result.scope)} />
                      </div>
                      <p class="brain-prose mt-2 whitespace-pre-wrap break-words text-interface text-ink-gray-8">{result.content}</p>
                      <div class="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-gray-6">
                        <span class="min-w-0 break-all">Source <code class="text-ink-gray-7">{result.sourceId}</code> · v{result.sourceVersion}</span>
                        <span>Updated <DateText value={result.updatedAt} /></span>
                        <span>{result.provenance.length} provenance references</span>
                      </div>
                      <Show when={result.provenance.length}>
                        <details class="mt-2 min-w-0">
                          <summary class="cursor-pointer text-caption font-medium text-ink-gray-6">Provenance references</summary>
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
          title="Trusted capabilities"
          description="Knowledge instructions and executable tools are different authorities. Inspect tool trust, effect class and evidence in the registry."
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
                  description={`${tool.effectClass} effect · release ${shortDigest(tool.release.digest)}`}
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
              <Dialog.Title>Review knowledge publication</Dialog.Title>
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
                    title="Reviewed publication"
                    description={<span class="break-words">Candidate <code class="break-all">{result.sourceId}</code> · target scope {scopeLabel(result.scope)}</span>}
                  />
                  <ArtifactSelector
                    label="Content artifact"
                    maxBytes={262144}
                    onSelect={(artifact) => {
                      setContentArtifactId(artifact.artifactId);
                      setContentDigest(artifact.digest);
                      setContentBytes(String(artifact.bytes));
                    }}
                  />
                  <Select
                    label="Reviewer"
                    value={reviewerId()}
                    options={(members.state().data ?? [])
                      .filter((member) => !member.revoked && member.principalId !== app.identity()?.actor.actorId)
                      .map((member) => ({ value: member.principalId, label: member.principalId }))}
                    onValueChange={(id) => setReviewerId(id ?? "")}
                  />
                  <Select
                    label="Redaction policy"
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
          title="Revoke knowledge"
          description="Revocation is an explicit scoped command and requires a named reason."
          reason={revokeReason()}
          onReason={setRevokeReason}
          reasonLabel="Revocation reason"
          multiline={false}
          confirmLabel="Revoke knowledge"
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
      title="Trusted capability registry"
      description="Inspect what each tool can do, its effect class, typed contracts and proof before proposal or publication."
      actions={
        <>
          <Button variant="outline" iconLeft="lucide-refresh-cw" onClick={props.onRefresh}>Refresh</Button>
          <Show when={props.canPublish}>
            <Button variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setProposeOpen(true)}>
              Propose tool
            </Button>
          </Show>
        </>
      }
    >
      <PageStack>
        <StatGrid compact
          stats={[
            {
              label: "Trusted",
              value: String(props.tools.filter((tool) => tool.status === "trusted").length),
              hint: "Currently trusted definitions",
              icon: "lucide-shield-check",
            },
            {
              label: "Review candidates",
              value: String(props.tools.filter((tool) => tool.status === "candidate" || tool.status === "reviewing").length),
              hint: "Not automatically live authority",
              icon: "lucide-scan-search",
            },
            {
              label: "Write / privileged",
              value: String(props.tools.filter((tool) => tool.effectClass !== "read").length),
              hint: "Effect permit required at execution",
              icon: "lucide-shield-alert",
            },
          ]}
        />
        <div class="grid min-w-0 gap-4 sm:grid-cols-2">
          <MixBar label="Trust status" empty="No tools declared yet." segments={[
            { label: "Trusted", count: props.tools.filter((tool) => tool.status === "trusted").length, tone: "green" },
            { label: "Candidate", count: props.tools.filter((tool) => tool.status === "candidate").length, tone: "gray" },
            { label: "Reviewing", count: props.tools.filter((tool) => tool.status === "reviewing").length, tone: "amber" },
            { label: "Revoked", count: props.tools.filter((tool) => tool.status === "revoked").length, tone: "red" },
          ]} />
          <MixBar label="Effect class" empty="No tools declared yet." segments={[
            { label: "Read", count: props.tools.filter((tool) => tool.effectClass === "read").length, tone: "blue" },
            { label: "Write", count: props.tools.filter((tool) => tool.effectClass === "write").length, tone: "amber" },
            { label: "Privileged", count: props.tools.filter((tool) => tool.effectClass === "privileged").length, tone: "red" },
          ]} />
        </div>
        <ScreenRegion
          state={props.state}
          skeleton="rows"
          emptyTitle="No tools declared"
          emptyDescription="Tools appear here once a release declares them or a proposal is accepted."
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
              <WorkspaceSection title="Capability registry" description="Select a tool to inspect its contracts and evidence.">
                <div class="brain-queue">
                  <For each={pagedTools()}>
                    {(tool) => (
                      <QueueRow
                        title={tool.id}
                        description={`${tool.effectClass} effect · ${tool.evidence.length} evidence artifacts`}
                        icon={tool.effectClass === "read" ? "lucide-scan-search" : "lucide-wrench"}
                        tone={tool.effectClass === "read" ? "blue" : "amber"}
                        meta={<span>Release {shortDigest(tool.release.digest)}</span>}
                        trailing={<StatusBadge status={tool.status} />}
                        selected={current()?.id === tool.id}
                        onClick={() => setSelectedId(tool.id)}
                      />
                    )}
                  </For>
                </div>
                <Pager count={props.tools.length} page={toolPageSafe()} onPage={setToolPage} label="Capability registry pages" />
              </WorkspaceSection>
            }
            end={
              <Show
                when={current()}
                keyed
                fallback={
                  <EmptyState size="sm"
                    icon="lucide-wrench"
                    title="Select a tool"
                    description="Its effect, typed schemas, target-independent risk and test evidence will appear here."
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
                      <p class="mt-2 text-interface text-ink-gray-7">
                        This read model does not expose a TOOL.md summary or supported runner targets. Those facts are not inferred; exact contracts and
                        evidence are below.
                      </p>
                    </div>
                    <dl class="grid gap-4 border-y border-outline-gray-1 py-4 sm:grid-cols-2">
                      <KeyValue
                        label="Effect class"
                        value={<Badge variant="outline" theme={tool.effectClass === "read" ? "blue" : "amber"} label={tool.effectClass} />}
                        orientation="vertical"
                      />
                      <KeyValue label="Publication" value={tool.status} orientation="vertical" />
                      <KeyValue label="Input schema" value={tool.inputSchemaRef} orientation="vertical" />
                      <KeyValue label="Output schema" value={tool.outputSchemaRef} orientation="vertical" />
                    </dl>
                    <Alert
                      theme={tool.effectClass === "read" ? "blue" : "amber"}
                      variant="outline"
                      title={tool.effectClass === "read" ? "Read capability" : "Governed effect capability"}
                      description={
                        tool.effectClass === "read"
                          ? "The declared effect class is read-only. Actual runner permission still depends on current placement and policy."
                          : "Execution requires the exact permit and current authorization. A trusted definition is not blanket permission to run anywhere."
                      }
                    />
                    <WorkspaceSection title="Test and evidence" description="Actual artifacts attached to this registry entry.">
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
                    <TechnicalDetails label="Manifest and release">
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
            title="Governed publication"
            description="Proposal and publication are separate. Rule of Three creates a review candidate, not a trusted live tool automatically."
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
              <Dialog.Title>Propose a tool package</Dialog.Title>
              <Dialog.Description>A proposal is a pinned package artifact plus evidence; review happens before any publish.</Dialog.Description>
            </Dialog.Header>
            <div class="my-4 flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pe-1">
              <ArtifactSelector
                label="Tool package"
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
              <Dialog.Title>Publish reviewed tool release</Dialog.Title>
              <Dialog.Description>Choose the exact candidate and bind the independent evidence required by the Rule of Three.</Dialog.Description>
            </Dialog.Header>
            <div class="my-4 flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pe-1">
              <Show when={!props.candidates.length}>
                <Alert
                  theme="amber"
                  variant="outline"
                  title="No review candidates yet"
                  description="Proposals that pass the Rule of Three become review candidates; there is nothing to publish yet."
                />
              </Show>
              <Select
                label="Reviewed tool candidate"
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
