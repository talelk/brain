import { ArtifactSelector, EvidenceSelector } from "../ui/components/ArtifactSelectors";
import { useApp } from "../ui/app-context";
import { createScopedRead } from "../data/screens";
import { configExplainQuery } from "../data/governor";
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Dialog, Select } from "@talelk/newui-molecules";
import { DataTable, Section } from "@talelk/newui-organisms";
import type { Classification, MemoryResult, MemoryScope, ToolCatalogEntry, ToolCandidateView } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { count, shortDigest } from "../ui/format";
import { BrainPage, PageStack } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { ReasonDialog } from "../ui/components/ReasonDialog";
import { CardTile, RefreshButton } from "../ui/components/primitives";

export interface MemoryPublicationInput {
  candidateId: string;
  sourceWorkspaceId: string;
  targetScope: MemoryScope;
  content: { artifactId: string; digest: string; bytes: number; mediaType: string; classification: Classification };
  evidenceDigests: string[];
  reviewerId: string;
  redactionProfile: { id: string; digest: string };
}

export function KnowledgeScreen(props: {
  workspaceId: string;
  tools: ToolCatalogEntry[];
  state: ScreenState<{ results: MemoryResult[]; degraded: boolean; tools: ToolCatalogEntry[] }>;
  searched: boolean;
  onRefresh: () => void;
  onSearch: (text: string) => void;
  onPublish: (publication: MemoryPublicationInput) => Promise<void>;
  onRevoke: (sourceId: string, reason: string) => Promise<void>;
  canPublish: boolean;
}): JSX.Element {
  const app = useApp(); const members = app.useMembers();
  const profiles = createScopedRead<{ id: string; digest: string }[]>({ scope: app.scope, load: async (scope, signal) => {
    const loaded = await configExplainQuery(scope.workspaceId, "/manifest/documents", signal);
    const documents = loaded.snapshot.effective;
    return { ...loaded, snapshot: Array.isArray(documents) ? (documents as { kind: string; id: string; digest: string }[]).filter((document) => document.kind === "Policy") : [] };
  } });
  const [text, setText] = createSignal("");
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
  const results = () => props.state.data?.results ?? [];
  const publishing = () => results().find((result) => result.sourceId === publishOpenFor());
  const evidenceDigests = () => evidenceText().split(/[\s,]+/u).map((digest) => digest.trim()).filter(Boolean);
  const publishReady = () => contentDigest().trim().length > 0 && Number(contentBytes()) > 0 && reviewerId().trim().length > 0 && profileId().trim().length > 0 && profileDigest().trim().length > 0 && evidenceDigests().length > 0 && publishOpenFor() !== undefined;
  const canMutate = () => props.canPublish && !props.state.data?.degraded;

  return <BrainPage title="Knowledge" description="Search scoped facts and publish reviewed knowledge with explicit evidence and provenance.">
    <PageStack>
      <Section title="Scoped memory search" description="Search only the workspaces and review states available to your account." surface="card">
        <form class="flex flex-wrap items-end gap-control-gap" onSubmit={(event) => { event.preventDefault(); if (text().trim()) props.onSearch(text().trim()); }}>
          <div class="min-w-64 flex-1"><TextInput label="Search memory" value={text()} placeholder="Find a fact, decision, or operational detail…" onInput={(event) => setText(event.currentTarget.value)} /></div>
          <Button size="lg" type="submit" variant="solid" theme="blue" iconLeft="lucide-search" disabled={!text().trim()}>Search</Button>
        </form>
        <Show when={props.state.data?.degraded}><Alert theme="amber" variant="outline" title="Memory is running in degraded mode" description="Results come from the local scoped store. Publish and revoke actions are unavailable until the knowledge service is healthy." /></Show>
        <div class="mt-4">
          <ScreenRegion state={props.state} skeleton="rows"
            emptyTitle={props.searched ? "No memory matches" : "Search your scoped knowledge"}
            emptyDescription={props.searched ? "Try a different query, or publish a reviewed candidate so it becomes searchable." : "Enter a search above to find scoped facts. Unverified and stale results stay clearly labelled."}
            emptyAction={props.searched ? <Button size="lg" onClick={props.onRefresh}>Run search again</Button> : undefined} onRetry={props.onRefresh}>
            <div class="grid gap-3">
              <For each={results()}>{(result) => <CardTile class="flex flex-col gap-4">
                <div class="flex flex-wrap items-center gap-2"><StatusBadge kind="knowledge" status={result.status} /><Badge variant="outline" theme="blue" label={result.classification} /><span class="text-caption text-ink-gray-6">v{result.sourceVersion} · updated <DateText value={result.updatedAt} /> · {result.provenance.length} sources</span></div>
                <p class="brain-readable whitespace-pre-wrap break-words text-interface text-ink-gray-8">{result.content}</p>
                <Show when={props.canPublish}><div class="flex flex-wrap gap-2 border-t border-outline-gray-1 pt-3">
                  <Button size="lg" variant="outline" iconLeft="lucide-upload" disabled={!canMutate()} onClick={() => setPublishOpenFor(result.sourceId)}>Publish under review…</Button>
                  <Button size="lg" variant="ghost" theme="red" iconLeft="lucide-trash-2" disabled={!canMutate()} onClick={() => setRevokeFor(result.sourceId)}>Revoke</Button>
                </div></Show>
              </CardTile>}</For>
            </div>
          </ScreenRegion>
        </div>
      </Section>
      <Section title="Trusted tool catalog" description="Declared in the active release. Effects, not descriptions, decide trust." surface="card">
        <DataTable title="Tools" selectable={false} hideSearch cardBreakpoint="lg" rows={props.tools.map((tool) => ({ id: tool.id, name: tool.id, status: tool.status, effect: tool.effectClass, release: shortDigest(tool.release.digest) }))} columns={[
          { id: "name", header: "Tool", accessorKey: "name", meta: { mobile: "title" } },
          { id: "status", header: "Status", accessorKey: "status", meta: { mobile: "status" } },
          { id: "effect", header: "Effect class", accessorKey: "effect", meta: { mobile: "meta" } },
          { id: "release", header: "Release digest", accessorKey: "release", meta: { mobile: "subtitle" } },
        ]} caption={count(props.tools.length, "declared tool")} />
      </Section>
      <Dialog.Root open={Boolean(publishing())} onOpenChange={(open) => { if (!open) setPublishOpenFor(undefined); }}><Dialog.Content>
        <Dialog.Header><Dialog.Title>Publish knowledge for review</Dialog.Title><Dialog.Description>Bind a real content artifact, independent reviewer, evidence, and a release-declared redaction profile.</Dialog.Description></Dialog.Header>
        <Show when={publishing()} keyed>{(result) => <div class="my-4 flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pe-1">
          <Alert theme="blue" variant="outline" title="Reviewed publication" description={`Candidate ${result.sourceId} · target scope ${result.scope}`} />
          <ArtifactSelector label="Content artifact" maxBytes={262144} onSelect={(artifact) => { setContentArtifactId(artifact.artifactId); setContentDigest(artifact.digest); setContentBytes(String(artifact.bytes)); }} />
          <Select label="Reviewer" value={reviewerId()} options={(members.state().data ?? []).filter((member) => !member.revoked && member.principalId !== app.identity()?.actor.actorId).map((member) => ({ value: member.principalId, label: member.principalId }))} onValueChange={(id) => setReviewerId(id ?? "")} />
          <Select label="Redaction policy" value={profileId()} options={(profiles.state().data ?? []).map((profile) => ({ value: profile.id, label: profile.id }))} onValueChange={(id) => { const profile = profiles.state().data?.find((entry) => entry.id === id); setProfileId(profile?.id ?? ""); setProfileDigest(profile?.digest ?? ""); }} />
          <EvidenceSelector onSelect={(digests) => setEvidenceText(digests.join(" "))} />
        </div>}</Show>
        <Dialog.Footer class="justify-end border-t border-outline-gray-1 pt-4"><Button size="lg" variant="outline" onClick={() => setPublishOpenFor(undefined)}>Cancel</Button><Button size="lg" variant="solid" theme="blue" disabled={!publishReady()} onClick={() => { const result = publishing(); if (!result) return; void props.onPublish({ candidateId: result.sourceId, sourceWorkspaceId: props.workspaceId, targetScope: result.scope,
          content: { artifactId: contentArtifactId().trim() || contentDigest().trim().slice(0, 12), digest: contentDigest().trim(), bytes: Number(contentBytes()), mediaType: "text/plain", classification: result.classification },
          evidenceDigests: evidenceDigests(), reviewerId: reviewerId().trim(), redactionProfile: { id: profileId().trim(), digest: profileDigest().trim() },
        }); setPublishOpenFor(undefined); }}>Publish for review</Button></Dialog.Footer>
      </Dialog.Content></Dialog.Root>
      <ReasonDialog open={Boolean(revokeFor())} onClose={() => { setRevokeFor(undefined); setRevokeReason(""); }}
        title="Revoke knowledge" description="Revocation is an explicit scoped command and requires a named reason."
        reason={revokeReason()} onReason={setRevokeReason} reasonLabel="Revocation reason" multiline={false} confirmLabel="Revoke knowledge" tone="red"
        onConfirm={(value) => { const sourceId = revokeFor(); if (sourceId) void props.onRevoke(sourceId, value); setRevokeFor(undefined); setRevokeReason(""); }} />
    </PageStack>
  </BrainPage>;
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
  const digests = (text: string) => text.split(/[\s,]+/u).map((digest) => digest.trim()).filter(Boolean);
  return <BrainPage title="Tool catalog" description="Inspect trusted capabilities and publish new tool releases only through reviewed evidence."
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={props.canPublish}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-plus" onClick={() => setProposeOpen(true)}>Propose tool</Button></Show></>}>
    <PageStack>
      <Section title="Trusted tools" description="Effect class is the trust boundary; privileged tools always run offline under a permit." surface="card">
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No tools declared" emptyDescription="Tools appear here once a release declares them or a proposal is accepted."
          emptyAction={props.canPublish ? <Button size="lg" onClick={() => setProposeOpen(true)}>Propose tool</Button> : undefined} onRetry={props.onRefresh}>
          <DataTable title="Tools" selectable={false} hideSearch cardBreakpoint="lg" rows={props.tools.map((tool) => ({ id: tool.id, name: tool.release.id, status: tool.status, effect: tool.effectClass, release: shortDigest(tool.release.digest) }))} columns={[
            { id: "name", header: "Tool", accessorKey: "name", meta: { mobile: "title" } },
            { id: "status", header: "Status", accessorKey: "status", meta: { mobile: "status" } },
            { id: "effect", header: "Effect class", accessorKey: "effect", meta: { mobile: "meta" } },
            { id: "release", header: "Release digest", accessorKey: "release", meta: { mobile: "subtitle" } },
          ]} caption={count(props.tools.length, "tool")} />
        </ScreenRegion>
      </Section>
      <Show when={props.canPublish}><Section title="Publish a reviewed release" description="Publishing requires the Rule of Three: independent evidence for the exact release." surface="card">
        <p class="mb-4 text-interface text-ink-gray-7">Select a reviewed candidate and bind its evidence in a focused publication step.</p><Button size="lg" variant="outline" iconLeft="lucide-upload" onClick={() => setPublishOpen(true)}>Publish reviewed release</Button>
      </Section></Show>
      <Dialog.Root open={proposeOpen()} onOpenChange={setProposeOpen}><Dialog.Content>
        <Dialog.Header><Dialog.Title>Propose a tool package</Dialog.Title><Dialog.Description>A proposal is a pinned package artifact plus evidence; review happens before any publish.</Dialog.Description></Dialog.Header>
        <div class="my-4 flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pe-1"><ArtifactSelector label="Tool package" onSelect={(artifact) => { setPackageArtifactId(artifact.artifactId); setPackageDigest(artifact.digest); setPackageBytes(String(artifact.bytes)); setPackageClassification(artifact.classification); }} /><EvidenceSelector onSelect={(selected) => setProposeEvidence(selected.join(" "))} /></div>
        <Dialog.Footer class="justify-end"><Button size="lg" variant="outline" onClick={() => setProposeOpen(false)}>Cancel</Button><Button size="lg" variant="solid" theme="blue" disabled={!packageDigest().trim() || Number(packageBytes()) <= 0 || digests(proposeEvidence()).length === 0} onClick={() => { void props.onPropose({ package: { artifactId: packageArtifactId(), digest: packageDigest().trim(), bytes: Number(packageBytes()), mediaType: "application/octet-stream", classification: packageClassification() }, evidence: digests(proposeEvidence()) }); setProposeOpen(false); }}>Submit proposal</Button></Dialog.Footer>
      </Dialog.Content></Dialog.Root>
      <Dialog.Root open={publishOpen()} onOpenChange={setPublishOpen}><Dialog.Content>
        <Dialog.Header><Dialog.Title>Publish reviewed tool release</Dialog.Title><Dialog.Description>Choose the exact candidate and bind the independent evidence required by the Rule of Three.</Dialog.Description></Dialog.Header>
        <div class="my-4 flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pe-1"><Select label="Reviewed tool candidate" value={releaseId()} options={props.candidates.map((candidate) => ({ value: candidate.release.id, label: `${candidate.release.id} · ${candidate.state}` }))} onValueChange={(id) => { const candidate = props.candidates.find((entry) => entry.release.id === id); setReleaseId(candidate?.release.id ?? ""); setReleaseDigest(candidate?.release.digest ?? ""); }} /><EvidenceSelector onSelect={(selected) => setPublishEvidence(selected.join(" "))} /></div>
        <Dialog.Footer class="justify-end"><Button size="lg" variant="outline" onClick={() => setPublishOpen(false)}>Cancel</Button><Button size="lg" variant="solid" theme="blue" disabled={!releaseId().trim() || !releaseDigest().trim() || digests(publishEvidence()).length === 0} onClick={() => { void props.onPublish({ id: releaseId().trim(), digest: releaseDigest().trim() }, digests(publishEvidence())); setPublishOpen(false); }}>Publish release</Button></Dialog.Footer>
      </Dialog.Content></Dialog.Root>
    </PageStack>
  </BrainPage>;
}
