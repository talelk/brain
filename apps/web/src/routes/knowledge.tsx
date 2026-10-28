import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, Textarea, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { DataTable, Section } from "@talelk/newui-organisms";
import type { Classification, MemoryResult, MemoryScope, ToolCatalogEntry } from "@brain/contracts";
import { ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { DateText } from "../ui/screen-region";
import { count, shortDigest } from "../ui/format";

/** The exact reviewed publication the Governor validates (T39). */
export interface MemoryPublicationInput {
  candidateId: string;
  sourceWorkspaceId: string;
  targetScope: MemoryScope;
  content: { artifactId: string; digest: string; bytes: number; mediaType: string; classification: Classification };
  evidenceDigests: string[];
  reviewerId: string;
  redactionProfile: { id: string; digest: string };
}

/**
 * Knowledge (document 21): a scoped search over facts, plus the reviewed
 * publication path. Publication is an explicit command binding a real content
 * artifact, evidence, a different reviewer and a release-declared redaction
 * profile — never an edit of a list row.
 */
export function KnowledgeScreen(props: {
  workspaceId: string;
  tools: ToolCatalogEntry[];
  state: ScreenState<{ results: MemoryResult[]; degraded: boolean; tools: ToolCatalogEntry[] }>;
  /** True once a search was submitted; before that, "no matches" is a lie. */
  searched: boolean;
  onRefresh: () => void;
  onSearch: (text: string) => void;
  onPublish: (publication: MemoryPublicationInput) => Promise<void>;
  onRevoke: (sourceId: string, reason: string) => Promise<void>;
  canPublish: boolean;
}): JSX.Element {
  const [text, setText] = createSignal("");
  const [revokeReason, setRevokeReason] = createSignal("");
  const [publishOpenFor, setPublishOpenFor] = createSignal<string>();
  const [contentDigest, setContentDigest] = createSignal("");
  const [contentBytes, setContentBytes] = createSignal("");
  const [contentArtifactId, setContentArtifactId] = createSignal("");
  const [reviewerId, setReviewerId] = createSignal("");
  const [profileId, setProfileId] = createSignal("");
  const [profileDigest, setProfileDigest] = createSignal("");
  const [evidenceText, setEvidenceText] = createSignal("");
  const results = () => props.state.data?.results ?? [];
  const evidenceDigests = () => evidenceText().split(/[\s,]+/u).map((d) => d.trim()).filter(Boolean);
  const publishReady = () =>
    contentDigest().trim().length > 0 && Number(contentBytes()) > 0 &&
    reviewerId().trim().length > 0 && profileId().trim().length > 0 &&
    profileDigest().trim().length > 0 && evidenceDigests().length > 0 && publishOpenFor() !== undefined;

  return (
    <div class="flex flex-col gap-field-gap">
      <Section title="Scoped memory search" description="Results are scoped to this workspace and its review state; unverified rows stay labelled." surface="card"
        toolbar={
          <div class="flex flex-wrap items-end gap-control-gap">
            <div class="min-w-64 flex-1"><TextInput label="Search memory" value={text()} onInput={(e) => setText(e.currentTarget.value)} /></div>
            <Button onClick={() => props.onSearch(text().trim())} disabled={text().trim().length === 0} class="min-h-11">Search</Button>
          </div>
        }>
        <Show when={props.state.data?.degraded}>
          <Alert theme="amber" variant="outline" title="Memory is running in degraded mode"
            description="Results come from the local scoped store. Publish or revoke actions are blocked until the knowledge service is healthy." />
        </Show>
        <ScreenRegion state={props.state} skeleton="rows"
          emptyTitle={props.searched ? "No memory matches" : "Nothing searched yet"}
          emptyDescription={props.searched
            ? "Try a narrower query, or publish a reviewed candidate so it becomes searchable."
            : "Search above to find scoped facts for this workspace; unverified rows stay labelled."}
          emptyAction={props.searched ? <Button onClick={props.onRefresh}>Run search again</Button> : undefined}
          onRetry={props.onRefresh}>
          <For each={results()}>{(result) => (
            <article class="flex flex-col gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
              <div class="flex flex-wrap items-center gap-control-gap">
                <Badge theme={result.status === "reviewed" ? "green" : result.status === "stale" ? "amber" : "gray"} label={result.status} />
                <Badge theme="blue" label={result.classification} />
                <span class="text-caption text-ink-gray-7">v{result.sourceVersion} · updated <DateText value={result.updatedAt} /> · from {result.provenance.length} sources</span>
              </div>
              <p class="whitespace-pre-wrap break-words text-base text-ink-gray-8">{result.content}</p>
              <Show when={props.canPublish}>
                <Show when={publishOpenFor() !== result.sourceId} fallback={
                  <div class="flex flex-col gap-control-gap rounded-card border border-outline-gray-2 p-card-pad">
                    <p class="text-caption text-ink-gray-7">
                      Publication binds a real content artifact in CAS, evidence artifacts, a reviewer other than you,
                      and a redaction profile declared in the active release.
                    </p>
                    <div class="flex flex-wrap items-end gap-control-gap">
                      <div class="min-w-56"><TextInput label="Content artifact id" value={contentArtifactId()} onInput={(e) => setContentArtifactId(e.currentTarget.value)} /></div>
                      <div class="min-w-64 flex-1"><TextInput label="Content digest (sha256)" value={contentDigest()} onInput={(e) => setContentDigest(e.currentTarget.value)} /></div>
                      <div class="min-w-32"><TextInput label="Content bytes" type="number" value={contentBytes()} onInput={(e) => setContentBytes(e.currentTarget.value)} /></div>
                    </div>
                    <div class="flex flex-wrap items-end gap-control-gap">
                      <div class="min-w-56"><TextInput label="Reviewer principal id" value={reviewerId()} description="Must differ from your account." onInput={(e) => setReviewerId(e.currentTarget.value)} /></div>
                      <div class="min-w-40"><TextInput label="Redaction profile id" value={profileId()} onInput={(e) => setProfileId(e.currentTarget.value)} /></div>
                      <div class="min-w-64 flex-1"><TextInput label="Redaction profile digest" value={profileDigest()} onInput={(e) => setProfileDigest(e.currentTarget.value)} /></div>
                    </div>
                    <Textarea label="Evidence digests (whitespace separated)" value={evidenceText()} onInput={(e) => setEvidenceText(e.currentTarget.value)} />
                    <div class="flex flex-wrap gap-control-gap">
                      <Button disabled={!publishReady()} class="min-h-11" onClick={() => {
                        const targetScope: MemoryScope = result.scope;
                        void props.onPublish({
                          candidateId: result.sourceId,
                          sourceWorkspaceId: props.workspaceId,
                          targetScope,
                          content: {
                            artifactId: contentArtifactId().trim() || contentDigest().trim().slice(0, 12),
                            digest: contentDigest().trim(), bytes: Number(contentBytes()),
                            mediaType: "text/plain", classification: result.classification,
                          },
                          evidenceDigests: evidenceDigests(),
                          reviewerId: reviewerId().trim(),
                          redactionProfile: { id: profileId().trim(), digest: profileDigest().trim() },
                        });
                        setPublishOpenFor(undefined);
                      }}>Publish for review</Button>
                      <Button variant="outline" class="min-h-11" onClick={() => setPublishOpenFor(undefined)}>Cancel</Button>
                    </div>
                  </div>
                }>
                  <Button onClick={() => setPublishOpenFor(result.sourceId)} class="min-h-11">Publish under review…</Button>
                </Show>
                <div class="flex flex-wrap items-end gap-control-gap">
                  <div class="min-w-64 flex-1"><TextInput label="Revocation reason" value={revokeReason()} onInput={(e) => setRevokeReason(e.currentTarget.value)} /></div>
                  <Button variant="outline" theme="red" disabled={revokeReason().trim().length === 0} onClick={() => void props.onRevoke(result.sourceId, revokeReason().trim())} class="min-h-11">Revoke</Button>
                </div>
              </Show>
            </article>
          )}</For>
        </ScreenRegion>
      </Section>

      <Section title="Trusted tool catalog" description="Declared in the active release. Effects, not descriptions, decide trust." surface="card">
        <DataTable title="Tools" selectable={false} rows={props.tools.map((tool) => ({
          id: tool.id, name: tool.id, status: tool.status, effect: tool.effectClass, release: shortDigest(tool.release.digest),
        }))} columns={[
          { id: "name", header: "Tool", accessorKey: "name" },
          { id: "status", header: "Status", accessorKey: "status" },
          { id: "effect", header: "Effect class", accessorKey: "effect" },
          { id: "release", header: "Release digest", accessorKey: "release" },
        ]} caption={count(props.tools.length, "declared tool")} />
      </Section>
    </div>
  );
}

/** The Rule-of-Three tool candidate a proposal binds. */
export interface ToolProposalInput {
  package: { artifactId: string; digest: string; bytes: number; mediaType: string; classification: Classification };
  evidence: string[];
}

/**
 * The tool catalog (/tools): every declared tool with its release pin, plus the
 * propose/publish path. A candidate becomes trusted only through reviewed
 * evidence — the Rule of Three — never by editing this list.
 */
export function ToolsScreen(props: {
  tools: ToolCatalogEntry[];
  state: ScreenState<ToolCatalogEntry[]>;
  onRefresh: () => void;
  canPublish: boolean;
  onPropose: (proposal: ToolProposalInput) => Promise<void>;
  onPublish: (release: { id: string; digest: string }, evidence: string[]) => Promise<void>;
}): JSX.Element {
  const [proposeOpen, setProposeOpen] = createSignal(false);
  const [packageDigest, setPackageDigest] = createSignal("");
  const [packageBytes, setPackageBytes] = createSignal("");
  const [packageClassification, setPackageClassification] = createSignal<Classification>("internal");
  const [proposeEvidence, setProposeEvidence] = createSignal("");
  const [releaseId, setReleaseId] = createSignal("");
  const [releaseDigest, setReleaseDigest] = createSignal("");
  const [publishEvidence, setPublishEvidence] = createSignal("");
  const digests = (text: string) => text.split(/[\s,]+/u).map((d) => d.trim()).filter(Boolean);

  return (
    <div class="flex flex-col gap-field-gap">
      <Section title="Tool catalog" description="Effect class is the trust boundary: privileged tools always run offline under a permit." surface="card"
        actions={props.canPublish ? <Button onClick={() => setProposeOpen(true)} class="min-h-11">Propose tool</Button> : undefined}>
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No tools declared"
          emptyDescription="Tools appear here once a release declares them or a proposal is accepted."
          emptyAction={props.canPublish ? <Button onClick={() => setProposeOpen(true)}>Propose tool</Button> : undefined}
          onRetry={props.onRefresh}>
          <DataTable title="Tools" selectable={false} rows={props.tools.map((tool) => ({
            id: tool.id, name: tool.release.id, status: tool.status, effect: tool.effectClass, release: shortDigest(tool.release.digest),
          }))} columns={[
            { id: "name", header: "Tool", accessorKey: "name" },
            { id: "status", header: "Status", accessorKey: "status" },
            { id: "effect", header: "Effect class", accessorKey: "effect" },
            { id: "release", header: "Release digest", accessorKey: "release" },
          ]} caption={count(props.tools.length, "tool")} />
        </ScreenRegion>
      </Section>

      <Show when={props.canPublish}>
        <Section title="Publish a reviewed tool release" description="Publishing requires the Rule of Three: three independent evidence digests for the exact release." surface="card">
          <div class="flex flex-wrap items-end gap-control-gap">
            <div class="min-w-40"><TextInput label="Release id" value={releaseId()} onInput={(e) => setReleaseId(e.currentTarget.value)} /></div>
            <div class="min-w-64 flex-1"><TextInput label="Release digest" value={releaseDigest()} onInput={(e) => setReleaseDigest(e.currentTarget.value)} /></div>
            <div class="min-w-64 flex-1"><TextInput label="Evidence digests" value={publishEvidence()} description="Whitespace or comma separated." onInput={(e) => setPublishEvidence(e.currentTarget.value)} /></div>
            <Button disabled={!releaseId().trim() || !releaseDigest().trim() || digests(publishEvidence()).length === 0} class="min-h-11"
              onClick={() => void props.onPublish({ id: releaseId().trim(), digest: releaseDigest().trim() }, digests(publishEvidence()))}>
              Publish release
            </Button>
          </div>
        </Section>
      </Show>

      <Show when={proposeOpen()}>
        <Section title="Propose a tool package" description="A proposal is a pinned package artifact plus evidence; review happens before any publish." surface="card">
          <div class="flex flex-wrap items-end gap-control-gap">
            <div class="min-w-64 flex-1"><TextInput label="Package digest (sha256)" value={packageDigest()} onInput={(e) => setPackageDigest(e.currentTarget.value)} /></div>
            <div class="min-w-32"><TextInput label="Package bytes" type="number" value={packageBytes()} onInput={(e) => setPackageBytes(e.currentTarget.value)} /></div>
            <div class="min-w-40">
              <Select label="Classification" value={packageClassification()} options={[
                { value: "public", label: "Public" }, { value: "internal", label: "Internal" },
                { value: "confidential", label: "Confidential" }, { value: "restricted", label: "Restricted" },
              ]} onValueChange={(v) => setPackageClassification((v ?? "internal") as Classification)} />
            </div>
          </div>
          <div class="flex flex-wrap items-end gap-control-gap pt-field">
            <div class="min-w-64 flex-1"><TextInput label="Evidence digests" value={proposeEvidence()} description="Whitespace or comma separated." onInput={(e) => setProposeEvidence(e.currentTarget.value)} /></div>
            <Button disabled={!packageDigest().trim() || Number(packageBytes()) <= 0 || digests(proposeEvidence()).length === 0} class="min-h-11"
              onClick={() => {
                void props.onPropose({
                  package: {
                    artifactId: packageDigest().trim().slice(0, 12), digest: packageDigest().trim(),
                    bytes: Number(packageBytes()), mediaType: "application/octet-stream",
                    classification: packageClassification(),
                  },
                  evidence: digests(proposeEvidence()),
                });
                setProposeOpen(false);
              }}>
              Submit proposal
            </Button>
            <Button variant="outline" class="min-h-11" onClick={() => setProposeOpen(false)}>Cancel</Button>
          </div>
        </Section>
      </Show>
    </div>
  );
}
