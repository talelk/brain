import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge, Button, TextInput } from "@talelk/newui-atoms";
import { Alert, FileUploader, Pagination, Select } from "@talelk/newui-molecules";
import { PaneLayout } from "@talelk/newui-templates";
import type { Document as BrainDocument, DocumentView, ResourceAssociation } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { DateText, ScreenRegion } from "../../ui/screen-region";
import { FormSheet } from "../../ui/components/BrainForm";
import { BrainPage, PageStack, TechnicalDetails } from "../../ui/components/PageLayout";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { RefreshButton, SelectableListItem } from "../../ui/components/primitives";
import { EmptyPreview, FactStrip, WorkspaceSection } from "../../ui/components/Domain";

const MEDIA_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/pdf", "application/octet-stream"]);
const LIBRARY_PAGE_SIZE = 25;

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
  const [libraryPage, setLibraryPage] = createSignal(1);
  type SheetKind = "" | "upload" | "revise" | "associate" | "revoke";
  const [sheet, setSheet] = createSignal<SheetKind>("");
  const [attempted, setAttempted] = createSignal(false);
  const open = (kind: SheetKind) => { setError(""); setAttempted(false); setSheet(kind); };
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const libraryItems = () => documents.state().data?.items ?? [];
  const libraryPageCount = () => Math.max(1, Math.ceil(libraryItems().length / LIBRARY_PAGE_SIZE));
  const currentLibraryPage = () => Math.min(libraryPage(), libraryPageCount());
  const libraryRows = () => libraryItems().slice((currentLibraryPage() - 1) * LIBRARY_PAGE_SIZE, currentLibraryPage() * LIBRARY_PAGE_SIZE);

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
    setAttempted(true);
    if (!current || !title().trim() || busy()) return;
    setBusy(true); setError("");
    try {
      const mediaType = MEDIA_TYPES.has(current.type) ? current.type : "application/octet-stream";
      const created = await app.run("document.upload", { title: title().trim(), fileName: current.name, mediaType, bytesBase64: await base64(current) });
      if (!created.accepted || !created.resourceId) throw new Error(created.detail);
      setTitle(""); setFile(null); setSheet("");
      await refresh(created.resourceId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Document upload failed"); }
    finally { setBusy(false); }
  }

  async function revise(): Promise<void> {
    const current = revisionFile();
    const existing = detail.state().data;
    setAttempted(true);
    if (!current || !existing || !revisionTitle().trim() || busy()) return;
    setBusy(true); setError("");
    try {
      const mediaType = MEDIA_TYPES.has(current.type) ? current.type : "application/octet-stream";
      const revised = await app.run("document.revise", {
        documentId: existing.document.documentId, title: revisionTitle().trim(), fileName: current.name, mediaType,
        bytesBase64: await base64(current),
      }, { expectedVersion: existing.document.version });
      if (!revised.accepted) throw new Error(revised.detail);
      setRevisionFile(null); setSheet("");
      await refresh(existing.document.documentId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Document revision failed"); }
    finally { setBusy(false); }
  }

  async function associate(): Promise<void> {
    const existing = detail.state().data;
    setAttempted(true);
    if (!existing || !resourceId().trim() || busy()) return;
    setBusy(true); setError("");
    try {
      const associated = await app.run("document.associate", { documentId: existing.document.documentId, resource: { kind: resourceKind(), id: resourceId().trim() } });
      if (!associated.accepted) throw new Error(associated.detail);
      setResourceId(""); setSheet("");
      await refresh(existing.document.documentId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Document association failed"); }
    finally { setBusy(false); }
  }

  async function revoke(): Promise<void> {
    const existing = detail.state().data;
    setAttempted(true);
    if (!existing || !reason().trim() || busy()) return;
    setBusy(true); setError("");
    try {
      const revoked = await app.run("document.delete", { documentId: existing.document.documentId, reason: reason().trim() }, { expectedVersion: existing.document.version });
      if (!revoked.accepted) throw new Error(revoked.detail);
      setReason(""); setSelectedId(""); setSheet("");
      await documents.refresh({ force: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Document revocation failed"); }
    finally { setBusy(false); }
  }

  return <BrainPage title="Resources" description="Keep workspace-private source material searchable, previewable and connected to the work that uses it."
    actions={<><RefreshButton onClick={() => void refresh(selectedId() || undefined)} label="Refresh" /><Button size="md" theme="blue" iconLeft="lucide-upload" onClick={() => open("upload")}>Add document</Button></>}>
    <PageStack>
      <FormSheet open={sheet() === "upload"} onClose={() => setSheet("")} title="Add source material" description="Use operational guides, incident notes and reference documents. Upload never publishes shared memory or crosses workspace scope."
        submit="Upload document" icon="lucide-upload" busy={busy()} onSubmit={upload} error={error()} errorTitle="Document upload failed">
        <TextInput label="Document title" required value={title()} onInput={(event) => setTitle(event.currentTarget.value)} error={attempted() && !title().trim() ? "Give the document a title." : undefined} placeholder="Operations guide" />
        <FileUploader label="Document file" value={file()} accept={[".txt", ".md", ".csv", ".json", ".pdf"]} onValueChange={(value) => setFile(value instanceof File ? value : null)} />
        <Show when={attempted() && !file()}><p role="alert" class="text-caption text-ink-red-8">Choose a file to upload.</p></Show>
        <Show when={busy()}><p role="status" class="text-caption text-ink-gray-6">Validating and uploading the selected immutable version…</p></Show>
      </FormSheet>
      <FactStrip label="Resource library summary" items={[
        { label: "Documents", value: String(documents.state().data?.items.length ?? 0), hint: appliedSearch() ? "Matching the current scoped search" : "Current workspace documents", icon: "lucide-files" },
        { label: "Scope", value: "Workspace private", hint: app.workspaceId(), icon: "lucide-lock-keyhole" },
        { label: "Selection", value: selectedId() ? "Document open" : "None", hint: "Preview reflects one immutable current version", icon: "lucide-file-search" },
      ]} />
      <form class="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); setSelectedId(""); setLibraryPage(1); setAppliedSearch(search().trim()); void documents.refresh({ force: true }); }}>
        <div class="min-w-64 flex-1"><TextInput label="Search documents" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Search titles and safely extracted text…" /></div><Button size="md" type="submit" variant="outline">Search</Button><Show when={appliedSearch()}><Button size="md" variant="ghost" onClick={() => { setSearch(""); setAppliedSearch(""); setLibraryPage(1); void documents.refresh({ force: true }); }}>Clear</Button></Show>
      </form>
      <PaneLayout class="brain-list-detail" startSize={34} minStartSize={25} maxStartSize={52} active={selectedId() ? "end" : "start"} start={<WorkspaceSection title="Document library" description="Select a document for its safe preview and provenance.">
        <ScreenRegion state={documents.state()} onRetry={() => void documents.refresh()} emptyTitle={appliedSearch() ? "No matching documents" : "No documents yet"} emptyDescription={appliedSearch() ? "Try a different current-title or content search." : "Upload the first workspace document above."}>
          <div class="flex flex-col gap-2"><For each={libraryRows()}>{(item) => <SelectableListItem selected={selectedId() === item.documentId} onClick={() => { setRevisionTitle(item.title); setSelectedId(item.documentId); void detail.refresh({ force: true }); }}>
            <strong class="block break-words">{item.title}</strong><span class="mt-1 block break-words text-caption text-ink-gray-6">Updated <DateText value={item.updatedAt} /> · record v{item.version}</span>
          </SelectableListItem>}</For></div>
          <Show when={libraryPageCount() > 1}><Pagination.Root aria-label="Document library pagination" class="mt-3 flex-wrap items-center justify-between gap-3 border-t border-outline-gray-1 pt-3" count={libraryItems().length} pageSize={LIBRARY_PAGE_SIZE} page={currentLibraryPage()} onPageChange={setLibraryPage}>
            <Pagination.Range />
            <div class="flex items-center gap-1"><Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger /></div>
          </Pagination.Root></Show>
        </ScreenRegion>
      </WorkspaceSection>} end={<WorkspaceSection title="Document preview" description="Scope, current bytes and immutable version history.">
        <Show when={selectedId()} fallback={<EmptyPreview icon="lucide-file-search" title="Select a document" description="Its safe preview, source metadata, versions and work associations will appear here." />}>
          <ScreenRegion state={detail.state()} onRetry={() => void detail.refresh()} emptyTitle="No document selected" emptyDescription="Choose an active document from the list.">
            <Show when={detail.state().data} keyed>{(current) => {
              const version = () => current.versions.find((entry) => entry.documentVersionId === current.document.currentVersionId);
              return <PageStack>
                <div class="flex flex-wrap items-center justify-between gap-2"><div class="flex flex-wrap items-center gap-2"><StatusBadge status={current.document.state} /><Badge variant="outline" theme="blue" label="Workspace private" /></div><div class="flex flex-wrap gap-2"><Button size="md" variant="outline" iconLeft="lucide-history" onClick={() => open("revise")}>New version</Button><Button size="md" variant="outline" theme="red" iconLeft="lucide-trash-2" onClick={() => open("revoke")}>Revoke</Button><Button size="md" variant="ghost" iconLeft="lucide-arrow-left" onClick={() => setSelectedId("")}>Back to library</Button></div></div>
                <dl class="grid gap-3 border-y border-outline-gray-1 py-3 sm:grid-cols-2 lg:grid-cols-4"><div><dt class="text-caption text-ink-gray-6">Source file</dt><dd class="mt-1 break-words text-interface">{version()?.fileName ?? "—"}</dd></div><div><dt class="text-caption text-ink-gray-6">Size</dt><dd class="mt-1 text-interface tabular-nums">{version()?.bytes.toLocaleString() ?? "—"} bytes</dd></div><div><dt class="text-caption text-ink-gray-6">Extraction</dt><dd class="mt-1 text-interface">{version()?.extractionStatus ?? "—"}</dd></div><div><dt class="text-caption text-ink-gray-6">Created by</dt><dd class="mt-1 break-words text-interface">{current.document.createdBy}</dd></div></dl>
                <Show when={current.preview.kind === "text"} fallback={<Alert theme="gray" variant="outline" title="Download-only preview" description="This binary media type is never rendered as active content. Its immutable bytes and metadata remain available to authorized members." />}>
                  <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-gray-1 p-3 text-interface text-ink-gray-8">{(current.preview as { text: string }).text}</pre><Show when={(current.preview as { truncated: boolean }).truncated}><p class="text-caption text-ink-gray-6">Preview truncated; extraction metadata still refers to the complete immutable file.</p></Show>
                </Show>
                <WorkspaceSection title="Work associations" description="Targets must exist in this same workspace." actions={<Button size="md" variant="outline" iconRight="lucide-link" onClick={() => open("associate")}>Associate work</Button>}><Show when={current.associations.length} fallback={<p class="text-interface text-ink-gray-6">Not associated with any work yet.</p>}><ul class="flex flex-col gap-1 break-words text-caption text-ink-gray-7"><For each={current.associations}>{(association) => <li class="break-all">{association.resourceKind} · {association.resourceId}</li>}</For></ul></Show></WorkspaceSection>
                <TechnicalDetails label={`Version history (${current.versions.length})`}><ul class="flex flex-col gap-3"><For each={current.versions}>{(entry) => <li class="break-words text-caption text-ink-gray-7"><Badge theme={entry.documentVersionId === current.document.currentVersionId ? "blue" : "gray"} label={`v${entry.revision}`} /> {entry.fileName} · {entry.mediaType} · {entry.bytes} bytes · {entry.extractionStatus}<br /><span class="text-ink-gray-6">{entry.digest} · {entry.documentVersionId}</span></li>}</For></ul></TechnicalDetails>
                <FormSheet open={sheet() === "revise"} onClose={() => setSheet("")} title="Create a new version" description="Revision creates new bytes and a new version ID; previous versions remain unchanged."
                  submit="Create new version" icon="lucide-history" busy={busy()} onSubmit={revise} error={error()} errorTitle="Document revision failed">
                  <TextInput label="Current title" required value={revisionTitle()} onInput={(event) => setRevisionTitle(event.currentTarget.value)} error={attempted() && !revisionTitle().trim() ? "Keep a title for the document." : undefined} />
                  <FileUploader label="New version file" value={revisionFile()} accept={[".txt", ".md", ".csv", ".json", ".pdf"]} onValueChange={(value) => setRevisionFile(value instanceof File ? value : null)} />
                  <Show when={attempted() && !revisionFile()}><p role="alert" class="text-caption text-ink-red-8">Choose the file for the new version.</p></Show>
                </FormSheet>
                <FormSheet open={sheet() === "associate"} onClose={() => setSheet("")} title="Associate with work" description="Targets must exist in this same workspace."
                  submit="Associate document" icon="lucide-link" busy={busy()} onSubmit={associate} error={error()} errorTitle="Document association failed">
                  <Select label="Resource kind" value={resourceKind()} options={[{ value: "workItem", label: "Work item" }, { value: "mission", label: "Mission" }, { value: "session", label: "Session" }, { value: "run", label: "Run" }]} onValueChange={(value) => setResourceKind((value ?? "workItem") as ResourceAssociation["resourceKind"])} />
                  <TextInput label="Resource id" required value={resourceId()} onInput={(event) => setResourceId(event.currentTarget.value)} error={attempted() && !resourceId().trim() ? "Enter the id of the target." : undefined} placeholder="work item id" />
                </FormSheet>
                <FormSheet open={sheet() === "revoke"} onClose={() => setSheet("")} title="Revoke document" description="Revocation removes current visibility while preserving immutable history."
                  submit="Revoke document" theme="red" busy={busy()} onSubmit={revoke} error={error()} errorTitle="Document revocation failed">
                  <TextInput label="Revocation reason" required value={reason()} onInput={(event) => setReason(event.currentTarget.value)} error={attempted() && !reason().trim() ? "A reason is required." : undefined} placeholder="No longer approved for current work" />
                </FormSheet>
              </PageStack>;
            }}</Show>
          </ScreenRegion>
        </Show>
      </WorkspaceSection>} />
    </PageStack>
  </BrainPage>;
}
