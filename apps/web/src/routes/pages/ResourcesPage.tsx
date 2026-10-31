import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, Select } from "@talelk/newui-molecules";
import { Section } from "@talelk/newui-organisms";
import type { Document as BrainDocument, DocumentView, ResourceAssociation } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { ScreenRegion } from "../../ui/screen-region";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { RefreshButton, SelectableListItem } from "../../ui/components/primitives";

const MEDIA_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/pdf", "application/octet-stream"]);

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}

export default function ResourcesPage(): JSX.Element {
  const app = useApp();
  const [title, setTitle] = createSignal("");
  const [file, setFile] = createSignal<File | null>(null);
  const [revisionTitle, setRevisionTitle] = createSignal("");
  const [revisionFile, setRevisionFile] = createSignal<File | null>(null);
  const [selectedId, setSelectedId] = createSignal("");
  const [resourceKind, setResourceKind] = createSignal<ResourceAssociation["resourceKind"]>("workItem");
  const [resourceId, setResourceId] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [appliedSearch, setAppliedSearch] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const documents = createScopedRead<{ items: BrainDocument[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const response = await query<{ snapshot: { items: BrainDocument[] }; asOf: string; sourceWatermark: number }>({
        queryType: appliedSearch() ? "documents.search" : "documents.list", workspaceId: scope.workspaceId,
        ...(appliedSearch() ? { search: appliedSearch() } : {}),
      }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view.items.length === 0,
    refreshMs: 15_000,
  });
  const detail = createScopedRead<DocumentView | null>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!selectedId()) return { snapshot: null, asOf: new Date().toISOString(), sourceWatermark: 0 };
      const response = await query<{ snapshot: DocumentView; asOf: string; sourceWatermark: number }>({ queryType: "documents.get", workspaceId: scope.workspaceId, resourceId: selectedId() }, signal);
      return { snapshot: response.snapshot, asOf: response.asOf, sourceWatermark: response.sourceWatermark };
    },
    isEmpty: (view) => view === null,
  });

  async function refresh(selected?: string): Promise<void> {
    await documents.refresh({ force: true });
    if (selected) setSelectedId(selected);
    await detail.refresh({ force: true });
    const currentTitle = detail.state().data?.document.title;
    if (currentTitle) setRevisionTitle(currentTitle);
  }

  async function upload(): Promise<void> {
    const current = file();
    if (!current || busy()) return;
    setBusy(true); setError("");
    try {
      const mediaType = MEDIA_TYPES.has(current.type) ? current.type : "application/octet-stream";
      const created = await app.run("document.upload", { title: title().trim(), fileName: current.name, mediaType, bytesBase64: await base64(current) });
      if (!created.accepted || !created.resourceId) throw new Error(created.detail);
      setTitle(""); setFile(null);
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Document file"]');
      if (input) input.value = "";
      await refresh(created.resourceId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Document upload failed"); }
    finally { setBusy(false); }
  }

  async function revise(): Promise<void> {
    const current = revisionFile();
    const existing = detail.state().data;
    if (!current || !existing || busy()) return;
    setBusy(true); setError("");
    try {
      const mediaType = MEDIA_TYPES.has(current.type) ? current.type : "application/octet-stream";
      const revised = await app.run("document.revise", {
        documentId: existing.document.documentId, title: revisionTitle().trim(), fileName: current.name, mediaType,
        bytesBase64: await base64(current),
      }, { expectedVersion: existing.document.version });
      if (!revised.accepted) throw new Error(revised.detail);
      setRevisionFile(null);
      const input = document.querySelector<HTMLInputElement>('input[aria-label="New version file"]');
      if (input) input.value = "";
      await refresh(existing.document.documentId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Document revision failed"); }
    finally { setBusy(false); }
  }

  async function associate(): Promise<void> {
    const existing = detail.state().data;
    if (!existing || busy()) return;
    setBusy(true); setError("");
    try {
      const associated = await app.run("document.associate", { documentId: existing.document.documentId, resource: { kind: resourceKind(), id: resourceId().trim() } });
      if (!associated.accepted) throw new Error(associated.detail);
      setResourceId("");
      await refresh(existing.document.documentId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Document association failed"); }
    finally { setBusy(false); }
  }

  async function revoke(): Promise<void> {
    const existing = detail.state().data;
    if (!existing || busy()) return;
    setBusy(true); setError("");
    try {
      const revoked = await app.run("document.delete", { documentId: existing.document.documentId, reason: reason().trim() }, { expectedVersion: existing.document.version });
      if (!revoked.accepted) throw new Error(revoked.detail);
      setReason(""); setSelectedId("");
      await documents.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Document revocation failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title="Resources" description="Upload workspace documents, inspect safe previews and connect immutable versions to scoped work."
    actions={<RefreshButton onClick={() => void refresh(selectedId() || undefined)} label="Refresh" />}>
    <PageStack>
      <Show when={error()}><Alert theme="red" variant="outline" title="Document action failed" description={error()} /></Show>
      <Section title="Upload a document" description="Files remain workspace-private. Text is indexed locally; upload never publishes shared memory." surface="card">
        <div class="brain-field-grid">
          <TextInput label="Document title" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Operations guide" />
          <label class="flex flex-col gap-1 text-base-medium">Document file<input aria-label="Document file" class="rounded-control border border-outline-gray-2 p-2 text-base font-normal" type="file" accept=".txt,.md,.csv,.json,.pdf" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} /></label>
        </div>
        <Button size="lg" theme="blue" loading={busy()} disabled={busy() || !title().trim() || !file()} onClick={() => void upload()}>Upload document</Button>
      </Section>

      <Section title="Find resources" description="Search current titles and safely extracted text in this workspace only." surface="card">
        <form class="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search().trim()); void documents.refresh({ force: true }); }}>
          <div class="min-w-64 flex-1"><TextInput label="Search documents" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder=" incident checklist" /></div>
          <Button size="lg" type="submit" variant="outline">Search</Button>
          <Show when={appliedSearch()}><Button size="lg" variant="ghost" onClick={() => { setSearch(""); setAppliedSearch(""); void documents.refresh({ force: true }); }}>Clear</Button></Show>
        </form>
      </Section>

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Section title="Documents" surface="card">
          <ScreenRegion state={documents.state()} onRetry={() => void documents.refresh()} emptyTitle={appliedSearch() ? "No matching documents" : "No documents yet"} emptyDescription={appliedSearch() ? "Try a different current-title or content search." : "Upload the first workspace document above."}>
            <div class="flex flex-col gap-2"><For each={documents.state().data?.items}>{(item) => <SelectableListItem onClick={() => { setRevisionTitle(item.title); setSelectedId(item.documentId); void detail.refresh({ force: true }); }}>
              <strong>{item.title}</strong><span class="mt-1 block break-words text-caption text-ink-gray-6">record v{item.version} · {item.documentId}</span>
            </SelectableListItem>}</For></div>
          </ScreenRegion>
        </Section>
        <Section title="Document detail" description="The preview always reflects the current immutable version." surface="card">
          <Show when={selectedId()} fallback={<p class="text-ink-gray-7">Select a document to inspect its preview, versions and associations.</p>}>
            <ScreenRegion state={detail.state()} onRetry={() => void detail.refresh()} emptyTitle="No document selected" emptyDescription="Choose an active document from the list.">
              <Show when={detail.state().data} keyed>{(current) => <div class="flex flex-col gap-4">
                <div class="flex flex-wrap items-center gap-2"><StatusBadge status={current.document.state} /><span class="text-caption text-ink-gray-6">record v{current.document.version} · {current.versions.length} immutable versions</span></div>
                <Show when={current.preview.kind === "text"} fallback={<Alert theme="gray" variant="outline" title="Download-only preview" description="This binary media type is never rendered as active content. Its immutable bytes and metadata remain available to authorized members." />}>
                  <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-gray-1 p-3 text-caption text-ink-gray-8">{(current.preview as { text: string }).text}</pre>
                  <Show when={(current.preview as { truncated: boolean }).truncated}><p class="text-caption text-ink-gray-6">Preview truncated; extraction metadata still refers to the complete immutable file.</p></Show>
                </Show>

                <Section title="New version" description="Revision creates new bytes and a new version ID; previous versions remain unchanged." surface="inset">
                  <div class="brain-field-grid">
                    <TextInput label="Current title" value={revisionTitle()} onInput={(event) => setRevisionTitle(event.currentTarget.value)} />
                    <label class="flex flex-col gap-1 text-base-medium">New version file<input aria-label="New version file" class="rounded-control border border-outline-gray-2 p-2 text-base font-normal" type="file" accept=".txt,.md,.csv,.json,.pdf" onChange={(event) => setRevisionFile(event.currentTarget.files?.[0] ?? null)} /></label>
                  </div>
                  <Button size="lg" theme="blue" loading={busy()} disabled={busy() || !revisionTitle().trim() || !revisionFile()} onClick={() => void revise()}>Create new version</Button>
                </Section>

                <Section title="Version history" surface="inset">
                  <ul class="flex flex-col gap-2"><For each={current.versions}>{(version) => <li class="break-words text-caption text-ink-gray-7">
                    <Badge theme={version.documentVersionId === current.document.currentVersionId ? "blue" : "gray"} label={`v${version.revision}`} /> {version.fileName} · {version.mediaType} · {version.bytes} bytes · {version.extractionStatus}<br /><span class="text-ink-gray-6">{version.digest} · {version.documentVersionId}</span>
                  </li>}</For></ul>
                </Section>

                <Section title="Associations" description="Targets must exist in this same workspace." surface="inset">
                  <div class="brain-field-grid">
                    <Select label="Resource kind" value={resourceKind()} options={[{ value: "workItem", label: "Work item" }, { value: "objective", label: "Objective" }, { value: "session", label: "Session" }, { value: "run", label: "Run" }]} onValueChange={(value) => setResourceKind((value ?? "workItem") as ResourceAssociation["resourceKind"])} />
                    <TextInput label="Resource id" value={resourceId()} onInput={(event) => setResourceId(event.currentTarget.value)} placeholder="work item id" />
                  </div>
                  <Button size="lg" variant="outline" disabled={busy() || !resourceId().trim()} onClick={() => void associate()}>Associate document</Button>
                  <ul class="mt-3 flex flex-col gap-1 text-caption text-ink-gray-7"><For each={current.associations}>{(association) => <li>{association.resourceKind} · {association.resourceId}</li>}</For></ul>
                </Section>

                <Section title="Revoke document" description="Revocation removes the document from current lists and search while preserving immutable history." surface="inset">
                  <TextInput label="Revocation reason" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} placeholder="No longer approved for current work" />
                  <Button size="lg" theme="red" variant="outline" disabled={busy() || !reason().trim()} onClick={() => void revoke()}>Revoke document</Button>
                </Section>
              </div>}</Show>
            </ScreenRegion>
          </Show>
        </Section>
      </div>
    </PageStack>
  </BrainPage>;
}
